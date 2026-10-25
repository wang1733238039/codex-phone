import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT, loadConfig } from '../src/config.mjs';
import { Agent } from '../.data/connector-package/src/agent.mjs';

const origin = process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819';
const password = readFileSync(join(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
async function request(path, data) {
  const res = await fetch(origin + path, { headers: { Cookie: cookie, ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
  const value = await res.json(); if (!res.ok) throw new Error(`${res.status}: ${value.error}`); return value;
}
const until = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); } throw new Error('Public device test timed out'); };
const scratch = mkdtempSync(join(ROOT, '.data', 'connector-validation-')), home = join(scratch, 'codex'), configPath = join(scratch, 'agent.json'), codeFile = join(scratch, 'code.txt');
mkdirSync(join(home, 'sessions'), { recursive: true });
let deviceId, agent, db;
try {
  const before = await request('/api/devices'), primaryId = before.primaryDeviceId;
  const originalList = await request(`/api/devices/${primaryId}/threads`);
  assert.equal(originalList.online, true); assert.equal(originalList.activeTurns.length, 0);
  const packageRes = await fetch(origin + '/downloads/codex-phone-agent.zip'); assert.equal(packageRes.status, 200);
  const downloaded = Buffer.from(await packageRes.arrayBuffer()), expected = readFileSync(join(ROOT, 'public/downloads/codex-phone-agent.zip'));
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  const guide = await fetch(origin + '/downloads/CONNECT-ANOTHER-COMPUTER.md'); assert.equal(guide.status, 200);
  assert.match(await guide.text(), /tools\/pair.mjs/);
  const threadId = originalList.threads[0].id, path = join(home, 'sessions', 'test.jsonl');
  const event = payload => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload });
  writeFileSync(path, [event({ type: 'user_message', message: '独立设备测试输入' }), event({ type: 'agent_message', message: '独立设备测试回复', phase: 'final_answer' }), event({ type: 'task_complete' })].join('\n') + '\n', 'utf8');
  db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,cwd TEXT,updated_at INTEGER,archived INTEGER,source TEXT,thread_source TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,0,?,?)').run(threadId, path, '接入包临时会话', home, Date.now(), 'cli', 'user'); db.close(); db = null;
  const pairing = await request('/api/device-pairings', {}); writeFileSync(codeFile, pairing.code, { encoding: 'utf8', mode: 0o600 });
  const child = spawn(process.execPath, [join(ROOT, '.data/connector-package/tools/pair.mjs'), '--server', origin, '--code-file', codeFile, '--name', '接入包验收（临时模拟设备）',
    '--codex-home', home, '--codex-bin', loadConfig('agent').codexBin, '--config', configPath, '--read-only'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errorOutput = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => errorOutput += b);
  const [code] = await once(child, 'exit'); assert.equal(code, 0, errorOutput);
  const result = JSON.parse(output.trim()); deviceId = result.deviceId; assert.notEqual(deviceId, primaryId); assert.equal(result.paired, true);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.controlsEnabled, false);
  agent = new Agent(config); agent.start();
  await until(async () => (await request(`/api/devices/${deviceId}/threads`)).threads.length === 1);
  const directory = await request('/api/devices');
  assert.ok(directory.devices.find(d => d.id === primaryId).online); assert.ok(directory.devices.find(d => d.id === deviceId).online);
  const detail = await request(`/api/devices/${deviceId}/threads/${threadId}?refresh=1`);
  assert.deepEqual(detail.messages.map(m => m.text), ['独立设备测试输入', '独立设备测试回复']);
  const primaryList = await request(`/api/devices/${primaryId}/threads`);
  assert.equal(primaryList.threads.length, originalList.threads.length);
  assert.notEqual(primaryList.threads.find(t => t.id === threadId).title, '接入包临时会话');
  const rejected = await fetch(origin + `/api/devices/${deviceId}/threads/${threadId}/send`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ requestId: randomUUID(), text: '只读设备不得执行' }) });
  assert.equal(rejected.status, 403);
  await request(`/api/devices/${deviceId}/rename`, { name: '临时模拟设备已改名' });
  assert.equal((await request('/api/devices')).devices.find(d => d.id === deviceId).name, '临时模拟设备已改名');
  agent.close(); agent = null;
  await until(async () => !(await request(`/api/devices/${deviceId}/status`)).online);
  const cached = await request(`/api/devices/${deviceId}/threads/${threadId}`);
  assert.equal(cached.fromCache, true); assert.equal(cached.messages.length, 2);
  await request(`/api/devices/${deviceId}/revoke`, {});
  assert.ok(!(await request('/api/devices')).devices.some(d => d.id === deviceId));
  const report = { passed: true, verifiedAt: new Date().toISOString(), origin, realComputers: 1, simulatedAdditionalComputers: 1,
    primaryThreadsPreserved: originalList.threads.length, packageSha256: createHash('sha256').update(downloaded).digest('hex'),
    checked: ['public-package-download', 'guide-download', 'packaged-cli-pairing', 'private-config', 'second-agent-auth', 'simultaneous-online', 'same-thread-id-isolation', 'filtered-history', 'server-read-only-enforcement', 'rename', 'offline-cache', 'revoke'], noModelCall: true, temporaryDeviceRevoked: true };
  mkdirSync(resolve(ROOT, 'artifacts/public-deploy'), { recursive: true });
  writeFileSync(resolve(ROOT, 'artifacts/public-deploy/multi-device-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); console.log(JSON.stringify(report));
} finally {
  agent?.close(); db?.close();
  if (deviceId) { try { await request(`/api/devices/${deviceId}/revoke`, {}); } catch {} }
  await request('/api/logout', {});
  rmSync(scratch, { force: true, recursive: true });
}
