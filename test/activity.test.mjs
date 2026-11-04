import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeActivity, ActivityIndex } from '../src/activity.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const event = (payload, ms = 0) => JSON.stringify({ type: 'event_msg', timestamp: new Date(1720000000000 + ms).toISOString(), payload });
test('completion is explicit, duplicate final events are stable, repeated text in new turns is new', () => {
  const lines = [event({ type: 'task_started', turn_id: 'a' }), event({ type: 'agent_message', phase: 'commentary', message: 'hidden' }, 1)];
  assert.equal(summarizeActivity(lines).state, 'unconfirmed');
  assert.equal(summarizeActivity(lines).resultKey, '');
  lines.push(event({ type: 'agent_message', phase: 'final_answer', message: 'same' }, 2));
  const first = summarizeActivity(lines);
  assert.equal(first.state, 'unconfirmed');
  lines.push(event({ type: 'task_complete', last_agent_message: 'same' }, 3));
  const completed = summarizeActivity(lines);
  assert.equal(completed.state, 'completed'); assert.equal(completed.resultKey, first.resultKey);
  lines.push(event({ type: 'task_started', turn_id: 'b' }, 4), event({ type: 'agent_message', phase: 'final_answer', message: 'same' }, 5));
  assert.notEqual(summarizeActivity(lines).resultKey, first.resultKey);
  lines.push(event({ type: 'turn_aborted' }, 6));
  assert.equal(summarizeActivity(lines).state, 'interrupted');
  assert.doesNotMatch(JSON.stringify(summarizeActivity(lines)), /hidden|same/);
});
test('failure or tool outputs never imply a completed result', () => {
  assert.equal(summarizeActivity([event({ type: 'task_failed' })]).state, 'failed');
  assert.equal(summarizeActivity(['broken', event({ type: 'tool_result', text: 'secret' })]).resultKey, '');
  assert.equal(summarizeActivity([event({ type: 'task_complete' })]).resultKey, '');
});
test('a child never inherits completion or unread results from copied parent records', t => {
  const home = mkdtempSync(join(tmpdir(), 'child-activity-')); mkdirSync(join(home, 'sessions'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'sessions', 'child.jsonl'), createdAt = 1720000000010;
  writeFileSync(file, [event({ type: 'task_complete', last_agent_message: 'parent result' }, 1),
    event({ type: 'task_started', turn_id: 'child' }, 20)].join('\n') + '\n', 'utf8');
  const activity = new ActivityIndex(realpathSync.native(home)).read({ id: 'child', rollout_path: file, parentThreadId: 'parent', created_at_ms: createdAt });
  assert.equal(activity.state, 'unconfirmed'); assert.equal(activity.resultKey, '');
});
