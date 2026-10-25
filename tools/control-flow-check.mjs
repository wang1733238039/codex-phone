// Opt-in real model test; all mutations target one disposable thread only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { CodexClient } from '../src/codex.mjs';
import { ROOT, loadConfig } from '../src/config.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run to make real model calls in a disposable thread.');
const origin = new URL(process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819').origin;
const client = new CodexClient(loadConfig('agent'));
const password = readFileSync(resolve(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }), signal: AbortSignal.timeout(15000) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0], { csrf, primaryDeviceId } = await login.json();
async function api(path, data) {
  const response = await fetch(origin + path, { headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), signal: AbortSignal.timeout(70000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error}`);
  return value;
}
const device = (path, data) => api(`/api/devices/${primaryDeviceId}${path}`, data);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let id, archived = false;
try {
  let status;
  for (let i = 0; i < 30; i++) {
    status = await device('/status');
    if (status.online && status.capabilities?.attachments) break;
    await pause(1000);
  }
  assert.equal(status.online, true); assert.equal(status.activeTurns.length, 0);
  assert.equal(status.capabilities.attachments, true);
  const { models } = await device('/models'); assert.ok(models.length);
  await client.start();
  const started = await client.call('thread/start', { cwd: mkdtempSync(join(tmpdir(), 'phone-control-flow-')),
    baseInstructions: 'You are a disposable connectivity test. Only output the requested text. Never call tools or write files.',
    developerInstructions: 'Connectivity test only. Do not delegate or contact other agents.',
    approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false });
  id = started.thread.id;
  await client.call('thread/name/set', { threadId: id, name: 'Codex 随行 · 模型与追加消息验证' });
  const chosen = models.find(m => m.id === started.model) || models.find(m => m.isDefault) || models[0];
  const effort = chosen.efforts.includes('low') ? 'low' : chosen.defaultEffort;
  let visible = false;
  for (let i = 0; i < 20; i++) {
    if ((await device('/threads')).threads.some(t => t.id === id)) { visible = true; break; }
    await pause(1000);
  }
  assert.equal(visible, true);
  // This independent client holds the native writer, like desktop Codex does.
  // Queue and delete through the actual web API without executing the probe.
  const external = await device(`/threads/${id}/send`, { requestId: randomUUID(), text: '外部写入者排队验证；此消息会立即取消，不应执行。' });
  assert.equal(external.state, 'accepted'); assert.equal(external.result.queued, true);
  const pending = await device(`/threads/${id}?refresh=1`);
  assert.ok(pending.queue.some(q => q.id === external.result.queueId));
  await device(`/threads/${id}/queue-delete`, { queueId: external.result.queueId });
  await assert.rejects(device(`/threads/${id}/send`, { requestId: randomUUID(), text: '此模型切换应被拒绝，不应执行。', model: chosen.id }), /写入|桌面|会话/);
  await client.call('thread/unsubscribe', { threadId: id });
  const exited = once(client.proc, 'exit'); client.close(); await exited;
  const first = await device(`/threads/${id}/send`, { requestId: randomUUID(), model: chosen.id, ...(effort ? { effort } : {}),
    text: '只输出一行：用逗号依次列出1到120，最后加“手机模型验证成功”。不要调用任何工具。' });
  assert.equal(first.state, 'accepted'); assert.equal(first.result.model, chosen.id);
  const steered = await device(`/threads/${id}/send`, { requestId: randomUUID(), mode: 'steer',
    text: '保留原回复要求，在同一行末尾再附加“手机补充验证成功”。这只是补充当前任务，不调用工具。' });
  assert.equal(steered.state, 'accepted'); assert.equal(steered.result.delivery, 'steered');
  const second = await device(`/threads/${id}/send`, { requestId: randomUUID(),
    text: '这是上一轮尚未结束时追加的独立消息。仅回复：手机追加验证成功。不要调用任何工具。' });
  assert.equal(second.state, 'accepted');
  assert.equal(second.result.queued, true, 'The second input must be queued before the first final reply');
  console.log(JSON.stringify({ stage: 'accepted-model-and-queued-input', origin, testThreadId: id, model: chosen.id, effort, queued: true }));
  let detail, complete = false;
  for (let i = 0; i < 120; i++) {
    detail = await device(`/threads/${id}?refresh=1`);
    const finals = detail.messages.filter(m => m.role === 'assistant');
    if (finals.some(m => m.text.includes('手机模型验证成功')) && finals.some(m => m.text.includes('手机补充验证成功')) &&
      finals.some(m => m.text.includes('手机追加验证成功')) &&
      !detail.activeTurns.some(t => t.threadId === id) && detail.execution?.state === 'completed' && !detail.queue?.length) {
      complete = true; break;
    }
    await pause(2000);
  }
  assert.equal(complete, true, `Both final replies must complete; last execution=${detail?.execution?.state}, queued=${detail?.queue?.length}`);
  assert.ok(detail.messages.every(m => m.role === 'user' || m.role === 'assistant' && m.phase === 'final_answer'));
  const interrupted = await device(`/threads/${id}/send`, { requestId: randomUUID(), text: '只输出从1到2000的所有整数，不调用工具。' });
  assert.equal(interrupted.state, 'accepted'); assert.ok(interrupted.result.turnId);
  const live = await device('/status');
  await device(`/threads/${id}/stop`, { turnId: interrupted.result.turnId, connectionId: live.connectionId });
  let stopped = false;
  for (let i = 0; i < 20; i++) {
    detail = await device(`/threads/${id}?refresh=1`);
    if (detail.execution?.state === 'interrupted' && !detail.activeTurns.some(t => t.threadId === id)) { stopped = true; break; }
    await pause(500);
  }
  assert.equal(stopped, true, 'Interrupted tasks must recover without needing a final answer');
  const resumed = await device(`/threads/${id}/send`, { requestId: randomUUID(), text: '仅回复：中断后续聊验证成功。不要调用工具。' });
  assert.equal(resumed.state, 'accepted');
  let recovered = false;
  for (let i = 0; i < 60; i++) {
    detail = await device(`/threads/${id}?refresh=1`);
    if (detail.messages.some(m => m.role === 'assistant' && m.text.includes('中断后续聊验证成功')) && detail.execution?.state === 'completed') { recovered = true; break; }
    await pause(1000);
  }
  assert.equal(recovered, true);
  await client.start();
  for (let i = 0; i < 12; i++) {
    try { await client.call('thread/archive', { threadId: id }); archived = true; break; }
    catch (error) { if (!/writer|lock/i.test(error.message)) throw error; await pause(1000); }
  }
  assert.equal(archived, true);
  const report = { passed: true, verifiedAt: new Date().toISOString(), origin, deviceId: primaryDeviceId, testThreadId: id,
    model: chosen.id, effort, archived, checked: ['live-device-model-list', 'external-writer-native-queue', 'external-writer-queue-visible-and-cancellable',
      'external-writer-model-change-explicitly-rejected', 'explicit-model-and-effort', 'steer-current-owned-turn', 'no-final-required-for-next-input',
      'native-queue-accepted', 'automatic-own-queue-drain', 'both-model-replies', 'interrupted-task-state', 'continue-after-interruption',
      'completed-runtime-state', 'final-only-history', 'test-thread-archived'] };
  const directory = resolve(ROOT, origin.startsWith('https:') ? 'artifacts/public-deploy' : 'artifacts/controls');
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'control-flow-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report));
} finally {
  if (id && !archived) {
    try {
      const status = await device('/status'), turn = status.activeTurns.find(t => t.threadId === id);
      if (turn) await device(`/threads/${id}/stop`, { turnId: turn.turnId, connectionId: status.connectionId });
      const detail = await device(`/threads/${id}?refresh=1`);
      for (const q of detail.queue || []) await device(`/threads/${id}/queue-delete`, { queueId: q.id });
      await pause(2000); await client.start(); await client.call('thread/archive', { threadId: id });
    } catch (error) { console.error(JSON.stringify({ cleanupRequired: true, testThreadId: id, error: error.message })); }
  }
  client.close(); await api('/api/logout', {}).catch(() => {});
}
