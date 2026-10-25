import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LocalSource } from '../src/local-source.mjs';
import { Agent } from '../src/agent.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'phone-source-test-')); mkdirSync(join(home, 'sessions'));
  const id = randomUUID(), path = join(home, 'sessions', '中文会话.jsonl');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER, source TEXT, thread_source TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(id, toNamespacedPath(path), '中文会话', home, 1, 'cli', 'user');
  return { home, id, path, db, clean: () => { db.close(); rmSync(home, { recursive: true, force: true }); } };
}
test('read-only history selects visible events, ignores incomplete lines, refreshes cache', async t => {
  const f = fixture(t); const e = (type, payload) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  writeFileSync(f.path, [e('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>internal instruction</environment_context>' }] }), e('event_msg', { type: 'task_started' }), e('event_msg', { type: 'user_message', message: '你好' }), e('event_msg', { type: 'agent_message', message: '收到', phase: 'final_answer' }), '{incomplete'].join('\n'), 'utf8');
  const source = new LocalSource(f.home); t.after(() => { source.close(); f.clean(); });
  assert.equal(source.list()[0].local, true);
  let detail = await source.detail(f.id); assert.equal(detail.running, true); assert.deepEqual(detail.messages.map(m => m.text), ['你好', '收到']);
  appendFileSync(f.path, '\n' + e('event_msg', { type: 'task_complete' }) + '\n', 'utf8');
  detail = await source.detail(f.id); assert.equal(detail.running, false);
  const cached = source.cache.get(f.id); cached.detail = { ...cached.detail, running: true }; cached.cachedAt -= 2000;
  detail = await source.detail(f.id); assert.equal(detail.running, false);
  await assert.rejects(source.detail('../../auth.json'), /Invalid/);
  f.db.prepare('UPDATE threads SET rollout_path=?').run(join(f.home, 'outside.jsonl')); writeFileSync(join(f.home, 'outside.jsonl'), '{}', 'utf8');
  await assert.rejects(source.detail(f.id), /outside/);
});

test('project lists exclude exec jobs, unknown sources and child threads from interactive history', t => {
  const f = fixture(t);
  const project = { id: 'visible-project', name: '开发岗位常用技能', rootPaths: [f.home] };
  writeFileSync(join(f.home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { [project.id]: project },
    'thread-project-assignments': { [f.id]: { projectKind: 'local', projectId: project.id } },
  }), 'utf8');
  f.db.prepare('UPDATE threads SET source=? WHERE id=?').run('vscode', f.id);
  const insert = f.db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
  for (let i = 0; i < 12; i++) insert.run(randomUUID(), f.path, '后台执行任务', join(f.home, 'runtime', 'jobs', String(i)), 2, 'exec', 'user');
  for (const source of ['unknown', 'appServer', JSON.stringify({subagent:{other:'guardian'}})]) {
    insert.run(randomUUID(), f.path, '内部记录', f.home, 2, source, 'user');
  }
  insert.run(randomUUID(), f.path, '子会话', f.home, 2, 'vscode', 'subAgent');
  const source = new LocalSource(f.home);
  t.after(() => { source.close(); f.clean(); });
  const snapshot = source.snapshot();
  assert.deepEqual(snapshot.threads.map(t => t.id), [f.id]);
  assert.equal(snapshot.threads[0].projectId, project.id);
  const cliId = randomUUID();
  insert.run(cliId, f.path, '交互式 CLI 对话', f.home, 3, 'cli', 'user');
  assert.deepEqual(source.list().map(t => t.id), [cliId, f.id]);
});

test('agent refuses archived sessions, simultaneous submissions and unowned stops', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true }); t.after(() => { agent.close(); f.clean(); });
  await assert.rejects(agent.handle('stop', { threadId: f.id }), /只能停止/);
  f.db.prepare('UPDATE threads SET archived=1').run(); await assert.rejects(agent.handle('send', { threadId: f.id, text: 'test' }), /归档/);
  f.db.prepare('UPDATE threads SET archived=0').run();
  let finish; agent.codex.start = () => new Promise(resolve => { finish = resolve; }); agent.codex.call = async method => method === 'turn/start' ? { turn: { id: 'turn', status: 'inProgress' } } : {};
  const first = agent.handle('send', { threadId: f.id, text: 'test' });
  while (!finish) await new Promise(r => setTimeout(r, 1));
  await assert.rejects(agent.handle('send', { threadId: f.id, text: 'again' }), /提交/); finish(); await first;
  assert.equal(agent.active.get(f.id), 'turn');
  let interrupted;
  agent.codex.call = async (method, params) => { interrupted = { method, params }; return {}; };
  await agent.handle('stop', { threadId: f.id });
  assert.deepEqual(interrupted, { method: 'turn/interrupt', params: { threadId: f.id, turnId: 'turn' } });
  agent.onCodex({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: f.id, command: 'echo test' } });
  let response; agent.codex.respond = (id, result) => { response = { id, result }; };
  const approvalId = [...agent.approvals.keys()][0];
  await assert.rejects(agent.handle('approve', { id: approvalId, threadId: randomUUID(), decision: 'decline' }), /审批/);
  await agent.handle('approve', { id: approvalId, threadId: f.id, decision: 'decline' }); assert.deepEqual(response, { id: 4, result: { decision: 'decline' } });
  await assert.rejects(agent.handle('stop', { threadId: f.id, turnId: 'old-turn' }), /已结束/);
});

test('new threads use a verified native project without overriding permission or model settings', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); });
  agent.source.snapshot = () => ({ threads: [], sidebar: { projects: [{ id: 'desktop-project', nativeId: 'native-project', name: '项目', rootPaths: [f.home] }] } });
  const calls = [], id = randomUUID(); agent.codex.start = async () => {};
  agent.codex.call = async (method, params) => { calls.push({ method, params }); return method === 'thread/start' ? { thread: { id } } : {}; };
  const created = await agent.handle('create-thread', { projectId: 'desktop-project', rootPath: f.home, title: '手机测试' });
  assert.equal(created.thread.id, id); assert.equal(created.thread.projectId, 'desktop-project');
  assert.deepEqual(calls[0], { method: 'thread/start', params: { cwd: f.home, ephemeral: false, projectId: 'native-project' } });
  assert.equal(calls.at(-1).method, 'thread/unsubscribe');
  const before = calls.length;
  await assert.rejects(agent.handle('create-thread', { projectId: 'desktop-project', rootPath: 'C:\\not-a-project', title: '' }), /目录/);
  await assert.rejects(agent.handle('create-thread', { projectId: 'missing', title: '' }), /不存在/);
  await assert.rejects(agent.handle('create-thread', { rootPath: f.home, title: '' }), /任意目录/);
  assert.equal(calls.length, before);
  agent.config.controlsEnabled = false;
  await assert.rejects(agent.handle('create-thread', { title: '' }), /权限/);
});

test('agent queues phone input when the desktop owns the thread writer', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); });
  const calls = [];
  agent.codex.start = async () => {};
  agent.codex.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume') throw new Error(`thread ${f.id} already has an active writer`);
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queued-1' } };
    throw new Error(`unexpected ${method}`);
  };
  const result = await agent.handle('send', { threadId: f.id, text: '手机排队测试', requestId: randomUUID() });
  assert.equal(result.queued, true); assert.equal(result.queueId, 'queued-1'); assert.equal(result.delivery, 'queued');
  assert.deepEqual(calls.map(call => call.method), ['thread/resume', 'thread/queue/add']);
  assert.equal(calls[1].params.input[0].text, '手机排队测试');
  assert.equal(calls[1].params.input[0].type, 'text');
});

test('a stale task_started log never blocks a new Codex turn or requires a final answer', async t => {
  const f = fixture(t); writeFileSync(f.path, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }) + '\n', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); });
  assert.equal((await agent.source.detail(f.id)).running, true);
  const calls = []; agent.codex.start = async () => {};
  agent.codex.call = async (method, params) => { calls.push({ method, params }); return method === 'turn/start' ? { turn: { id: 'new-turn', status: 'inProgress' } } : {}; };
  const result = await agent.handle('send', { threadId: f.id, text: '继续', requestId: randomUUID() });
  assert.equal(result.delivery, 'started'); assert.equal(agent.active.get(f.id), 'new-turn');
  assert.deepEqual(calls.map(c => c.method), ['thread/resume', 'thread/queue/list', 'turn/start']);
});

test('desktop writer never silently queues a requested model change or a steer as a different operation', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); });
  const calls = []; agent.codex.start = async () => {};
  agent.codex.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'model/list') return { data: [{ model: 'actual-model', supportedReasoningEfforts: [] }] };
    if (method === 'thread/resume') throw new Error('thread already has an active writer');
    throw new Error(`Unexpected operation: ${method}`);
  };
  await assert.rejects(agent.handle('send', { threadId: f.id, text: '使用新模型', model: 'actual-model' }), /active writer/);
  await assert.rejects(agent.handle('send', { threadId: f.id, text: '补充', mode: 'steer' }), /本轮已结束或不由/);
  assert.equal(calls.some(c => ['thread/queue/add', 'turn/start', 'turn/steer'].includes(c.method)), false);
});

test('active phone tasks accept both queued next input and explicit steer with turn precondition', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); }); agent.active.set(f.id, 'active-turn');
  const calls = []; agent.codex.start = async () => {};
  agent.codex.call = async (method, params) => { calls.push({ method, params }); return method === 'thread/queue/add' ? { queuedSubmission: { id: 'q-2' } } : { turnId: 'active-turn' }; };
  const result = await agent.handle('send', { threadId: f.id, text: '下一条', requestId: randomUUID() });
  assert.equal(result.queued, true); assert.ok(agent.queuedHere.get(f.id).has('q-2'));
  const steer = await agent.handle('send', { threadId: f.id, text: '补充', requestId: randomUUID(), mode: 'steer' });
  assert.equal(steer.delivery, 'steered'); assert.equal(calls.at(-1).params.expectedTurnId, 'active-turn');
});

test('model choices and efforts come from the local runtime and are validated before starting input', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); });
  const calls = []; agent.codex.start = async () => {};
  agent.codex.call = async (method, params) => { calls.push({ method, params }); return method === 'model/list'
    ? { data: [{ id: 'actual-model', model: 'actual-model', displayName: '本机模型', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
    : method === 'turn/start' ? { turn: { id: 't', status: 'inProgress' } } : {}; };
  const models = await agent.handle('models', {}); assert.equal(models.models[0].name, '本机模型');
  await assert.rejects(agent.handle('send', { threadId: f.id, text: 'x', model: 'invented' }), /未提供/);
  await assert.rejects(agent.handle('send', { threadId: f.id, text: 'x', model: 'actual-model', effort: 'ultra' }), /未提供/);
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 0);
  await agent.handle('send', { threadId: f.id, text: 'x', model: 'actual-model', effort: 'high' });
  assert.equal(calls.at(-1).params.model, 'actual-model'); assert.equal(calls.at(-1).params.effort, 'high');
});

test('missed completion notifications reconcile to idle without a final response', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); }); agent.active.set(f.id, 'stale-turn');
  agent.codex.start = async () => {};
  agent.codex.call = async method => method === 'thread/read' ? { thread: { status: { type: 'idle' }, model: 'actual' } } : { data: [] };
  const detail = await agent.handle('detail', { threadId: f.id });
  assert.equal(detail.messages.length, 0); assert.equal(agent.active.has(f.id), false);
  assert.equal(detail.execution.verified, true); assert.notEqual(detail.execution.state, 'running');
});

test('queue draining starts only a message submitted here and never somebody else at the head', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); });
  agent.codex.start = async () => {}; agent.queuedHere.set(f.id, new Set(['ours']));
  let head = 'other'; const calls = [];
  agent.codex.call = async (method, params) => { calls.push({ method, params }); return method === 'thread/queue/list'
    ? { data: [{ id: head }] } : { turn: { id: 'next', status: 'inProgress' } }; };
  await agent.drainQueue(f.id); assert.equal(calls.some(c => c.method === 'thread/queue/start'), false);
  head = 'ours'; await agent.drainQueue(f.id);
  assert.equal(calls.at(-1).params.queuedSubmissionId, 'ours'); assert.equal(agent.active.get(f.id), 'next');
});

test('new input cannot overtake an existing queue after a turn completes', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); }); agent.codex.start = async () => {};
  const calls = [];
  agent.codex.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/queue/list') return { data: [{ id: 'earlier' }] };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'newer' } };
    return {};
  };
  const result = await agent.handle('send', { threadId: f.id, text: '较晚提交的消息', requestId: randomUUID() });
  assert.equal(result.queued, true); assert.equal(agent.queuedHere.get(f.id).has('newer'), true);
  assert.equal(calls.some(c => c.method === 'turn/start'), false);
  await agent.drainQueue(f.id);
  assert.equal(calls.some(c => c.method === 'thread/queue/start'), false, 'another owner queue item remains first');
});
test('native images and file paths survive attachment-only start, desktop queue and owned-turn steer', async t => {
  const f = fixture(t); writeFileSync(f.path, '', 'utf8');
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); f.clean(); });
  const attachment = { id: randomUUID(), name: '中文图片.png', size: 10, kind: 'image', path: join(f.home, '中文图片.png') };
  agent.attachments.selected = async (thread, items) => { assert.equal(thread, f.id); assert.equal(items[0].id, attachment.id); return [attachment]; };
  agent.codex.start = async () => {}; let locked = false; const calls = [];
  agent.codex.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume' && locked) throw new Error('active writer');
    if (method === 'thread/queue/add') return { queuedSubmission: { id: randomUUID() } };
    if (method === 'turn/start') return { turn: { id: 'owned', status: 'inProgress' } };
    return { data: [] };
  };
  const data = { threadId: f.id, text: '', attachments: [attachment], requestId: randomUUID() };
  await agent.handle('send', data);
  assert.equal(calls.at(-1).params.input[1].type, 'localImage'); assert.equal(calls.at(-1).params.input[1].path, attachment.path);
  await agent.handle('send', { ...data, mode: 'steer', requestId: randomUUID() });
  assert.equal(calls.at(-1).method, 'turn/steer'); assert.equal(calls.at(-1).params.input[1].path, attachment.path);
  agent.active.clear(); locked = true;
  await agent.handle('send', { ...data, requestId: randomUUID() });
  assert.equal(calls.at(-1).method, 'thread/queue/add'); assert.equal(calls.at(-1).params.input[1].path, attachment.path);
});
