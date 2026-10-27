import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/config.mjs';
import { Store, credentialHash } from '../src/store.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';
import { listenForFetch } from './helpers/http.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async fn => { for (let i = 0; i < 150; i++) { if (await fn()) return; await sleep(10); } throw new Error('Timed out'); };
const PASSWORD = 'independent-test-password';
async function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-accounts-'));
  const config = { database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword(PASSWORD),
    agentToken: 'test-admin-device', controlsEnabled: true, ...extra };
  const app = createApp(config);
  const origin = await listenForFetch(app.server);
  t.after(async () => { await app.close(); rmSync(dir, { force: true, recursive: true }); });
  function client() {
    const c = { cookie: '', csrf: '', account: null };
    c.request = (path, method = 'GET', data, headers = {}) => fetch(origin + path, { method,
      headers: { Cookie: c.cookie, Origin: origin, 'X-CSRF-Token': c.csrf, 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: Buffer.isBuffer(data) ? data : JSON.stringify(data) }) });
    c.json = async (path, method = 'GET', data) => {
      const res = await c.request(path, method, data), value = await res.json();
      assert.ok(res.ok, `${res.status}: ${JSON.stringify(value)}`); return value;
    };
    c.login = async (username, password = PASSWORD) => {
      const res = await c.request('/api/login', 'POST', { username, password });
      assert.equal(res.status, 200); c.cookie = res.headers.get('set-cookie').split(';')[0];
      const value = await res.json(); c.csrf = value.csrf; c.account = value.account; return value;
    };
    return c;
  }
  const admin = client(); await admin.login('admin');
  async function member(name, deviceLimit = 3) {
    const { account } = await admin.json('/api/admin/accounts', 'POST', { username: name, password: PASSWORD, serviceDays: 30, deviceLimit });
    const c = client(); await c.login(name); return Object.assign(c, { id: account.id });
  }
  async function pair(c, name = '测试电脑') {
    const { code } = await c.json('/api/device-pairings', 'POST', {});
    const data = await (await fetch(origin + '/api/device-pairings/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, ownerId: 'personal' }) })).json();
    assert.ok(data.deviceId, JSON.stringify(data)); return data;
  }
  async function connect(device, name, threadId = randomUUID()) {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${device.agentToken}`, 'X-Device-Id': device.deviceId } });
    await once(ws, 'open');
    const requests = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw); if (msg.type !== 'request') return; requests.push(msg);
      const data = msg.action === 'detail' ? { id: threadId, transcriptVersion: TRANSCRIPT_VERSION, running: false,
        messages: [{ role: 'user', text: `${name}的输入` }, { role: 'assistant', phase: 'final_answer', text: `${name}的结果` }] }
        : msg.action === 'models' ? { models: [{ id: name, name }] } : msg.action === 'attachment-start' ? { ready: true } : { delivery: 'started', ok: true };
      if (!ws.hold) ws.send(JSON.stringify({ type: 'response', id: msg.id, data }));
    });
    ws.send(JSON.stringify({ type: 'snapshot', ownerId: 'personal', deviceId: 'forged', threads: [{ id: threadId, title: name, local: true, archived: false }],
      sidebar: { projects: [{ id: 'same-project', name }] }, info: { computer: name, capabilities: { createThread: true, attachments: true } } }));
    await until(() => app.store.forOwner(app.store.authenticateAny(device.agentToken).owner_id).list(device.deviceId).length);
    return { ws, requests, threadId };
  }
  async function rejected(token, deviceId) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${token}`, ...(deviceId ? { 'X-Device-Id': deviceId } : {}) } });
      ws.on('error', () => {}); ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized connection accepted')); });
      ws.on('unexpected-response', (_, res) => { const status = res.statusCode; res.resume(); ws.terminate(); resolve(status); });
    });
  }
  return { app, dir, config, origin, admin, client, member, pair, connect, rejected };
}

test('unknown logins return a generic 401 even when the password matches the administrator', async t => {
  const f = await fixture(t), client = f.client();
  for (const username of ['never-created', '', 'x'.repeat(101)]) {
    const response = await client.request('/api/login', 'POST', { username, password: PASSWORD });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: '账号或密码不正确' });
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(await f.app.accounts.checkPassword('missing-account', PASSWORD), false);
  assert.equal((await client.request('/api/login', 'POST', { username: 'admin', password: 'incorrect-password' })).status, 401);
  await client.login('admin');
});

test('unexpected authentication errors do not expose internal fields', async t => {
  const f = await fixture(t), client = f.client();
  const broken = async () => { throw new Error('Internal password_hash database failure'); };
  f.app.accounts.authenticate = broken; f.app.accounts.register = broken;
  for (const path of ['/api/login', '/api/register']) {
    const response = await client.request(path, 'POST', { username: 'unknown-user', password: PASSWORD });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: '账号服务暂时不可用，请稍后重试' });
  }
});

test('independent logins bind sessions to immutable owners; normal users cannot manage accounts', async t => {
  const f = await fixture(t), a = await f.member('member-a'), b = await f.member('member-b');
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await a.json('/api/devices')).devices, []);
  assert.equal((await a.json('/api/session')).account.id, a.id);
  assert.equal((await a.json('/api/session')).primaryDeviceId, null);
  for (const path of ['/api/admin/accounts', '/api/admin/invitations']) assert.equal((await a.request(path)).status, 403);
  assert.equal((await a.request('/api/admin/accounts', 'POST', { username: 'hacked', role: 'admin', password: PASSWORD })).status, 403);
  assert.equal((await f.admin.request('/api/admin/accounts', 'POST', { username: 'MEMBER-A', password: PASSWORD })).status, 409);
  assert.equal((await a.request('/api/device-pairings', 'POST', {}, { 'X-CSRF-Token': b.csrf })).status, 403);
  const directory = JSON.stringify(await f.admin.json('/api/admin/accounts'));
  assert.doesNotMatch(directory, /password_hash|csrf|token_hash|的输入|的结果/);
  assert.equal((await a.json('/api/account')).account.role, 'member');
});

test('public signup persists a salted password and logs in without an invitation or client-controlled privileges', async t => {
  const f = await fixture(t, { defaultDeviceLimit: 2 }), c = f.client(), before = Date.now();
  const response = await c.request('/api/register', 'POST', {
    username: '  New-Member  ', password: PASSWORD, role: 'admin', ownerId: 'personal',
    status: 'active', serviceDays: 3660, deviceLimit: 50, expiresAt: null
  });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  c.cookie = response.headers.get('set-cookie').split(';')[0];
  const session = await response.json(); c.csrf = session.csrf;
  assert.equal(session.authenticated, true);
  assert.equal(session.account.username, 'new-member'); assert.equal(session.account.role, 'member');
  assert.equal(session.account.deviceLimit, 2); assert.equal(session.account.deviceCount, 0);
  assert.notEqual(session.account.id, 'personal'); assert.equal(session.primaryDeviceId, null);
  assert.ok(session.account.expiresAt >= before + 30 * 86400000);
  assert.ok(session.account.expiresAt <= Date.now() + 30 * 86400000);
  assert.deepEqual((await c.json('/api/devices')).devices, []);
  assert.equal((await c.request('/api/admin/accounts')).status, 403);
  const database = new DatabaseSync(f.config.database, { readOnly: true });
  try {
    const stored = database.prepare('SELECT * FROM accounts WHERE id=?').get(session.account.id);
    assert.match(stored.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.notEqual(stored.password_hash, PASSWORD);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM invitations').get().n, 0);
    assert.equal(database.prepare("SELECT actor_id FROM account_audit WHERE target_id=? AND action='account.create'").get(stored.id).actor_id, stored.id);
  } finally { database.close(); }
  assert.doesNotMatch(JSON.stringify(session), /password_hash|independent-test-password/);
  await c.json('/api/logout', 'POST', {});
  assert.equal((await c.json('/api/session')).authenticated, false);
  await c.login('NEW-MEMBER'); assert.equal(c.account.id, session.account.id);
  const listing = await f.admin.json('/api/admin/accounts?q=new-member');
  assert.equal(listing.accounts[0].id, session.account.id);
});

test('concurrent public signups reject duplicate usernames and keep self-registered owners isolated', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  const register = (c, name) => c.request('/api/register', 'POST', { username: name, password: PASSWORD });
  const duplicates = await Promise.all([register(a, 'SELF-A'), register(b, 'self-a')]);
  assert.deepEqual(duplicates.map(r => r.status).sort(), [201, 409]);
  assert.equal((await register(b, 'self-b')).status, 201);
  await a.login('self-a'); await b.login('self-b');
  a.id = a.account.id; b.id = b.account.id; assert.notEqual(a.id, b.id);
  const da = await f.pair(a), db = await f.pair(b), threadId = randomUUID();
  await f.connect(da, 'Self A', threadId); await f.connect(db, 'Self B', threadId);
  assert.equal((await a.json('/api/devices')).devices.length, 1);
  assert.equal((await b.json('/api/devices')).devices.length, 1);
  assert.equal((await a.json(`/api/devices/${da.deviceId}/threads/${threadId}`)).messages[0].text, 'Self A的输入');
  assert.equal((await a.request(`/api/devices/${db.deviceId}/threads/${threadId}`)).status, 404);
  assert.equal((await b.request(`/api/devices/${da.deviceId}/threads/${threadId}/send`, 'POST', { requestId: randomUUID(), text: 'blocked' })).status, 404);
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) n FROM account_audit WHERE action='account.create'").get().n, 2);
  const hashes = f.app.store.db.prepare("SELECT password_hash FROM accounts WHERE role='member'").all();
  assert.notEqual(hashes[0].password_hash, hashes[1].password_hash);
});

test('public signup validates credentials and origin and limits attempts regardless of untrusted forwarded IP headers', async t => {
  const f = await fixture(t), c = f.client();
  assert.equal((await c.request('/api/register', 'POST', { username: 'cross-origin', password: PASSWORD }, { Origin: 'https://other.example' })).status, 403);
  const invalid = [
    null, [], {}, { username: 'bad space', password: PASSWORD }, { username: 'ok-user', password: 'short' },
    { username: 'ok-user', password: 'x'.repeat(129) }, { username: 'x'.repeat(81), password: PASSWORD },
    { username: 'ok-user', password: 42 }
  ];
  for (const [i, data] of invalid.entries()) {
    assert.equal((await c.request('/api/register', 'POST', data, { 'X-Real-IP': `192.0.2.${i + 1}` })).status, 400);
  }
  assert.equal((await c.request('/api/register', 'POST', { username: 'limited-user', password: PASSWORD }, { 'X-Real-IP': '192.0.2.200' })).status, 429);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1);
});

test('one-use invitations start entitlement on redemption, ignore role/owner input and support revoke and expiry', async t => {
  const f = await fixture(t), invite = await f.admin.json('/api/admin/invitations', 'POST', { serviceDays: 12, deviceLimit: 2 });
  const row = f.app.store.db.prepare('SELECT * FROM invitations WHERE id=?').get(invite.id);
  assert.equal(row.hash, credentialHash(invite.code)); assert.notEqual(row.hash, invite.code);
  const before = Date.now(), c = f.client();
  const register = (name, code = invite.code) => c.request('/api/register', 'POST', { username: name, password: PASSWORD, code, ownerId: 'personal', role: 'admin' });
  const results = await Promise.all([register('invited-a'), register('invited-b')]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
  const value = await results.find(r => r.status === 201).json();
  assert.equal(value.account.role, 'member'); assert.equal(value.account.deviceLimit, 2);
  assert.ok(value.account.expiresAt >= before + 12 * 86400000);
  assert.notEqual(value.account.id, 'personal');
  const two = await f.admin.json('/api/admin/invitations', 'POST', {});
  await f.admin.json(`/api/admin/invitations/${two.id}/revoke`, 'POST', {});
  assert.equal((await register('revoked-user', two.code)).status, 400);
  const three = await f.admin.json('/api/admin/invitations', 'POST', {});
  f.app.store.db.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(Date.now() - 1, three.id);
  assert.equal((await register('expired-user', three.code)).status, 400);
  assert.equal((await c.request('/api/register', 'POST', { username: 'no-invite', password: PASSWORD })).status, 201);
  assert.doesNotMatch(JSON.stringify(await f.admin.json('/api/admin/invitations')), new RegExp(invite.code));
});

test('two users with two computers each cannot access another owner through any device route', async t => {
  const f = await fixture(t), a = await f.member('scope-a'), b = await f.member('scope-b');
  const id = randomUUID(), requestId = randomUUID();
  const da = await f.pair(a), da2 = await f.pair(a), db = await f.pair(b), db2 = await f.pair(b);
  const aa = await f.connect(da, '用户A电脑1', id), ab = await f.connect(da2, '用户A电脑2', id);
  const ba = await f.connect(db, '用户B电脑1', id), bb = await f.connect(db2, '用户B电脑2', id);
  const own = `/api/devices/${da.deviceId}`, other = `/api/devices/${db.deviceId}`;
  assert.equal((await a.json('/api/devices')).devices.length, 2);
  assert.equal((await b.json('/api/devices')).devices.length, 2);
  assert.equal((await f.admin.json('/api/devices')).devices.length, 1);
  assert.equal((await a.json(own + `/threads/${id}`)).messages[0].text, '用户A电脑1的输入');
  assert.equal((await b.json(other + `/threads/${id}`)).messages[0].text, '用户B电脑1的输入');
  for (const route of ['/status', '/models', '/threads', `/threads/${id}`, '/events', `/commands/${requestId}`]) {
    assert.equal((await a.request(other + route)).status, 404, route);
    assert.equal((await f.admin.request(other + route)).status, 404, `admin ${route}`);
  }
  for (const route of ['/rename', '/revoke', '/approve', '/threads', `/threads/${id}/send`, `/threads/${id}/stop`, `/threads/${id}/queue-delete`, `/threads/${id}/queue-start`]) {
    assert.equal((await a.request(other + route, 'POST', { name: 'stolen', requestId, text: 'no' })).status, 404, route);
  }
  for (const [client, base] of [[a, own], [b, other]]) {
    assert.equal((await client.json(base + `/threads/${id}/send`, 'POST', { requestId, text: 'own task', ownerId: b.id })).state, 'accepted');
    assert.equal((await client.json(base + `/commands/${requestId}`)).state, 'accepted');
  }
  assert.equal(aa.requests.filter(r => r.action === 'send').length, 1);
  assert.equal(ba.requests.filter(r => r.action === 'send').length, 1);
  assert.equal(ab.requests.length, 0); assert.equal(bb.requests.length, 0);
  assert.equal(await f.rejected(db.agentToken, da.deviceId), 401);
  assert.equal(f.app.store.ownerId, 'personal');
});

test('directory and thread events never cross accounts; a foreign connection cannot spoof a response', async t => {
  const f = await fixture(t), a = await f.member('events-a'), b = await f.member('events-b');
  const da = await f.pair(a), db = await f.pair(b), id = randomUUID();
  const aa = await f.connect(da, 'A', id), bb = await f.connect(db, 'B', id);
  const abort = new AbortController(), chunks = [];
  const events = await fetch(f.origin + '/api/devices/events', { headers: { Cookie: a.cookie }, signal: abort.signal });
  const pump = (async () => { try { for await (const chunk of events.body) chunks.push(Buffer.from(chunk).toString('utf8')); } catch {} })();
  await until(() => chunks.length > 0); chunks.length = 0;
  await b.json(`/api/devices/${db.deviceId}/rename`, 'POST', { name: 'B-only' });
  await sleep(30); assert.equal(chunks.length, 0);
  await a.json(`/api/devices/${da.deviceId}/rename`, 'POST', { name: 'A-only' });
  await until(() => chunks.some(s => s.includes('event: devices')));
  abort.abort(); await pump;
  aa.ws.hold = true;
  const pending = a.request(`/api/devices/${da.deviceId}/threads/${id}?refresh=1`);
  await until(() => aa.requests.some(r => r.action === 'detail'));
  const message = aa.requests.find(r => r.action === 'detail');
  bb.ws.send(JSON.stringify({ type: 'response', id: message.id, data: { transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', text: 'forged' }] } }));
  await sleep(20); assert.equal(f.app.store.forOwner(a.id).detail(id, da.deviceId), null);
  aa.ws.send(JSON.stringify({ type: 'response', id: message.id, data: { transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', text: 'real A' }] } }));
  assert.equal((await (await pending).json()).messages[0].text, 'real A');
});

test('attachments, downloads, bindings and reserved quota are isolated per account', async t => {
  const f = await fixture(t, { attachmentQuotaBytes: 8 }), a = await f.member('files-a'), b = await f.member('files-b');
  const da = await f.pair(a), db = await f.pair(b), id = randomUUID();
  await f.connect(da, 'A', id); await f.connect(db, 'B', id);
  const base = d => `/api/devices/${d.deviceId}/threads/${id}/attachments`;
  const upload = async (c, d) => {
    const item = await c.json(base(d), 'POST', { name: '中文.txt', size: 8 });
    await c.json(`${base(d)}/${item.id}?offset=0`, 'PUT', Buffer.from('abcdefgh'));
    await c.json(`${base(d)}/${item.id}/complete`, 'POST', {});
    await c.json(`${base(d)}/${item.id}/sync`, 'POST', {}); return item;
  };
  const fa = await upload(a, da), fb = await upload(b, db);
  assert.equal(await (await a.request(`${base(da)}/${fa.id}/content`)).text(), 'abcdefgh');
  for (const target of [`${base(db)}/${fb.id}`, `${base(db)}/${fb.id}/content`, `${base(da)}/${fb.id}`, `${base(da)}/${fb.id}/content`]) {
    assert.equal((await a.request(target)).status, 404);
  }
  assert.equal((await a.request(`${base(da)}/${fb.id}`, 'DELETE')).status, 404);
  assert.equal((await a.request(`/api/devices/${da.deviceId}/threads/${id}/send`, 'POST', { requestId: randomUUID(), text: '', attachmentIds: [fb.id] })).status, 404);
  assert.equal((await a.request(base(da), 'POST', { name: 'over.txt', size: 1 })).status, 413);
  await a.json(`${base(da)}/${fa.id}`, 'DELETE');
  assert.equal((await b.request(`${base(db)}/${fb.id}/content`)).status, 200);
});

test('expiry blocks new work, pair claims and sockets but preserves own cached reads and login; renewal restores access', async t => {
  const f = await fixture(t), a = await f.member('expiry-a'), d = await f.pair(a), agent = await f.connect(d, '有效期测试');
  const base = `/api/devices/${d.deviceId}`, id = agent.threadId;
  await a.json(base + `/threads/${id}`);
  const { code } = await a.json('/api/device-pairings', 'POST', {});
  await f.admin.json(`/api/admin/accounts/${a.id}`, 'POST', { expiresAt: Date.now() - 1 });
  await until(() => agent.ws.readyState === WebSocket.CLOSED);
  assert.equal((await a.json('/api/account')).account.accessState, 'expired');
  assert.equal((await a.json(base + `/threads/${id}`)).messages[0].text, '有效期测试的输入');
  for (const path of ['/api/device-pairings', base + '/threads', base + `/threads/${id}/send`, base + `/threads/${id}/attachments`]) {
    assert.equal((await a.request(path, 'POST', { requestId: randomUUID(), text: 'blocked', title: '' })).status, 402);
  }
  const claim = await fetch(f.origin + '/api/device-pairings/claim', { method: 'POST', body: JSON.stringify({ code, name: 'blocked' }) });
  assert.equal(claim.status, 400); assert.equal(await f.rejected(d.agentToken, d.deviceId), 401);
  await a.login('expiry-a');
  const result = await f.admin.json(`/api/admin/accounts/${a.id}`, 'POST', { extendDays: 30 });
  assert.equal(result.account.accessState, 'active');
  const again = await f.connect(d, '续期恢复', id);
  assert.equal((await a.json(base + `/threads/${id}/send`, 'POST', { requestId: randomUUID(), text: 'renewed' })).state, 'accepted');
  assert.equal(again.ws.readyState, WebSocket.OPEN);
  const more = await f.admin.json(`/api/admin/accounts/${a.id}`, 'POST', { extendDays: 30 });
  assert.equal(more.account.expiresAt, result.account.expiresAt + 30 * 86400000);
});

test('device limits are checked at claim time; suspension, password reset and deletion invalidate only their target', async t => {
  const f = await fixture(t), a = await f.member('lifecycle-a', 1), b = await f.member('lifecycle-b');
  const one = await a.json('/api/device-pairings', 'POST', {}), two = await a.json('/api/device-pairings', 'POST', {});
  const claim = code => fetch(f.origin + '/api/device-pairings/claim', { method: 'POST', body: JSON.stringify({ code, name: 'one' }) });
  const first = await claim(one.code); assert.equal(first.status, 201); const da = await first.json();
  assert.equal((await claim(two.code)).status, 409);
  const db = await f.pair(b), agent = await f.connect(da, '待删除'), other = await f.connect(db, '保留');
  const base = `/api/devices/${da.deviceId}/threads/${agent.threadId}/attachments`;
  const item = await a.json(base, 'POST', { name: 'delete.txt', size: 4 });
  const path = join(f.dir, 'attachments', item.id); assert.equal(existsSync(path), true);
  const sse = await a.request('/api/devices/events'), reader = sse.body.getReader(); await reader.read();
  await f.admin.json(`/api/admin/accounts/${a.id}`, 'POST', { status: 'disabled' });
  await until(() => agent.ws.readyState === WebSocket.CLOSED);
  assert.equal((await a.json('/api/session')).authenticated, false);
  assert.equal((await a.request('/api/login', 'POST', { username: 'lifecycle-a', password: PASSWORD })).status, 401);
  // Disconnect can flush an already queued directory event before ending the stream.
  while (!(await reader.read()).done) {}
  await reader.cancel();
  assert.equal((await b.json('/api/session')).authenticated, true); assert.equal(other.ws.readyState, WebSocket.OPEN);
  await f.admin.json(`/api/admin/accounts/${a.id}`, 'POST', { status: 'active' });
  await a.login('lifecycle-a');
  await f.admin.json(`/api/admin/accounts/${a.id}/password`, 'POST', { password: 'reset-password-long' });
  assert.equal((await a.json('/api/session')).authenticated, false);
  await a.login('lifecycle-a', 'reset-password-long');
  await f.admin.json(`/api/admin/accounts/${a.id}/delete`, 'POST', { confirmUsername: 'lifecycle-a' });
  assert.equal((await a.json('/api/session')).authenticated, false);
  assert.equal(f.app.store.authenticateAny(da.agentToken), undefined); assert.equal(existsSync(path), false);
  for (const table of ['threads', 'details', 'commands', 'devices', 'attachments', 'sessions', 'pairings']) {
    assert.equal(f.app.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE owner_id=?`).get(a.id).n, 0, table);
  }
  assert.equal(f.app.accounts.get(a.id).password_hash, null);
  assert.equal((await b.json('/api/devices')).devices.length, 1);
  assert.equal((await f.admin.request('/api/admin/accounts/personal/delete', 'POST', { confirmUsername: 'admin' })).status, 403);
});

test('reaching a future expiry automatically disconnects only that account and emits an account event', async t => {
  const f = await fixture(t), a = await f.member('timer-expiry'), d = await f.pair(a), agent = await f.connect(d, '自然到期');
  const abort = new AbortController(), chunks = [];
  const response = await fetch(f.origin + '/api/devices/events', { headers: { Cookie: a.cookie }, signal: abort.signal });
  const pump = (async () => { try { for await (const chunk of response.body) chunks.push(Buffer.from(chunk).toString('utf8')); } catch {} })();
  await f.admin.json(`/api/admin/accounts/${a.id}`, 'POST', { expiresAt: Date.now() + 400 });
  chunks.length = 0;
  await until(() => agent.ws.readyState === WebSocket.CLOSED);
  await until(() => chunks.some(chunk => chunk.includes('event: account')));
  assert.equal(agent.requests.some(r => r.action === 'stop'), false);
  assert.equal((await a.json('/api/session')).authenticated, true);
  abort.abort(); await pump;
});

test('malformed account bodies are rejected and arbitrary forwarded IP headers cannot bypass login limits', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin.request('/api/register', 'POST', null)).status, 400);
  for (let i = 0; i < 8; i++) {
    assert.equal((await f.admin.request('/api/login', 'POST', { username: 'admin', password: 'wrong' }, { 'X-Real-IP': `192.0.2.${i + 1}` })).status, 401);
  }
  assert.equal((await f.admin.request('/api/login', 'POST', { username: 'admin', password: PASSWORD }, { 'X-Real-IP': '192.0.2.200' })).status, 429);
});

test('changing password revokes other sessions and rechecks current password; lifecycle inputs cannot promote users', async t => {
  const f = await fixture(t), a = await f.member('password-a'), second = f.client();
  await second.login('password-a');
  assert.equal((await a.request('/api/account/password', 'POST', { currentPassword: 'wrong', newPassword: PASSWORD })).status, 403);
  assert.equal((await a.request('/api/account/password', 'POST', { currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
  await a.json('/api/account/password', 'POST', { currentPassword: PASSWORD, newPassword: 'changed-password-long' });
  assert.equal((await second.json('/api/session')).authenticated, false);
  await a.login('PASSWORD-A', 'changed-password-long');
  for (const data of [{ role: 'admin' }, { ownerId: 'personal' }, { extendDays: -1 }, { deviceLimit: 0 }, { expiresAt: null }, { status: 'deleted' }]) {
    assert.equal((await f.admin.request(`/api/admin/accounts/${a.id}`, 'POST', data)).status, 400);
  }
  await a.json('/api/account/delete', 'POST', { confirmUsername: 'password-a', password: 'changed-password-long' });
  assert.equal((await a.json('/api/session')).authenticated, false);
});

test('0.5 database migration preserves admin identity, old cookie, devices and history with a restorable pre-migration backup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-account-migration-')), path = join(dir, 'cache.sqlite');
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const old = new Store(path), threadId = randomUUID(), deviceId = old.primaryDeviceId;
  old.initializePrimary('stable-device-token');
  old.snapshot([{ id: threadId, title: '迁移前会话', archived: false }]);
  old.saveDetail(threadId, { transcriptVersion: TRANSCRIPT_VERSION, messages: [{ role: 'user', text: '原始中文历史' }] });
  const cookie = 'pre-migration-cookie', digest = createHash('sha256').update(cookie).digest('hex');
  old.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest, 'stable-csrf', Date.now() + 600000); old.close();
  const config = { database: path, username: 'old-admin', passwordHash: hashPassword('old-password'), agentToken: 'stable-device-token' };
  const app = createApp(config); assert.equal(existsSync(app.accounts.backupPath), true);
  const backupPath = app.accounts.backupPath, backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='accounts'").get(), undefined);
  assert.equal(backup.prepare('SELECT csrf FROM sessions').get().csrf, 'stable-csrf'); backup.close();
  const origin = await listenForFetch(app.server);
  try {
    const session = await (await fetch(origin + '/api/session', { headers: { Cookie: `codex_phone=${cookie}` } })).json();
    assert.equal(session.username, 'old-admin'); assert.equal(session.account.role, 'admin');
    assert.equal(session.csrf, 'stable-csrf'); assert.equal(session.primaryDeviceId, deviceId);
    assert.equal(app.store.detail(threadId).messages[0].text, '原始中文历史');
    assert.equal(app.store.authenticateAny('stable-device-token').id, deviceId);
  } finally { await app.close(); }
  const reopened = createApp({ ...config, passwordHash: hashPassword('stale-config-password') });
  try {
    assert.equal(reopened.accounts.backupPath, undefined);
    assert.ok(await reopened.accounts.authenticate('old-admin', 'old-password'));
    assert.equal(await reopened.accounts.authenticate('old-admin', 'stale-config-password'), null);
    assert.equal(reopened.store.primaryDeviceId, deviceId);
  } finally { await reopened.close(); }
  const restored = createApp({ ...config, database: backupPath });
  try { assert.equal(restored.store.detail(threadId).messages[0].text, '原始中文历史'); assert.equal(restored.store.primaryDeviceId, deviceId); }
  finally { await restored.close(); }
});
