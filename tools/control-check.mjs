// Explicit, opt-in integration check: creates one disposable local conversation and makes one model call.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexClient } from '../src/codex.mjs';
import { once } from 'node:events';
import { ROOT, loadConfig } from '../src/config.mjs';
if (!process.argv.includes('--run')) throw new Error('This check makes a real model call. Pass --run to execute.');
let client = new CodexClient(loadConfig('agent'));
const origin = new URL(process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819').origin;
const scratch = mkdtempSync(join(tmpdir(), 'codex-phone-connectivity-'));
const password = readFileSync(resolve(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
if (!login.ok) throw new Error(`Login failed: ${login.status}`);
const cookie = login.headers.get('set-cookie').split(';')[0], { csrf, primaryDeviceId } = await login.json();
async function api(path, data) { const res = await fetch(origin + path, { headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}) }); const value = await res.json(); if (!res.ok) throw new Error(`${res.status}: ${value.error}`); return value; }
const deviceApi = (path, data) => api(`/api/devices/${primaryDeviceId}${path}`, data);
let id, completed = false;
try {
  const status = await deviceApi('/status');
  if (!status.online || status.activeTurns.length) throw new Error('Primary computer is offline or already executing phone tasks');
  await client.start();
  const started = await client.call('thread/start', { cwd: scratch, baseInstructions: 'You are a connectivity test. Reply with the exact requested text. Never use tools, write files, or delegate.', developerInstructions: 'This is a disposable connectivity test. Only output the requested short text.', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false });
  id = started.thread.id;
  await client.call('thread/name/set', { threadId: id, name: 'Codex 随行 · 连通性验证' });
  await client.call('thread/unsubscribe', { threadId: id });
  const exited = once(client.proc, 'exit'); client.close(); await exited;
  client = new CodexClient(loadConfig('agent')); await client.start();
  console.log(JSON.stringify({ stage: 'test-thread-created', id }));
  let visible = false;
  for (let i = 0; i < 20; i++) { const list = await deviceApi('/threads'); if (list.threads.some(t => t.id === id)) { visible = true; break; } await new Promise(r => setTimeout(r, 1000)); }
  if (!visible) throw new Error('Test thread did not appear in the local index');
  const send = await deviceApi(`/threads/${id}/send`, { text: '仅回复：手机连接验证成功。不要调用任何工具。', requestId: randomUUID() });
  console.log(JSON.stringify({ stage: 'phone-send', state: send.state, turnId: send.result?.turnId }));
  if (send.state !== 'accepted') throw new Error('Phone send was not accepted');
  for (let i = 0; i < 60; i++) {
    const d = await deviceApi(`/threads/${id}?refresh=1`);
    const assistant = d.messages.filter(m => m.role === 'assistant');
    if (assistant.some(m => m.text.includes('手机连接验证成功')) && !d.running && !d.activeTurns.some(t => t.threadId === id)) { completed = true; break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!completed) throw new Error('No completed model response observed within two minutes');
  let archived = false;
  for (let i = 0; i < 12; i++) { try { await client.call('thread/archive', { threadId: id }); archived = true; break; } catch (error) { if (!/writer|lock/i.test(error.message)) throw error; await new Promise(r => setTimeout(r, 1000)); } }
  if (!archived) throw new Error('Completed test thread still has a writer lock');
  const report = { passed: true, origin, verifiedAt: new Date().toISOString(), deviceId: primaryDeviceId, testThreadId: id, modelReplyMatched: true, archived: true, checked: ['thread-start', 'device-scoped-thread-resume', 'device-scoped-web-send', 'relay-provider-model-response', 'history-refresh', 'completion', 'archive-test-thread'] };
  const reportDirectory = resolve(ROOT, origin.startsWith('https:') ? 'artifacts/public-deploy' : 'artifacts');
  mkdirSync(reportDirectory, { recursive: true }); writeFileSync(resolve(reportDirectory, 'multi-device-control-report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.message);
  if (id) {
    try { const s = await deviceApi('/status'), turn = s.activeTurns.find(t => t.threadId === id);
      if (turn) await deviceApi(`/threads/${id}/stop`, { turnId: turn.turnId, connectionId: s.connectionId });
    } catch {}
    try { await client.start(); await client.call('thread/archive', { threadId: id }); } catch {}
  }
  process.exitCode = 1;
} finally { client.close(); await api('/api/logout', {}).catch(() => {}); }
