import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { PhoneChildren } from '../src/phone-children.mjs';
import { LocalSource } from '../src/local-source.mjs';
import { Agent } from '../src/agent.mjs';

test('phone-created native forks retain a verified family after reconnect and omit inherited transcript', async t => {
  const home = mkdtempSync(join(tmpdir(), 'phone-linked-child-')), parent = randomUUID(), child = randomUUID(), unrelated = randomUUID();
  mkdirSync(join(home, 'sessions'));
  const path = join(home, 'sessions', 'child.jsonl'), parentPath = join(home, 'sessions', 'parent.jsonl');
  const entry = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
  writeFileSync(parentPath, entry('session_meta', { id: parent }), 'utf8');
  writeFileSync(path, entry('session_meta', { id: child, forked_from_id: parent }) +
    entry('event_msg', { type: 'user_message', message: 'inherited parent input' }) +
    entry('event_msg', { type: 'task_complete', last_agent_message: 'inherited parent answer' }), 'utf8');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,cwd TEXT,source TEXT,updated_at INTEGER,archived INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,1,0)');
  insert.run(parent, parentPath, 'parent', home, 'vscode');
  insert.run(child, path, 'child', home, 'vscode');
  insert.run(unrelated, parentPath, 'unrelated', home, 'vscode');
  let source = new LocalSource(home);
  t.after(() => { source.close(); db.close(); rmSync(home, { recursive: true, force: true }); });
  assert.equal(source.snapshot().childThreads.length, 0, 'ordinary forks stay ordinary unless created here');
  assert.ok(source.snapshot().threads.find(row => row.id === child).activity.resultKey);
  assert.equal((await source.detail(child)).messages[0].text, 'inherited parent input');
  source.registerChild(child, parent);
  assert.equal(source.snapshot().childThreads[0].activity.resultKey, '', 'copied parent replies are never unread child results');
  assert.equal((await source.detail(child)).messages.length, 0, 'registration invalidates any earlier ordinary-fork transcript cache');
  appendFileSync(path, entry('event_msg', { type: 'user_message', message: 'child input' }) +
    entry('event_msg', { type: 'agent_message', phase: 'commentary', message: 'hidden progress' }) +
    entry('event_msg', { type: 'task_complete', last_agent_message: 'child answer' }), 'utf8');
  source.close(); source = new LocalSource(home);
  assert.deepEqual(source.snapshot().threads.map(row => row.id).sort(), [parent, unrelated].sort());
  assert.equal(source.snapshot().childThreads[0].parentThreadId, parent);
  assert.equal(source.isChild(source.row(child)), true);
  assert.deepEqual((await source.detail(child)).messages.map(message => message.text), ['child input', 'child answer']);
  const registry = new PhoneChildren(home);
  assert.throws(() => registry.register(source.row(unrelated), parent), /核验/);
  const entries = registry.entries(); entries[0].parentId = unrelated;
  writeFileSync(registry.path, JSON.stringify({ version: 1, children: entries }), 'utf8');
  assert.equal(source.snapshot().childThreads.length, 0, 'forged relationships fail native metadata verification');
});

function fixture(reject) {
  const parent = randomUUID(), id = randomUUID(), calls = [], agent = Object.create(Agent.prototype);
  let registered = false;
  Object.assign(agent, { config: { controlsEnabled: true }, inflight: new Set(), reading: 0,
    source: { row: () => ({ id: parent }), isLocal: () => true, isChild: () => false,
      registerChild: (child, ancestor) => { assert.equal(child, id); assert.equal(ancestor, parent); registered = true; },
      snapshot: () => ({ childThreads: registered ? [{ id, parentThreadId: parent, local: true }] : [] }) },
    codex: { start: async () => {}, call: async (method, data) => {
      calls.push({ method, data });
      if (method === 'thread/fork') {
        if (data.attachToSource) throw reject;
        return { thread: { id } };
      }
      return {};
    } }, snapshot: () => {}, changed: () => {}, releaseWhenIdle: () => {} });
  return { agent, parent, id, calls };
}
test('explicit parent writer rejection creates exactly one native fork without touching the parent task', async () => {
  const { agent, parent, id, calls } = fixture(new Error('thread already has an active writer'));
  const result = await agent.createThread({ title: 'child', parentThreadId: parent });
  assert.equal(result.thread.id, id);
  assert.deepEqual(calls.filter(call => call.method === 'thread/fork').map(call => call.data.attachToSource), [true, false]);
  assert.ok(!calls.some(call => ['thread/resume', 'turn/start', 'turn/interrupt', 'thread/start'].includes(call.method)));
});
test('uncertain creation and unrelated errors never trigger a second fork', async () => {
  for (const error of [Object.assign(new Error('active writer'), { uncertain: true }), new Error('unsupported history')]) {
    const { agent, parent, calls } = fixture(error);
    await assert.rejects(agent.createThread({ title: 'child', parentThreadId: parent }));
    assert.equal(calls.filter(call => call.method === 'thread/fork').length, 1);
  }
});
