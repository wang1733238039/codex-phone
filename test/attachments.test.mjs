import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { AgentAttachments } from '../src/agent-attachments.mjs';
import { buildInputs, attachmentText, detectType, CHUNK_BYTES } from '../src/attachment-common.mjs';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/config.mjs';
import { Transcript, TRANSCRIPT_VERSION } from '../src/transcript.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-attachments-')), token = randomUUID(), threadId = randomUUID(), otherThread = randomUUID();
  const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-pass'),
    agentToken: token, controlsEnabled: true, ...config });
  const receiver = new AgentAttachments({ configPath: join(dir, 'agent', 'config.json'), agentToken: token });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf, sent = [], lastInput = [];
  const request = async (route, method = 'GET', data, headers = {}) => fetch(origin + route, {
    method, headers: { Cookie: cookie || '', Origin: origin, 'X-CSRF-Token': csrf || '', ...headers },
    ...(data === undefined ? {} : { body: Buffer.isBuffer(data) ? data : JSON.stringify(data) }) });
  const json = async (route, method, data) => {
    const response = await request(route, method, data), result = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`); return result;
  };
  const login = await request('/api/login', 'POST', { username: 'admin', password: 'test-pass' });
  cookie = login.headers.get('set-cookie').split(';')[0]; csrf = (await login.json()).csrf;
  const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  ws.on('message', async raw => {
    const m = JSON.parse(raw); if (m.type !== 'request') return;
    try {
      let data = {};
      if (m.action.startsWith('attachment-')) data = await receiver[m.action.slice(11)](m.data);
      if (m.action === 'send') {
        sent.push(m.data); lastInput = buildInputs(m.data.text, await receiver.selected(m.data.threadId, m.data.attachments));
        data = { delivery: 'started', turnId: randomUUID() };
      }
      if (m.action === 'detail') data = { transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', ...attachmentText(lastInput[0]?.text) }], running: false };
      ws.send(JSON.stringify({ type: 'response', id: m.id, data }));
    } catch (error) { ws.send(JSON.stringify({ type: 'response', id: m.id, error: error.message })); }
  });
  ws.send(JSON.stringify({ type: 'snapshot', threads: [threadId, otherThread].map(id => ({ id, local: true, archived: false })),
    info: { version: '0.4.0', capabilities: { attachments: true } } }));
  while (app.store.list().length !== 2) await pause(10);
  t.after(async () => { ws.terminate(); await receiver.ready; await app.close(); await pause(50); rmSync(dir, { recursive: true, force: true }); });
  const base = `/api/devices/${app.store.primaryDeviceId}/threads/${threadId}/attachments`;
  return { dir, token, app, receiver, threadId, otherThread, base, json, request, sent, origin, input: () => lastInput };
}
async function upload(f, name, bytes) {
  const meta = await f.json(f.base, 'POST', { name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
    await f.json(`${f.base}/${meta.id}?offset=${offset}`, 'PUT', bytes.subarray(offset, offset + CHUNK_BYTES));
  const complete = await f.json(`${f.base}/${meta.id}/complete`, 'POST', {});
  let sync;
  do { sync = await f.json(`${f.base}/${meta.id}/sync`, 'POST', {}); } while (!sync.remoteReady);
  return { ...complete, ...sync };
}
test('Chinese file reaches only the selected computer, sends without text, remains downloadable in history', async t => {
  const f = await fixture(t), bytes = Buffer.from('手机附件内容：真实 UTF-8 文件。');
  const uploaded = await upload(f, '中文材料.txt', bytes);
  const requestId = randomUUID(), send = `/api/devices/${f.app.store.primaryDeviceId}/threads/${f.threadId}/send`;
  assert.equal((await f.json(send, 'POST', { requestId, text: '', attachmentIds: [uploaded.id] })).state, 'accepted');
  assert.equal((await f.json(send, 'POST', { requestId, text: '', attachmentIds: [uploaded.id] })).duplicate, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].attachments[0].name, '中文材料.txt'); assert.equal(f.sent[0].attachments[0].path, undefined);
  const parsed = JSON.parse(f.input()[0].text.match(/<codex-phone-attachments>\n([\s\S]*)\n<\/codex-phone-attachments>/)[1]);
  assert.deepEqual(readFileSync(parsed.attachments[0].path), bytes);
  const detail = await f.json(`/api/devices/${f.app.store.primaryDeviceId}/threads/${f.threadId}?refresh=1`);
  assert.equal(detail.messages[0].attachments[0].name, '中文材料.txt'); assert.equal(detail.messages[0].text, '');
  const download = await f.request(`${f.base}/${uploaded.id}/content`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes); assert.match(download.headers.get('content-disposition'), /UTF-8/);
  assert.equal((await f.request(`${f.base}/${uploaded.id}`, 'DELETE')).status, 409);
  const otherBase = f.base.replace(f.threadId, f.otherThread);
  assert.equal((await f.request(`${otherBase}/${uploaded.id}/content`)).status, 404);
  f.app.store.pairing('isolated-test', Date.now() + 10000);
  const second = f.app.store.claim('isolated-test', '隔离电脑', randomUUID());
  f.app.store.snapshot([{ id: f.threadId, local: true, archived: false }], null, second.id);
  const wrongDevice = f.base.replace(f.app.store.primaryDeviceId, second.id);
  assert.equal((await f.request(`${wrongDevice}/${uploaded.id}/content`)).status, 404);
  assert.equal((await f.request(`${wrongDevice}/${uploaded.id}`)).status, 404);
});
test('uploads require login, CSRF, attachment capability, bounded chunks, safe names and reserved quota', async t => {
  const f = await fixture(t, { attachmentQuotaBytes: CHUNK_BYTES * 2 });
  assert.equal((await fetch(f.origin + f.base, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await f.request(f.base, 'POST', { name: 'ok', size: 1 }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  for (const name of ['../escape.txt', 'C:\\outside.txt', 'a\0b', '..']) assert.equal((await f.request(f.base, 'POST', { name, size: 1 })).status, 400);
  assert.equal((await f.request(f.base, 'POST', { name: 'huge', size: 200 * 1024 * 1024 + 1 })).status, 413);
  const first = await f.json(f.base, 'POST', { name: 'chunk.txt', size: CHUNK_BYTES + 1 });
  assert.equal((await f.request(f.base, 'POST', { name: 'reserved', size: CHUNK_BYTES })).status, 413);
  assert.equal((await f.request(`${f.base}/${first.id}?offset=0`, 'PUT', Buffer.alloc(CHUNK_BYTES + 1))).status, 413);
  assert.equal((await f.request(`${f.base}/${first.id}?offset=1`, 'PUT', Buffer.from('a'))).status, 409);
  assert.equal((await f.request(`${f.base}/${first.id}/complete`, 'POST', {})).status, 409);
  await f.json(`${f.base}/${first.id}`, 'DELETE');
});
test('large files resume across receiver restart; repeated chunks are idempotent and differing retries fail', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(CHUNK_BYTES * 3 + 7, 42);
  const item = await f.json(f.base, 'POST', { name: 'manifest.json', size: bytes.length });
  const first = bytes.subarray(0, CHUNK_BYTES);
  await f.json(`${f.base}/${item.id}?offset=0`, 'PUT', first);
  assert.equal((await f.json(`${f.base}/${item.id}?offset=0`, 'PUT', first)).offset, CHUNK_BYTES);
  assert.equal((await f.request(`${f.base}/${item.id}?offset=0`, 'PUT', Buffer.alloc(first.length, 43))).status, 409);
  for (let offset = CHUNK_BYTES; offset < bytes.length; offset += CHUNK_BYTES)
    await f.json(`${f.base}/${item.id}?offset=${offset}`, 'PUT', bytes.subarray(offset, offset + CHUNK_BYTES));
  await f.json(`${f.base}/${item.id}/complete`, 'POST', {});
  const one = await f.json(`${f.base}/${item.id}/sync`, 'POST', {}); assert.equal(one.remoteReady, false); assert.equal(one.remoteOffset, CHUNK_BYTES * 2);
  const restarted = new AgentAttachments(f.receiver.config);
  const meta = await f.receiver.manifest(f.threadId, item.id);
  assert.equal((await restarted.start(meta)).offset, CHUNK_BYTES * 2);
  const finished = await f.json(`${f.base}/${item.id}/sync`, 'POST', {}); assert.equal(finished.remoteReady, true);
  const [selected] = await restarted.selected(f.threadId, [meta]); assert.deepEqual(readFileSync(selected.path), bytes);
  assert.ok(selected.path.endsWith('original-manifest.json'));
});
test('image content is detected by bytes, SVG is a file and native image input survives queue/steer construction', async t => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aXyUAAAAASUVORK5CYII=', 'base64');
  const item = await upload(f, '照片.png', png);
  assert.equal(item.kind, 'image');
  await f.json(`/api/devices/${f.app.store.primaryDeviceId}/threads/${f.threadId}/send`, 'POST', { text: '看图', requestId: randomUUID(), mode: 'steer', attachmentIds: [item.id] });
  assert.equal(f.input()[1].type, 'localImage');
  assert.equal(detectType(Buffer.from('<svg onload="x()">'), 'unsafe.svg').kind, 'file');
  const native = new Transcript();
  native.push({ type: 'event_msg', payload: { type: 'user_message', message: f.input()[0].text } });
  const projected = native.finish().messages[0]; assert.equal(projected.text, '看图'); assert.deepEqual(projected.attachmentIds, [item.id]);
  assert.ok(!JSON.stringify(projected).includes('original-'));
});
test('cleanup expires server caches without deleting computer originals', async t => {
  const f = await fixture(t), item = await upload(f, 'retained.txt', Buffer.from('retained'));
  f.app.store.db.prepare('UPDATE attachments SET created_at=? WHERE id=?').run(Date.now() - 2 * 86400000, item.id);
  // Run through a fresh scoped store controller, sharing exactly the existing metadata.
  const { ServerAttachments } = await import('../src/server-attachments.mjs');
  const manager = new ServerAttachments(f.app.store, join(f.dir, 'cache.sqlite')); await manager.ready; await manager.cleanup();
  assert.equal((await f.request(`${f.base}/${item.id}/content`)).status, 410);
  assert.equal((await f.receiver.manifest(f.threadId, item.id)).ready, true);
});
test('receiver validates actual hash and refuses metadata replacement or paths outside its private root', async t => {
  const f = await fixture(t), bytes = Buffer.from('safe upload'), id = randomUUID();
  const meta = { id, threadId: f.threadId, name: 'upload.part', size: bytes.length, hash: hash(bytes) };
  await f.receiver.start(meta);
  await assert.rejects(f.receiver.start({ ...meta, name: 'different.txt' }), /不匹配/);
  await assert.rejects(f.receiver.start({ ...meta, id: '../escape' }), /编号无效/);
  await f.receiver.chunk({ id, threadId: f.threadId, offset: 0, base64: Buffer.from('bad content').toString('base64') });
  await assert.rejects(f.receiver.finish({ id, threadId: f.threadId }), /校验失败/);
});
