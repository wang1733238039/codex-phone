import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopBridge } from '../src/desktop.mjs';
import { Agent } from '../src/agent.mjs';

const id = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const state = { id, hostId: 'local', cwd: 'workspace', turns: [{ turnId: 'original-turn', status: 'inProgress' }],
    requests: [], latestThreadSettings: { model: 'original-model', effort: 'high' } };
  const calls = [];
  const ipc = { ready: true, state: () => state, follow: async target => target === id ? state : undefined,
    command: async (target, method, params, before) => { before?.(); calls.push({ target, method, params }); return { turnId: 'original-turn' }; },
    close() { this.ready = false; } };
  return { state, calls, ipc, bridge: new DesktopBridge({ codexHome: 'fixture' }, () => {}, ipc) };
}
test('desktop live status and controls come from the original owner, not persisted history', async () => {
  const f = fixture();
  assert.equal((await f.bridge.read(id)).id, id);
  assert.deepEqual(f.bridge.activeTurns(), [{ threadId: id, turnId: 'original-turn', channel: 'desktop' }]);
  const result = f.bridge.runtime(id, f.state);
  assert.equal(result.execution.channel, 'desktop'); assert.equal(result.execution.verified, true);
  assert.equal(result.settings.model, 'original-model');
  f.ipc.onDisconnect();
  assert.deepEqual(f.bridge.activeTurns(), []); assert.equal(f.bridge.status.connected, false);
});
test('desktop steer preserves target, original turn and immutable user message ID', async () => {
  const f = fixture();
  const result = await f.bridge.send(id, { mode: 'steer', requestId: 'operation', turnId: 'original-turn', text: 'next' },
    [{ type: 'text', text: 'next' }], {}, f.state);
  assert.equal(result.delivery, 'steered'); assert.equal(f.calls[0].target, id);
  assert.equal(f.calls[0].method, 'thread-follower-steer-turn');
  assert.equal(f.calls[0].params.clientUserMessageId, 'operation');
  assert.deepEqual(f.calls[0].params.input[0].text_elements, []);
  await assert.rejects(f.bridge.send(id, { mode: 'steer', turnId: 'stale' }, [], {}, f.state), /轮次/);
  assert.equal(f.calls.length, 1);
});
test('desktop normal sends queue behind active work and idle sends inherit existing permissions', async () => {
  const f = fixture();
  assert.equal(await f.bridge.send(id, {}, [], {}, f.state), null);
  f.state.turns[0].status = 'completed';
  await f.bridge.send(id, { requestId: 'operation' }, [{ type: 'text', text: 'hello' }], { model: 'selected' }, f.state);
  const request = f.calls[0].params.turnStart;
  assert.equal(request.request.clientUserMessageId, 'operation');
  assert.equal(request.request.model, 'selected');
  assert.equal(request.request.sandboxPolicy, undefined); assert.equal(request.context.inheritThreadSettings, true);
});
test('a desktop write timeout stays uncertain and is never reclassified as a safe retry', async () => {
  const f = fixture(); f.state.turns[0].status = 'completed';
  f.ipc.command = async (_id, _method, _params, before) => { before(); throw new Error('connection lost'); };
  await assert.rejects(f.bridge.send(id, { requestId: 'one' }, [], {}, f.state), error => error.uncertain === true);
  f.ipc.command = async () => { throw new Error('owner gone before write'); };
  await assert.rejects(f.bridge.send(id, {}, [], {}, f.state), error => error.uncertain === false);
});
test('stopping a desktop task requires a fresh matching turn', async () => {
  const f = fixture();
  await assert.rejects(f.bridge.stop(id, 'stale'), /轮次/);
  assert.equal(f.calls.length, 0);
  await f.bridge.stop(id, 'original-turn');
  assert.equal(f.calls[0].params.expectedTurnId, 'original-turn');
  assert.equal(f.calls[0].params.mode, 'user-stop');
});
test('desktop approvals reject a foreign thread and a request changed during revalidation', async () => {
  const f = fixture();
  f.state.requests = [{ id: 7, method: 'item/commandExecution/requestApproval',
    params: { threadId: id, turnId: 'original-turn', command: 'safe original' } }];
  f.bridge.collectApprovals(id);
  const approvalId = [...f.bridge.approvals.keys()][0];
  await assert.rejects(f.bridge.approve(approvalId, 'foreign', 'accept'), /目标/);
  f.ipc.follow = async () => {
    f.state.requests[0].params.command = 'changed command'; return f.state;
  };
  await assert.rejects(f.bridge.approve(approvalId, id, 'accept'), /变化/);
  assert.equal(f.calls.length, 0);
});
test('agent never starts a parallel CLI task after an uncertain desktop send', async () => {
  const f = fixture(); f.state.turns[0].status = 'completed';
  let cliStarts = 0;
  f.ipc.command = async (_id, _method, _params, before) => { before(); throw new Error('lost response'); };
  const agent = { config: { controlsEnabled: true }, active: new Map(), inflight: new Set(),
    source: { row: () => ({ archived: false }), isLocal: () => true }, desktop: f.bridge,
    selection: async () => ({}), inputs: async () => [{ type: 'text', text: 'one' }],
    codex: { start: async () => { cliStarts++; } }, releaseWhenIdle() {} };
  await assert.rejects(Agent.prototype.handle.call(agent, 'send', { threadId: id, text: 'one', requestId: 'one' }),
    error => error.uncertain === true);
  assert.equal(cliStarts, 0); assert.equal(agent.inflight.size, 0);
});
test('desktop controls recheck the turn immediately before the execution write', async () => {
  for (const mode of ['steer', 'stop', 'start']) {
    const f = fixture();
    if (mode === 'start') f.state.turns[0].status = 'completed';
    f.ipc.command = async (_id, _method, _params, before) => {
      f.state.turns = [{ turnId: 'replacement', status: 'inProgress' }];
      before();
      assert.fail('a changed turn must not be written');
    };
    const work = mode === 'stop' ? f.bridge.stop(id, 'original-turn')
      : f.bridge.send(id, { mode: mode === 'steer' ? 'steer' : 'normal' }, [], {}, f.state);
    await assert.rejects(work, error => error.uncertain === false && /轮次|新任务/.test(error.message));
  }
});
test('an active runtime without a complete turn snapshot cannot start a parallel turn', async () => {
  const f = fixture(); f.state.turns = []; f.state.threadRuntimeStatus = { type: 'active' };
  assert.equal(await f.bridge.send(id, {}, [], {}, f.state), null);
  assert.equal(f.calls.length, 0);
});
test('desktop approvals recheck request type and active turn just before write', async () => {
  for (const change of ['method', 'turn']) {
    const f = fixture();
    f.state.requests = [{ id: 9, method: 'item/commandExecution/requestApproval',
      params: { threadId: id, turnId: 'original-turn', command: 'original' } }];
    f.bridge.collectApprovals(id);
    f.ipc.command = async (_id, _method, _params, before) => {
      if (change === 'method') f.state.requests[0].method = 'item/fileChange/requestApproval';
      else f.state.turns[0].status = 'completed';
      before();
      assert.fail('stale approval must not be written');
    };
    await assert.rejects(f.bridge.approve([...f.bridge.approvals.keys()][0], id, 'accept'),
      error => error.uncertain === false && /变化/.test(error.message));
  }
});
