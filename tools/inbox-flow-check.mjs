// Opt-in real model test. Every mutation targets one new disposable thread.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexClient } from '../src/codex.mjs';
import { ROOT, loadConfig } from '../src/config.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run for the real disposable-thread test.');
const origin = new URL(process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819').origin;
const config = loadConfig('agent'), client = new CodexClient(config);
const password = readFileSync(resolve(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }), signal: AbortSignal.timeout(15000) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0], { csrf, primaryDeviceId } = await login.json();
const deviceId = config.deviceId || primaryDeviceId;
async function api(path, data) {
  const response = await fetch(origin + path, { headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), signal: AbortSignal.timeout(70000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error}`);
  return value;
}
const device = (path, data) => api(`/api/devices/${deviceId}${path}`, data);
const pause = ms => new Promise(r => setTimeout(r, ms));
let id, archived = false;
try {
  const status = await device('/status');
  assert.equal(status.online, true); assert.equal(status.activeTurns.length, 0); assert.equal(status.capabilities.createThread, true);
  const listing = await device('/threads');
  const project = listing.sidebar.projects.find(p => p.nativeId && p.rootPaths.includes(resolve(ROOT, '..'))) ||
    listing.sidebar.projects.find(p => p.nativeId && p.rootPaths.length);
  assert.ok(project);
  const request = { requestId: randomUUID(), title: 'Codex 随行 · 新建与结果验证', projectId: project.id, rootPath: project.rootPaths[0] };
  const created = await device('/threads', request); assert.equal(created.state, 'accepted'); id = created.result.thread.id;
  assert.equal(created.result.thread.projectId, project.id);
  const duplicate = await device('/threads', request); assert.equal(duplicate.result.thread.id, id); assert.equal(duplicate.duplicate, true);
  assert.equal((await device(`/threads/${id}?refresh=1`)).messages.length, 0);
  const { models } = await device('/models'), model = models.find(m => m.id === 'gpt-6-astra') || models.find(m => m.isDefault) || models[0]; assert.ok(model);
  const sent = await device(`/threads/${id}/send`, { requestId: randomUUID(), model: model.id,
    text: '这是独立临时链路验收。只回复：手机新建与结果提醒验证成功。不要调用工具、不要修改文件、不要联系任何其他客户端。' });
  assert.equal(sent.state, 'accepted');
  console.log(JSON.stringify({ stage: 'new-thread-first-message-accepted', testThreadId: id, model: model.id }));
  let detail, activity;
  for (let i = 0; i < 90; i++) {
    detail = await device(`/threads/${id}?refresh=1`);
    activity = (await device('/threads')).threads.find(t => t.id === id)?.activity;
    if (detail.messages.some(m => m.role === 'assistant' && m.text.includes('手机新建与结果提醒验证成功')) &&
        detail.execution?.state === 'completed' && activity?.state === 'completed' && activity.resultKey) break;
    await pause(1000);
  }
  assert.equal(activity?.state, 'completed'); assert.ok(activity.resultAt); assert.ok(activity.resultKey);
  assert.ok(detail.messages.every(m => m.role === 'user' || m.role === 'assistant' && m.phase === 'final_answer'));
  for (let i = 0; i < 15; i++) {
    try { await client.start(); await client.call('thread/archive', { threadId: id }); archived = true; break; }
    catch (error) { if (!/writer|lock/i.test(error.message)) throw error; await pause(1000); }
  }
  assert.equal(archived, true);
  const report = { passed: true, verifiedAt: new Date().toISOString(), origin, deviceId, testThreadId: id, model: model.id, archived,
    activity, checked: ['native-project-create-through-phone-api', 'idempotent-create', 'empty-thread-readable',
      'first-message-model-reply', 'completed-list-status', 'new-result-fingerprint', 'final-only-transcript', 'disposable-thread-archived'] };
  const directory = resolve(ROOT, origin.startsWith('https:') ? 'artifacts/inbox/public' : 'artifacts/inbox');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'flow-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally {
  if (id && !archived) {
    try { await client.start(); await client.call('thread/archive', { threadId: id }); }
    catch (error) { console.error(JSON.stringify({ cleanupRequired: true, testThreadId: id, error: error.message })); }
  }
  client.close(); await api('/api/logout', {}).catch(() => {});
}
