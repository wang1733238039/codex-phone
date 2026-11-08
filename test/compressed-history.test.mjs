import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { LocalSource } from '../src/local-source.mjs';
import { Agent } from '../src/agent.mjs';
import { resolveRollout, rolloutLines } from '../src/rollout.mjs';

const entry = (type, payload, ms = 0) => JSON.stringify({
  type, payload, timestamp: new Date(1793924793000 + ms).toISOString(),
}) + '\n';
const turn = (text = '中文输入', reply = '中文结果✅', turnId = 'turn-1') =>
  entry('event_msg', { type: 'task_started', turn_id: turnId }) +
  entry('event_msg', { type: 'user_message', message: text }, 1) +
  entry('event_msg', { type: 'agent_message', phase: 'commentary', message: '不显示的进度' }, 2) +
  entry('response_item', { type: 'function_call_output', output: 'private tool data' }, 3) +
  entry('event_msg', { type: 'agent_message', phase: 'final_answer', message: reply }, 4) +
  entry('event_msg', { type: 'task_complete', last_agent_message: reply }, 5);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'phone-compressed-')), id = randomUUID();
  mkdirSync(join(home, 'sessions')); mkdirSync(join(home, 'archived_sessions'));
  const path = join(home, 'sessions', '中文历史.jsonl');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,cwd TEXT,source TEXT,updated_at INTEGER,archived INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,1,0)');
  insert.run(id, path, '中文会话', home, 'vscode');
  const source = new LocalSource(home);
  const cleanup = [];
  t.after(() => { for (const close of cleanup) close(); source.close(); db.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, id, path, db, insert, source, cleanup };
}

test('compression preserves visible history, completion, unread key and local send eligibility', async t => {
  const f = fixture(t);
  writeFileSync(f.path, turn(), 'utf8');
  const before = await f.source.detail(f.id), activity = f.source.list()[0].activity;
  writeFileSync(f.path + '.zst', zstdCompressSync(readFileSync(f.path))); unlinkSync(f.path);
  const after = await f.source.detail(f.id), row = f.source.list()[0];
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.messages.map(m => m.text), ['中文输入', '中文结果✅']);
  assert.equal(row.local, true); assert.deepEqual(row.activity, activity);
  assert.equal(row.activity.state, 'completed'); assert.equal(after.running, false);
  const agent = new Agent({ codexHome: f.home, serverUrl: 'http://127.0.0.1:1', agentToken: 'test', controlsEnabled: true });
  f.cleanup.push(() => agent.close());
  const calls = []; agent.codex.start = async () => {}; agent.desktop.read = async () => null;
  agent.codex.call = async (method, params) => {
    calls.push({ method, params });
    return method === 'turn/start' ? { turn: { id: 'new-turn', status: 'inProgress' } } : {};
  };
  assert.equal((await agent.handle('send', { threadId: f.id, text: '继续', requestId: randomUUID() })).delivery, 'started');
  assert.deepEqual(calls.map(c => c.method), ['thread/resume', 'thread/queue/list', 'turn/start']);
  assert.equal(calls[2].params.input[0].text, '继续');
});

test('a live plain rollout takes precedence over its older compressed sibling and invalidates cache', async t => {
  const f = fixture(t);
  writeFileSync(f.path + '.zst', zstdCompressSync(turn('旧问题', '旧答案')));
  assert.equal((await f.source.detail(f.id)).messages.at(-1).text, '旧答案');
  writeFileSync(f.path, turn('新问题', '新答案'), 'utf8');
  assert.equal((await f.source.detail(f.id)).messages.at(-1).text, '新答案');
  assert.equal(resolveRollout(f.source.home, f.path).compressed, false);
  assert.equal(f.source.list()[0].activity.state, 'completed');
});

test('indexed compressed paths and archived compressed histories are readable without changing Codex data', async t => {
  const f = fixture(t), archived = join(f.home, 'archived_sessions', '历史.jsonl.zst');
  writeFileSync(archived, zstdCompressSync(turn()));
  f.db.prepare('UPDATE threads SET rollout_path=?,archived=1').run(archived);
  const bytes = readFileSync(archived);
  assert.equal((await f.source.detail(f.id)).messages.length, 2);
  assert.deepEqual(readFileSync(archived), bytes);
  assert.equal(f.source.list()[0].archived, true);
});

test('compressed native child verification preserves byte-based exclusion of inherited parent messages', async t => {
  const f = fixture(t), child = randomUUID(), childPath = join(f.home, 'sessions', 'child.jsonl');
  writeFileSync(f.path, entry('session_meta', { id: f.id }), 'utf8');
  const inherited = entry('session_meta', { id: child, forked_from_id: f.id }) + turn('父输入', '父输出');
  writeFileSync(childPath, inherited, 'utf8'); f.insert.run(child, childPath, '子对话', f.home, 'vscode');
  f.source.registerChild(child, f.id);
  writeFileSync(childPath + '.zst', zstdCompressSync(inherited + turn('子输入', '子输出', 'child-turn')));
  unlinkSync(childPath);
  const childRow = f.source.snapshot().childThreads.find(c => c.id === child);
  assert.equal(childRow.parentThreadId, f.id); assert.equal(childRow.readOnly, false);
  assert.equal(childRow.historyAvailable, true); assert.equal(childRow.activity.state, 'completed');
  assert.deepEqual((await f.source.detail(child)).messages.map(m => m.text), ['子输入', '子输出']);
});

test('corrupt compressed data fails reading and never becomes a completed status', async t => {
  const f = fixture(t);
  writeFileSync(f.path + '.zst', Buffer.from('invalid zstd'));
  assert.equal(f.source.list()[0].activity.state, 'unknown');
  await assert.rejects(f.source.detail(f.id));
  f.db.prepare('UPDATE threads SET rollout_path=?').run(join(f.home, 'sessions', 'missing.jsonl'));
  assert.equal(f.source.list()[0].local, false);
  await assert.rejects(f.source.detail(f.id), /不在此电脑/);
});

test('decompressed byte limits and rewritten child offsets fail safely', async t => {
  const f = fixture(t);
  writeFileSync(f.path + '.zst', zstdCompressSync('x'.repeat(20000)));
  const storage = resolveRollout(realpathSync.native(f.home), f.path);
  const consume = async options => { for await (const line of rolloutLines(storage, options)) void line; };
  await assert.rejects(consume({ maximum: 1024 }), /大小限制/);
  await assert.rejects(consume({ start: 20001 }), /重写/);
});

test('compressed sibling lookup cannot escape the session directories through a directory link', async t => {
  const f = fixture(t), outsideDirectory = join(f.home, 'outside'), link = join(f.home, 'sessions', 'linked');
  mkdirSync(outsideDirectory);
  const outside = join(outsideDirectory, 'outside.jsonl.zst');
  writeFileSync(outside, zstdCompressSync(turn()));
  symlinkSync(outsideDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.db.prepare('UPDATE threads SET rollout_path=?').run(join(link, 'outside.jsonl'));
  assert.equal(f.source.list()[0].local, false);
  await assert.rejects(f.source.detail(f.id), /outside/);
});
