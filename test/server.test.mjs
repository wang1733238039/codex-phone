import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/config.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';
import { Store } from '../src/store.mjs';
import { listenForFetch } from './helpers/http.mjs';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-server-test-'));
  const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-pass'), agentToken: 'independent-test-token', controlsEnabled: true, ...options });
  const origin = await listenForFetch(app.server);
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  let cookie, csrf;
  const request = (path, body, extra = {}) => fetch(origin + path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' }), ...extra }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  async function login() { const res = await request('/api/login', { username: 'admin', password: 'test-pass' }); assert.equal(res.status, 200); cookie = res.headers.get('set-cookie').split(';')[0]; csrf = (await res.json()).csrf; return res; }
  async function connect() { const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: 'Bearer independent-test-token' } }); await once(ws, 'open'); return ws; }
  return { app, origin, request, login, connect };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out waiting for test condition'); }

test('project snapshot is searchable and survives disconnect and cache reopen', async t => {
  const f=await fixture(t); await f.login(); const ws=await f.connect();
  const id=randomUUID(), archivedId=randomUUID();
  const sidebar={version:1,projects:[{id:'p',name:'手动归属',expanded:true}],preferences:{grouping:{mode:'project'}}};
  ws.send(JSON.stringify({type:'snapshot',sidebar,threads:[{id,title:'one',cwd:'C:\\别处',projectId:'p',projectName:'手动归属',archived:false},{id:archivedId,title:'two',projectId:'p',projectName:'手动归属',archived:true}]}));
  await until(()=>f.app.store.list().length===2);
  const query='/api/threads?q='+encodeURIComponent('手动归属');
  let data=await (await f.request(query)).json();
  assert.deepEqual(data.groups[0].threadIds,[id]); assert.deepEqual(data.sidebar,sidebar);
  data=await (await f.request(query+'&archived=true')).json(); assert.deepEqual(data.groups[0].threadIds,[archivedId]);
  ws.close(); await until(()=>!f.app.status().online);
  data=await (await f.request(query)).json(); assert.equal(data.online,false); assert.deepEqual(data.sidebar,sidebar);
  const disk=new Store(f.app.store.db.location());
  try { assert.deepEqual(disk.sidebar(),sidebar); } finally { disk.close(); }
});

test('creating a thread is authenticated, capability gated, idempotent, persisted and scoped to the target', async t => {
  const f = await fixture(t), path = `/api/devices/${f.app.store.primaryDeviceId}/threads`;
  const requestId = randomUUID();
  assert.equal((await f.request(path, { requestId, title: '' })).status, 401);
  await f.login();
  assert.equal((await f.request(path, { requestId, title: '' })).status, 503);
  const ws = await f.connect(), id = randomUUID(); let count = 0;
  ws.send(JSON.stringify({ type: 'snapshot', threads: [], info: { version: '0.4.0', controls: true } }));
  await until(() => f.app.status().connectorVersion === '0.4.0');
  assert.equal((await f.request(path, { requestId, title: '' })).status, 409);
  ws.send(JSON.stringify({ type: 'snapshot', threads: [], info: { version: '0.5.0', controls: true, capabilities: { createThread: true } } }));
  await until(() => f.app.status().capabilities.createThread);
  ws.on('message', raw => { const message = JSON.parse(raw); if (message.type !== 'request') return;
    assert.equal(message.action, 'create-thread'); count++;
    ws.send(JSON.stringify({ type: 'response', id: message.id, data: { thread: { id, title: '新对话', local: true, archived: false } } }));
  });
  assert.equal((await f.request(path, { requestId, title: '' }, { 'X-CSRF-Token': 'bad' })).status, 403);
  const result = await (await f.request(path, { requestId, title: '新对话' })).json();
  assert.equal(result.state, 'accepted'); assert.equal(result.result.thread.id, id);
  const duplicate = await (await f.request(path, { requestId, title: '新对话' })).json();
  assert.equal(duplicate.duplicate, true); assert.equal(count, 1);
  assert.equal(f.app.store.thread(id).title, '新对话');
  assert.equal(f.app.store.detail(id).messages.length, 0);
  assert.equal((await f.request(`/api/devices/${randomUUID()}/threads`, { requestId, title: '' })).status, 404);
});

test('child creation and sends use their exact parent/device, are idempotent, and reject missing parents', async t => {
  const f = await fixture(t); await f.login(); const ws = await f.connect();
  const parentId = randomUUID(), id = randomUUID(), requestId = randomUUID(), calls = [];
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id: parentId, local: true, archived: false }], info: { controls: true, capabilities: { createThread: true, childControls: true } } }));
  await until(() => f.app.status().capabilities.childControls);
  ws.on('message', raw => {
    const msg = JSON.parse(raw); if (msg.type !== 'request') return; calls.push(msg);
    ws.send(JSON.stringify({ type: 'response', id: msg.id, data: msg.action === 'create-thread'
      ? { thread: { id, parentThreadId: parentId, rootThreadId: parentId, local: true, archived: false, readOnly: false } }
      : { delivery: 'started' } }));
  });
  const create = { requestId, parentThreadId: parentId, title: '子对话' };
  assert.equal((await f.request('/api/threads', { ...create, parentThreadId: randomUUID() })).status, 404);
  assert.equal((await f.request('/api/threads', { ...create, rootPath: 'C:\\other' })).status, 400);
  const result = await (await f.request('/api/threads', create)).json();
  assert.equal(result.state, 'accepted'); assert.equal(result.result.thread.parentThreadId, parentId);
  assert.equal((await (await f.request('/api/threads', create)).json()).duplicate, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].data.parentThreadId, parentId);
  const send = await f.request(`/api/threads/${id}/send`, { text: '继续检查', requestId: randomUUID() });
  assert.equal(send.status, 200); assert.equal(calls.at(-1).action, 'send'); assert.equal(calls.at(-1).data.threadId, id);
  assert.equal((await (await f.request('/api/threads')).json()).threads.length, 1);
});

test('login, session cookies, CSRF, host and origin checks', async t => {
  const f = await fixture(t);
  const stylesheet = await fetch(f.origin + '/conversation.css');
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /composer-settings-button/);
  assert.equal((await f.request('/api/threads')).status, 401);
  assert.equal((await f.request('/api/login', { username: 'admin', password: 'test-pass' }, { Origin: 'https://evil.example' })).status, 403);
  const badHost = await new Promise((resolve, reject) => { const req = http.get(f.origin + '/healthz', { headers: { Host: 'evil.example' } }, res => { resolve(res.statusCode); res.resume(); }); req.on('error', reject); });
  assert.equal(badHost, 403);
  const login = await f.login(); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.request('/api/logout', {}, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await f.request('/api/logout', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/logout', {})).status, 200);
  assert.equal((await f.request('/api/threads')).status, 401);
});

test('eight failed logins are rate limited', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.request('/api/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/login', { username: 'admin', password: 'test-pass' })).status, 429);
});

test('agent authentication rejects wrong token and browser-origin connections', async t => {
  const f = await fixture(t);
  for (const headers of [{ Authorization: 'Bearer wrong' }, { Authorization: 'Bearer independent-test-token', Origin: f.origin }]) {
    const code = await new Promise(resolve => { const ws = new WebSocket(f.origin.replace('http', 'ws') + '/agent', { headers }); ws.on('unexpected-response', (_, response) => { resolve(response.statusCode); response.resume(); ws.terminate(); }); ws.on('error', () => {}); });
    assert.equal(code, 401);
  }
});

test('Unicode list, pagination, cache, disconnected commands and idempotency', async t => {
  const f = await fixture(t); await f.login(); const ws = await f.connect();
  const id = randomUUID(), archivedId = randomUUID(); let sends = 0;
  const messages = Array.from({ length: 140 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: `中文消息 ${i}`, time: new Date().toISOString(), ...(i % 2 ? { phase: 'final_answer' } : {}) }));
  messages.splice(5, 0, { role: 'assistant', text: 'do not expose progress', phase: 'commentary' });
  ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.type !== 'request') return;
    if (msg.action === 'send') sends++;
    ws.send(JSON.stringify({ type: 'response', id: msg.id, data: msg.action === 'detail' ? { id, messages, running: false, transcriptVersion: TRANSCRIPT_VERSION } : { turnId: 'test-turn' } }));
  });
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id, title: '中文项目', preview: '手机测试', cwd: 'C:\\中文', updatedAt: Date.now(), archived: false, local: true }, { id: archivedId, title: '已归档', archived: true }], info: { computer: '测试电脑' }, activeTurns: [], approvals: [] }));
  await until(() => f.app.store.list().length === 2);
  const list = await (await f.request('/api/threads?q=' + encodeURIComponent('中文'))).json(); assert.equal(list.threads.length, 1); assert.equal(list.computer, '测试电脑');
  assert.equal((await (await f.request('/api/threads?archived=true')).json()).threads[0].id, archivedId);
  const detail = await (await f.request(`/api/threads/${id}?limit=80`)).json(); assert.equal(detail.messages.length, 80); assert.equal(detail.before, 60); assert.equal(detail.total, 140);
  const earlier = await (await f.request(`/api/threads/${id}?limit=80&before=60`)).json(); assert.equal(earlier.messages[59].text, '中文消息 59'); assert.equal(earlier.before, null);
  const requestId = randomUUID();
  const responses = await Promise.all([f.request(`/api/threads/${id}/send`, { requestId, text: 'test' }), f.request(`/api/threads/${id}/send`, { requestId, text: 'test' })]);
  assert.equal(responses[0].status, 200); assert.equal(responses[1].status, 200); assert.equal(sends, 1);
  assert.equal((await (await f.request(`/api/commands/${requestId}`)).json()).state, 'accepted');
  ws.close(); await until(() => !f.app.status().online);
  const cached = await (await f.request(`/api/threads/${id}`)).json(); assert.equal(cached.online, false); assert.equal(cached.fromCache, true); assert.equal(cached.messages.length, 15);
  assert.equal((await f.request(`/api/threads/${id}/send`, { requestId: randomUUID(), text: 'offline' })).status, 503);
  const duplicate = await (await f.request(`/api/threads/${id}/send`, { requestId, text: 'test' })).json(); assert.equal(duplicate.duplicate, true); assert.equal(sends, 1);
});

test('old unclassified cache is invalidated and refreshed before pagination', async t => {
  const f = await fixture(t); await f.login(); const id = randomUUID();
  f.app.store.snapshot([{ id, title: '升级缓存', archived: false }]);
  f.app.store.saveDetail(id, { id, messages: [{ role: 'user', text: 'internal context' }, { role: 'assistant', text: 'old progress' }] });
  assert.equal(f.app.store.detail(id), null);
  assert.equal((await f.request(`/api/threads/${id}`)).status, 503);
  const ws = await f.connect();
  ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.action === 'detail') ws.send(JSON.stringify({ type: 'response', id: msg.id,
    data: { id, transcriptVersion: TRANSCRIPT_VERSION, running: false, messages: [{ role: 'user', text: '我的输入' }, { role: 'assistant', text: '最终回复', phase: 'final_answer' }] } })); });
  const detail = await (await f.request(`/api/threads/${id}`)).json();
  assert.deepEqual(detail.messages.map(m => m.text), ['我的输入', '最终回复']);
  ws.close(); await until(() => !f.app.status().online);
  assert.equal((await (await f.request(`/api/threads/${id}`)).json()).messages.length, 2);
});

test('child families are separate from the sidebar, cached offline, and read-only on every control route', async t => {
  const f = await fixture(t); await f.login(); const ws = await f.connect();
  const rootId = randomUUID(), childId = randomUUID(), unrelated = randomUUID();
  const root = { id: rootId, title: '主对话', local: true, archived: false };
  const child = { id: childId, title: '子对话', parentThreadId: rootId, local: true, archived: false };
  let forwarded = 0;
  ws.on('message', raw => {
    const msg = JSON.parse(raw); if (msg.type !== 'request') return; forwarded++;
    assert.equal(msg.action, 'detail');
    ws.send(JSON.stringify({ type: 'response', id: msg.id, data: { id: childId, readOnly: true, transcriptVersion: TRANSCRIPT_VERSION, messages: [
      { role: 'assistant', phase: 'commentary', text: 'hidden progress' },
      { role: 'assistant', phase: 'final_answer', text: '子对话结果' },
    ] } }));
  });
  ws.send(JSON.stringify({ type: 'snapshot', threads: [root], childThreads: [child, { id: randomUUID(), parentThreadId: unrelated }],
    info: { controls: true }, activeTurns: [{ threadId: childId, turnId: 'turn' }], approvals: [{ id: 'child-approval', threadId: childId }] }));
  await until(() => f.app.store.thread(childId));
  const listing = await (await f.request('/api/threads')).json();
  assert.deepEqual(listing.threads.map(t => t.id), [rootId]); assert.equal(listing.total, 1); assert.equal(listing.threads[0].childCount, 1);
  const family = await (await f.request(`/api/threads/${childId}/family`)).json();
  assert.equal(family.rootId, rootId); assert.equal(family.threads.length, 2);
  assert.equal((await f.request(`/api/threads/${unrelated}/family`)).status, 404);
  const detail = await (await f.request(`/api/threads/${childId}`)).json();
  assert.deepEqual(detail.messages.map(m => m.text), ['子对话结果']);
  assert.equal(detail.thread.readOnly, true); assert.equal(forwarded, 1);
  for (const action of ['send', 'stop', 'queue-start', 'queue-delete']) {
    assert.equal((await f.request(`/api/threads/${childId}/${action}`, { text: 'test', requestId: randomUUID(), queueId: 'q' })).status, 403);
  }
  assert.equal((await f.request(`/api/threads/${childId}/attachments`, { name: 'test.txt', size: 1 })).status, 403);
  assert.equal((await f.request('/api/approve', { id: 'child-approval', decision: 'accept' })).status, 403);
  assert.equal(forwarded, 1);
  ws.close(); await until(() => !f.app.status().online);
  assert.equal((await (await f.request(`/api/threads/${childId}/family`)).json()).online, false);
  assert.equal((await (await f.request(`/api/threads/${childId}`)).json()).fromCache, true);
  assert.equal((await f.request(`/api/devices/${randomUUID()}/threads/${childId}/family`)).status, 404);
});

test('uncertain Codex response is recorded once and cannot be replayed', async t => {
  const f = await fixture(t); await f.login(); const ws = await f.connect(); const id = randomUUID(), requestId = randomUUID(); let sends = 0;
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id, archived: false }] })); await until(() => f.app.store.list().length);
  ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.action === 'send') { sends++; ws.send(JSON.stringify({ type: 'response', id: msg.id, error: 'turn/start timed out', uncertain: true })); } });
  assert.equal((await f.request(`/api/threads/${id}/send`, { requestId, text: 'test' })).status, 504);
  assert.equal((await (await f.request(`/api/commands/${requestId}`)).json()).state, 'unknown');
  await f.request(`/api/threads/${id}/send`, { requestId, text: 'test' }); assert.equal(sends, 1);
});

test('commands interrupted by relay restart reconcile from pending to unknown on device reconnect', async t => {
  const f = await fixture(t); await f.login();
  const id = randomUUID(), requestId = randomUUID();
  const ws = await f.connect();
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id, archived: false }] }));
  await until(() => f.app.store.list().length);
  f.app.store.beginCommand(f.app.store.primaryDeviceId, requestId, id);
  assert.equal((await (await f.request(`/api/commands/${requestId}`)).json()).state, 'pending');
  ws.close(); await until(() => !f.app.status().online);
  const reconnected = await f.connect();
  assert.equal((await (await f.request(`/api/commands/${requestId}`)).json()).state, 'unknown');
  reconnected.close();
});

test('a late accepted response repairs an unknown receipt without sending the message again', async t => {
  const f = await fixture(t, { commandTimeoutMs: 30 }); await f.login(); const ws = await f.connect();
  const id = randomUUID(), requestId = randomUUID(); let pending, sends = 0;
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id, archived: false }] })); await until(() => f.app.store.list().length);
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.action === 'send') { pending = m; sends++; } });
  assert.equal((await f.request(`/api/threads/${id}/send`, { requestId, text: 'test' })).status, 504);
  assert.equal((await (await f.request(`/api/commands/${requestId}`)).json()).state, 'unknown');
  ws.send(JSON.stringify({ type: 'response', id: pending.id, data: { queued: true, queueId: 'q' } }));
  await until(() => f.app.store.command(f.app.store.primaryDeviceId, requestId).state === 'accepted');
  assert.equal((await (await f.request(`/api/commands/${requestId}`)).json()).result.queueId, 'q');
  await f.request(`/api/threads/${id}/send`, { requestId, text: 'test' }); assert.equal(sends, 1);
});

test('model discovery and turn options are device scoped and preserve idempotency', async t => {
  const f = await fixture(t); await f.login(); const ws = await f.connect();
  const id = randomUUID(); let send;
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id, archived: false }], info: { controls: true, version: '0.3.0', capabilities: { models: true } } }));
  await until(() => f.app.store.list().length);
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type !== 'request') return;
    if (m.action === 'send') send = m.data;
    ws.send(JSON.stringify({ type: 'response', id: m.id, data: m.action === 'models' ? { models: [{ id: 'local', efforts: ['high'] }] } : { queued: true, queueId: 'next' } }));
  });
  const path = `/api/devices/${f.app.store.primaryDeviceId}`;
  assert.equal((await (await f.request(path + '/models')).json()).models[0].id, 'local');
  const requestId = randomUUID();
  assert.equal((await f.request(path + `/threads/${id}/send`, { requestId, text: 'next', model: 'local', effort: 'high', mode: 'auto' })).status, 200);
  assert.equal(send.model, 'local'); assert.equal(send.effort, 'high'); assert.equal(send.requestId, requestId);
  assert.equal((await f.request(path + `/threads/${id}/send`, { requestId: randomUUID(), text: 'bad', mode: 'invalid' })).status, 400);
});
