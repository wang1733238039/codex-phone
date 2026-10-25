import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createApp } from '../src/server.mjs';
import { Store, credentialHash } from '../src/store.mjs';
import { hashPassword } from '../src/config.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';

const until = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Test condition timed out'); };
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-devices-'));
  const app = createApp({ database: join(dir, 'cache.sqlite'), agentToken: 'primary-secret', username: 'admin', passwordHash: hashPassword('test-pass'), controlsEnabled: true });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(dir, { force: true, recursive: true }); });
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-pass' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
  const request = (path, data, headers = {}) => fetch(origin + path, { headers: { Cookie: cookie, ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...headers },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
  const claim = (code, name = '电脑 B') => fetch(origin + '/api/device-pairings/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
  async function pair() {
    const { code } = await (await request('/api/device-pairings', {})).json();
    const result = await claim(code); assert.equal(result.status, 201); return result.json();
  }
  async function connect(token = 'primary-secret', deviceId) {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${token}`, ...(deviceId ? { 'X-Device-Id': deviceId } : {}) } });
    await once(ws, 'open'); return ws;
  }
  return { app, origin, request, pair, claim, connect };
}
function snapshot(ws, id, name) {
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id, title: name, archived: false, local: true, projectId: 'p', projectName: name }],
    sidebar: { version: 1, projects: [{ id: 'p', name }] }, info: { computer: name }, activeTurns: [], approvals: [] }));
}

test('pairing is CSRF-protected, single-use and expiring; revocation cannot be undone by restart', async t => {
  const f = await fixture(t), primaryId = f.app.store.primaryDeviceId;
  assert.equal((await f.request('/api/device-pairings', {}, { 'X-CSRF-Token': 'bad' })).status, 403);
  const { code } = await (await f.request('/api/device-pairings', {})).json();
  const response = await f.claim(code); assert.equal(response.status, 201); const paired = await response.json();
  assert.notEqual(paired.deviceId, primaryId); assert.notEqual(paired.agentToken, 'primary-secret');
  assert.equal((await f.claim(code)).status, 400);
  f.app.store.pairing(credentialHash('AAAAAAAABBBB'), Date.now() - 1);
  assert.equal((await f.claim('AAAA-AAAA-BBBB')).status, 400);
  assert.equal(f.app.store.device(paired.deviceId).token_hash, credentialHash(paired.agentToken));
  assert.equal((await f.request(`/api/devices/${randomUUID()}/threads`)).status, 404);
  const ws = await f.connect(paired.agentToken, paired.deviceId);
  assert.equal((await f.request(`/api/devices/${paired.deviceId}/rename`, { name: '家里的电脑' })).status, 200);
  assert.equal(f.app.store.device(paired.deviceId).name, '家里的电脑');
  assert.equal((await f.request(`/api/devices/${paired.deviceId}/revoke`, {})).status, 200);
  await until(() => ws.readyState === WebSocket.CLOSED);
  assert.equal(f.app.store.authenticate(paired.agentToken), undefined);
  assert.equal((await f.request(`/api/devices/${paired.deviceId}/threads`)).status, 404);
  assert.equal((await f.request(`/api/devices/${primaryId}/revoke`, {})).status, 200);
  f.app.store.initializePrimary('primary-secret');
  assert.equal(f.app.store.authenticate('primary-secret'), undefined);
  const directory = await (await f.request('/api/devices')).json();
  assert.equal(directory.devices.length, 0); assert.doesNotMatch(JSON.stringify(directory), /token_hash|primary-secret|agentToken/);
});

test('two simultaneous computers keep identical thread IDs, histories and command IDs separate', async t => {
  const f = await fixture(t), paired = await f.pair(), aId = f.app.store.primaryDeviceId, bId = paired.deviceId;
  const a = await f.connect(), b = await f.connect(paired.agentToken, bId), threadId = randomUUID(), requestId = randomUUID();
  const counts = { A: 0, B: 0 };
  for (const [ws, name] of [[a, 'A'], [b, 'B']]) {
    ws.on('message', raw => {
      const message = JSON.parse(raw); if (message.type !== 'request') return;
      if (message.action === 'send') counts[name]++;
      ws.send(JSON.stringify({ type: 'response', id: message.id, data: message.action === 'detail'
        ? { id: threadId, running: false, transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', text: name }, { role: 'assistant', phase: 'final_answer', text: `${name}回复` }, { role: 'tool', text: 'secret tool' }] }
        : { turnId: name } }));
    });
    snapshot(ws, threadId, name);
  }
  await until(() => f.app.store.list(aId).length && f.app.store.list(bId).length);
  const path = id => `/api/devices/${id}`;
  for (const [deviceId, name] of [[aId, 'A'], [bId, 'B']]) {
    const listing = await (await f.request(path(deviceId) + '/threads')).json(); assert.equal(listing.threads[0].title, name);
    const detail = await (await f.request(path(deviceId) + `/threads/${threadId}`)).json();
    assert.deepEqual(detail.messages.map(m => m.text), [name, `${name}回复`]);
    assert.equal((await f.request(path(deviceId) + `/threads/${threadId}/send`, { requestId, text: name })).status, 200);
    assert.equal((await (await f.request(path(deviceId) + `/commands/${requestId}`)).json()).result.turnId, name);
  }
  await f.request(path(bId) + `/threads/${threadId}/send`, { requestId, text: 'retry' });
  assert.deepEqual(counts, { A: 1, B: 1 });
  snapshot(a, threadId, 'A changed'); await until(() => f.app.store.list(aId)[0]?.title === 'A changed');
  assert.equal(f.app.store.list(bId)[0].title, 'B');
  const legacy = await (await f.request('/api/threads')).json(); assert.equal(legacy.deviceId, aId);
  a.close(); await until(() => !f.app.status(aId).online);
  assert.equal(f.app.status(bId).online, true);
  assert.equal((await f.request(path(aId) + `/threads/${threadId}/send`, { requestId: randomUUID(), text: 'offline' })).status, 503);
  assert.equal((await (await f.request(path(aId) + `/threads/${threadId}`)).json()).fromCache, true);
  assert.equal(f.app.store.detail(threadId, bId).messages[0].text, 'B');
});

test('a different device cannot answer an outstanding request; disconnect only rejects its own requests', async t => {
  const f = await fixture(t), paired = await f.pair(), aId = f.app.store.primaryDeviceId, bId = paired.deviceId;
  const a = await f.connect(), b = await f.connect(paired.agentToken), id = randomUUID();
  snapshot(a, id, 'A'); snapshot(b, id, 'B');
  await until(() => f.app.store.list(aId).length && f.app.store.list(bId).length);
  let aRequest, bRequest;
  a.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'request') aRequest = m; });
  b.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'request') bRequest = m; });
  const aResponse = f.request(`/api/devices/${aId}/threads/${id}?refresh=1`);
  const bResponse = f.request(`/api/devices/${bId}/threads/${id}?refresh=1`);
  await until(() => aRequest && bRequest);
  b.send(JSON.stringify({ type: 'response', id: aRequest.id, data: { id, transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', text: 'spoofed' }] } }));
  await new Promise(r => setTimeout(r, 30)); assert.equal(f.app.store.detail(id, aId), null);
  a.close(); assert.equal((await aResponse).status, 503);
  b.send(JSON.stringify({ type: 'response', id: bRequest.id, data: { id, transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', text: 'real B' }] } }));
  assert.equal((await bResponse).status, 200); assert.equal(f.app.store.detail(id, bId).messages[0].text, 'real B');
});

test('device events do not broadcast other-device data; stale stop and approval requests are rejected', async t => {
  const f = await fixture(t), paired = await f.pair(), aId = f.app.store.primaryDeviceId, bId = paired.deviceId;
  const a = await f.connect(), b = await f.connect(paired.agentToken), id = randomUUID();
  snapshot(a, id, 'A'); snapshot(b, id, 'B'); await until(() => f.app.store.list(aId).length && f.app.store.list(bId).length);
  const eventResponse = await f.request(`/api/devices/${bId}/events`), reader = eventResponse.body.getReader();
  await reader.read();
  a.send(JSON.stringify({ type: 'changed', threadId: 'A-PRIVATE-EVENT' }));
  b.send(JSON.stringify({ type: 'changed', threadId: 'B-EVENT' }));
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /B-EVENT/); assert.doesNotMatch(event, /A-PRIVATE-EVENT/);
  await reader.cancel();
  b.send(JSON.stringify({ type: 'state', activeTurns: [{ threadId: id, turnId: 'current-turn' }],
    approvals: [{ id: 'approve-current', threadId: id }] }));
  await until(() => f.app.status(bId).activeTurns.length);
  const connectionId = f.app.status(bId).connectionId;
  assert.equal((await f.request(`/api/devices/${bId}/threads/${id}/stop`, { turnId: 'old', connectionId })).status, 409);
  assert.equal((await f.request(`/api/devices/${bId}/threads/${id}/stop`, { turnId: 'current-turn', connectionId: randomUUID() })).status, 409);
  assert.equal((await f.request(`/api/devices/${aId}/approve`, { id: 'approve-current', threadId: id, connectionId, decision: 'decline' })).status, 409);
  b.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'request') b.send(JSON.stringify({ type: 'response', id: m.id, data: { ok: true } })); });
  assert.equal((await f.request(`/api/devices/${bId}/threads/${id}/stop`, { turnId: 'current-turn', connectionId })).status, 200);
  assert.equal((await f.request(`/api/devices/${bId}/approve`, { id: 'approve-current', threadId: id, connectionId, decision: 'decline' })).status, 200);
});

test('credentials cannot claim another device identity and duplicate connections cannot replace a healthy computer', async t => {
  const f = await fixture(t), paired = await f.pair(), primaryId = f.app.store.primaryDeviceId;
  const checkRejected = (token, deviceId, expected) => new Promise((resolve, reject) => {
    const ws = new WebSocket(f.origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId } });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized or duplicate socket was accepted')); });
    ws.on('unexpected-response', (_, res) => {
      res.resume(); ws.terminate();
      try { assert.equal(res.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
  });
  await checkRejected(paired.agentToken, primaryId, 401);
  const a = await f.connect(), b = await f.connect(paired.agentToken, paired.deviceId);
  const connectionId = f.app.status(paired.deviceId).connectionId;
  await checkRejected(paired.agentToken, paired.deviceId, 409);
  assert.equal(f.app.status(paired.deviceId).connectionId, connectionId);
  assert.equal(a.readyState, WebSocket.OPEN); assert.equal(b.readyState, WebSocket.OPEN);
  await f.request(`/api/devices/${paired.deviceId}/revoke`, {});
  await checkRejected(paired.agentToken, paired.deviceId, 401);
  assert.equal(f.app.status(primaryId).online, true);
});

test('a read-only computer rejects all controls before forwarding a request', async t => {
  const f = await fixture(t), paired = await f.pair(), ws = await f.connect(paired.agentToken, paired.deviceId), id = randomUUID();
  let forwarded = 0; ws.on('message', raw => { if (JSON.parse(raw).type === 'request') forwarded++; });
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id, title: 'Read-only', archived: false, local: true }],
    info: { computer: 'Read-only', controls: false }, activeTurns: [{ threadId: id, turnId: 'turn' }], approvals: [{ id: 'approval', threadId: id }] }));
  await until(() => f.app.store.list(paired.deviceId).length);
  const path = `/api/devices/${paired.deviceId}`, connectionId = f.app.status(paired.deviceId).connectionId;
  assert.equal(f.app.status(paired.deviceId).controls, false);
  assert.equal((await f.request(path + `/threads/${id}/send`, { requestId: randomUUID(), text: 'Do not execute' })).status, 403);
  assert.equal((await f.request(path + `/threads/${id}/stop`, { turnId: 'turn', connectionId })).status, 403);
  assert.equal((await f.request(path + '/approve', { id: 'approval', threadId: id, connectionId, decision: 'accept' })).status, 403);
  assert.equal(forwarded, 0);
});

test('old WAL database migrates with consistent backup, stable identity and preserved uncertainty', t => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-migration-')), path = join(dir, 'cache.sqlite'), id = randomUUID();
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE threads(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE details(id TEXT PRIMARY KEY,payload TEXT NOT NULL,synced INTEGER NOT NULL);
    CREATE TABLE commands(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT,created INTEGER NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  old.prepare('INSERT INTO threads VALUES (?,?)').run(id, JSON.stringify({ id, title: '旧会话' }));
  old.prepare('INSERT INTO details VALUES (?,?,?)').run(id, JSON.stringify({ transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', text: '中文历史' }] }), 1);
  old.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run('old-command', id, 'pending', null, 1);
  old.prepare('INSERT INTO meta VALUES (?,?)').run('sidebar', '{"projects":[{"id":"p","name":"旧项目"}]}');
  old.prepare('INSERT INTO meta VALUES (?,?)').run('lastSync', '123');
  const store = new Store(path), deviceId = store.primaryDeviceId;
  assert.equal(existsSync(store.backupPath), true);
  const backup = new DatabaseSync(store.backupPath, { readOnly: true });
  assert.equal(backup.prepare('SELECT payload FROM threads').get().payload.includes('旧会话'), true); backup.close();
  assert.equal(store.list()[0].title, '旧会话'); assert.equal(store.detail(id).messages[0].text, '中文历史');
  assert.equal(store.sidebar().projects[0].name, '旧项目'); assert.equal(store.lastSync(), 123);
  assert.equal(store.command(deviceId, 'old-command').state, 'unknown');
  store.close(); old.close();
  const reopened = new Store(path); assert.equal(reopened.primaryDeviceId, deviceId); assert.equal(reopened.backupPath, undefined); reopened.close();
});
