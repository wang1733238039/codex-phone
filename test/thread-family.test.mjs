import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localFamily, linkChildren } from '../src/thread-family.mjs';
import { LocalSource } from '../src/local-source.mjs';
import { Agent } from '../src/agent.mjs';
import { Transcript } from '../src/transcript.mjs';
import { Store } from '../src/store.mjs';

test('explicit child relationships support nested agents and exclude internal, orphan and circular histories', () => {
  const root = { id: randomUUID(), source: 'vscode', thread_source: 'user' }, childId = randomUUID(), nestedId = randomUUID();
  const orphanId = randomUUID(), a = randomUUID(), b = randomUUID(), guardianId = randomUUID(), legacyId = randomUUID();
  const spawn = (id, parent) => ({ id, source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent } } }), thread_source: 'subagent' });
  const result = localFamily([root, spawn(childId, root.id), spawn(nestedId, childId), spawn(orphanId, randomUUID()),
    spawn(a, b), spawn(b, a), { id: guardianId, source: JSON.stringify({ subagent: { other: 'guardian' } }) },
    { id: legacyId, source: 'vscode', thread_source: 'subAgent' },
    { id: randomUUID(), source: 'exec' }, { id: randomUUID(), source: 'unknown' }],
  [{ parent_thread_id: root.id, child_thread_id: guardianId }, { parent_thread_id: root.id, child_thread_id: legacyId }]);
  assert.deepEqual(result.roots.map(r => r.id), [root.id]);
  assert.deepEqual(result.children.map(c => [c.id, c.rootThreadId, c.depth]), [[childId, root.id, 1], [nestedId, root.id, 2], [legacyId, root.id, 1]]);
  assert.ok(result.children.every(c => c.readOnly));
});

test('server resolves ancestry itself and keeps families separate for each account and device', t => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-family-store-')), store = new Store(join(dir, 'cache.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const root = { id: randomUUID() }, child = { id: randomUUID(), parentThreadId: root.id, rootThreadId: 'forged', readOnly: false };
  const deviceA = store.primaryDeviceId, deviceB = randomUUID(), other = store.forOwner('other');
  store.snapshot([root], null, deviceA, [child]);
  assert.equal(store.family(child.id, deviceA).rootId, root.id);
  assert.equal(store.thread(child.id, deviceA).readOnly, true);
  assert.equal(store.thread(root.id, deviceA).childCount, 1);
  assert.equal(store.family(child.id, deviceB), null); assert.equal(other.family(child.id, deviceA), null);
  store.snapshot([{ id: randomUUID() }], null, deviceB, [child]);
  assert.equal(store.family(child.id, deviceB), null);
  store.snapshot([root], null, deviceA);
  assert.equal(store.family(root.id, deviceA).threads.length, 1);
  assert.equal(store.thread(child.id, deviceA), null, 'older connector snapshots remove stale child access');
  assert.deepEqual(linkChildren([root], [{ id: root.id, parentThreadId: root.id }]), []);
});

test('child projection omits inherited parent history and all intermediate/tool content', () => {
  const id = randomUUID(), transcript = new Transcript({ childThreadId: id });
  const raw = (role, text, phase = 'final_answer', ordinal = 0) => ({ type: 'response_item', ordinal,
    payload: { type: 'message', role, phase, content: [{ type: 'text', text }] } });
  transcript.push({ type: 'session_meta', payload: { id: randomUUID() } });
  transcript.push(raw('user', 'parent input'));
  transcript.push(raw('assistant', 'parent final'));
  transcript.push({ type: 'session_meta', payload: { id, subagent_history_start_ordinal: 100 } });
  transcript.push(raw('assistant', 'inherited after metadata', 'final_answer', 50));
  transcript.push(raw('developer', 'private task', undefined, 101));
  transcript.push(raw('user', 'child task', undefined, 102));
  transcript.push(raw('assistant', 'private progress', 'commentary', 103));
  transcript.push({ type: 'response_item', ordinal: 104, payload: { type: 'function_call_output', output: 'secret tool' } });
  transcript.push(raw('assistant', 'child result', 'final_answer', 105));
  assert.deepEqual(transcript.finish().messages.map(m => m.text), ['child task', 'child result']);
  const missingMeta = new Transcript({ childThreadId: id }); missingMeta.push(raw('assistant', 'unverified ancestor'));
  assert.equal(missingMeta.finish().messages.length, 0);
});

test('local snapshots carry readable child details separately, and controls never touch a child runtime', async t => {
  const home = mkdtempSync(join(tmpdir(), 'phone-child-local-')); mkdirSync(join(home, 'sessions'));
  const db = new DatabaseSync(join(home, 'state_5.sqlite')), rootId = randomUUID(), id = randomUUID(), file = join(home, 'sessions', '子对话.jsonl');
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,cwd TEXT,source TEXT,thread_source TEXT,updated_at INTEGER,archived INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,1,0)');
  insert.run(rootId, file, '主对话', home, 'vscode', 'user');
  insert.run(id, file, '子对话', home, 'vscode', 'subagent');
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run(rootId, id, 'open');
  const lines = [
    { type: 'session_meta', payload: { id } },
    { type: 'event_msg', payload: { type: 'user_message', message: '检查接口' } },
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: '接口已检查' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(entry => JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const source = new LocalSource(home), agent = new Agent({ codexHome: home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  t.after(() => { agent.close(); source.close(); db.close(); rmSync(home, { recursive: true, force: true }); });
  const snapshot = source.snapshot();
  assert.deepEqual(snapshot.threads.map(r => r.id), [rootId]); assert.equal(snapshot.threads[0].childCount, 1);
  assert.equal(snapshot.childThreads[0].rootThreadId, rootId);
  assert.equal(snapshot.childThreads[0].projectId, snapshot.threads[0].projectId);
  db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(id);
  const detail = await agent.handle('detail', { threadId: id });
  assert.deepEqual(detail.messages.map(m => m.text), ['检查接口', '接口已检查']); assert.equal(detail.readOnly, true);
  agent.codex.start = async () => { assert.fail('child must not open a runtime'); };
  for (const action of ['send', 'stop', 'queue-start', 'queue-delete', 'attachment-start', 'attachment-chunk', 'attachment-finish']) {
    await assert.rejects(agent.handle(action, { threadId: id, text: 'test' }), /不可操作/);
  }
  await assert.rejects(agent.handle('approve', { id: 'desktop:test', threadId: id, decision: 'accept' }), /不可操作/);
  agent.approvals.set('test', { public: { threadId: id }, rpcId: 1 });
  await assert.rejects(agent.handle('approve', { id: 'test', decision: 'accept' }), /不可操作/);
});

test('local active children can be controlled, while missing histories and archived children remain read only', () => {
  const root = { id: randomUUID() }, base = { parentThreadId: root.id, local: true, historyAvailable: true };
  const children = linkChildren([root], [{ ...base, id: randomUUID() }, { ...base, id: randomUUID(), historyAvailable: false }, { ...base, id: randomUUID(), archived: true }]);
  assert.deepEqual(children.map(t => t.readOnly), [false, true, true]);
});

test('new child uses native attached fork, never resumes parent, and validates persisted relationship', async () => {
  const parentId = randomUUID(), childId = randomUUID(), calls = [];
  const child = { id: childId, parentThreadId: parentId, local: true };
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, { config: { controlsEnabled: true }, inflight: new Set(), reading: 0,
    source: { row: () => ({ id: parentId }), isLocal: () => true, isChild: () => false, snapshot: () => ({ childThreads: [child] }) },
    codex: { start: async () => {}, call: async (method, data) => { calls.push({ method, data }); return method === 'thread/fork' ? { thread: { id: childId } } : {}; } },
    snapshot: () => {}, changed: () => {}, releaseWhenIdle: () => {} });
  const result = await agent.createThread({ title: '检查接口', parentThreadId: parentId });
  assert.equal(result.thread.id, childId);
  assert.deepEqual(calls[0], { method: 'thread/fork', data: { threadId: parentId, attachToSource: true, excludeTurns: true, ephemeral: false } });
  assert.ok(!calls.some(c => ['thread/resume', 'turn/start', 'thread/start'].includes(c.method)));
  agent.source.snapshot = () => ({ childThreads: [] });
  await assert.rejects(agent.createThread({ title: '', parentThreadId: parentId }), e => e.uncertain === true);
});
