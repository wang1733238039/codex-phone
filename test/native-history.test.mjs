import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRecentDetail } from '../src/native-history.mjs';
import { Agent } from '../src/agent.mjs';
import { randomUUID } from 'node:crypto';
import { ResultFiles } from '../src/result-files.mjs';

test('native recent history keeps the latest 15 visible messages without reasoning, tools or commentary', () => {
  const turns = Array.from({ length: 15 }, (_, i) => ({
    id: `turn-${i}`, startedAt: 1793924793 + i, completedAt: 1793924794 + i, status: 'completed',
    items: [
      { type: 'userMessage', id: `u-${i}`, content: [{ type: 'text', text: `问题${i}` }] },
      { type: 'reasoning', text: 'private thought' }, { type: 'commandExecution', output: 'private command' },
      { type: 'agentMessage', phase: 'commentary', text: 'hidden progress' },
      { type: 'agentMessage', id: `a-${i}`, phase: 'final_answer', text: `结果${i}` },
    ],
  }));
  const detail = nativeRecentDetail('thread', turns.toReversed());
  assert.equal(detail.messages.length, 15);
  assert.equal(detail.messages[0].text, '结果7'); assert.equal(detail.messages.at(-1).text, '结果14');
  assert.equal(detail.running, false); assert.equal(detail.turnStatus, 'completed');
  assert.equal(detail.turnId, 'turn-14'); assert.equal(detail.ephemeral, undefined);
  assert.doesNotMatch(JSON.stringify(detail), /private thought|private command|hidden progress/);
});

function fixture(child = false) {
  const id = randomUUID(), agent = Object.create(Agent.prototype), calls = [];
  const failure = Object.assign(new Error('size limit'), { code: 'ROLLOUT_TOO_LARGE' });
  Object.assign(agent, {
    config: { controlsEnabled: false }, source: {
      detail: async () => { throw failure; }, row: () => ({ id }), isChild: () => child,
    }, reading: 0, releaseWhenIdle: () => {},
    codex: { start: async () => {}, call: async (method, params) => {
      calls.push({ method, params });
      return { data: [{ id: 'turn', status: 'completed', startedAt: 1793924793, completedAt: 1793924794,
        items: [{ type: 'agentMessage', phase: 'final_answer', text: '可见结果' }] }] };
    } }, active: new Map(), results: new ResultFiles(),
  });
  return { agent, id, calls };
}
test('large roots use the read-only native recent page without resuming or starting a task', async () => {
  const { agent, id, calls } = fixture();
  const result = await agent.handle('detail', { threadId: id });
  assert.equal(result.messages[0].text, '可见结果');
  assert.deepEqual(calls, [{ method: 'thread/turns/list', params: { threadId: id, limit: 15, sortDirection: 'desc', itemsView: 'full' } }]);
});
test('large children retain verified boundaries and do not fall back to unfiltered inherited native turns', async () => {
  const { agent, id, calls } = fixture(true);
  await assert.rejects(agent.handle('detail', { threadId: id }), /size limit/);
  assert.equal(calls.length, 0);
});
