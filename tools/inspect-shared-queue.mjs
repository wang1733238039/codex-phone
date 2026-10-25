// Disposable, no-model-call protocol verification. Never touches user threads.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexClient } from '../src/codex.mjs';
import { loadConfig } from '../src/config.mjs';
const a = new CodexClient(loadConfig('agent')), b = new CodexClient(loadConfig('agent'));
let id, queueId;
try {
  await a.start(); await b.start();
  const started = await a.call('thread/start', { cwd: mkdtempSync(join(tmpdir(), 'phone-queue-inspect-')),
    baseInstructions: 'Disposable protocol test. Never start a turn.', approvalPolicy: 'never', sandbox: 'read-only' });
  id = started.thread.id;
  await a.call('thread/name/set', { threadId: id, name: 'Codex Phone · queue protocol check' });
  for (const [method, params] of [
    ['thread/read', { threadId: id, includeTurns: false }],
    ['thread/settings/update', { threadId: id, model: started.model || 'gpt-6.1-sol', effort: 'medium' }],
    ['thread/resume', { threadId: id, excludeTurns: true }],
    ['thread/queue/add', { threadId: id, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'Disposable pending input. Do not start.', text_elements: [] }] }],
    ['thread/queue/list', { threadId: id, limit: 20 }],
  ]) {
    try {
      const result = await b.call(method, params, 15000);
      if (result.queuedSubmission) queueId = result.queuedSubmission.id;
      console.log(JSON.stringify({ method, ok: true, keys: Object.keys(result), status: result.thread?.status, model: result.thread?.model,
        queueId: result.queuedSubmission?.id, count: result.data?.length }));
    } catch (error) { console.log(JSON.stringify({ method, error: error.message })); }
  }
} finally {
  if (queueId) await b.call('thread/queue/delete', { threadId: id, queuedSubmissionId: queueId }).catch(() => {});
  if (id) await a.call('thread/archive', { threadId: id }).then(() => console.log(JSON.stringify({ archived: true, noModelCall: true }))).catch(error => console.log(JSON.stringify({ cleanupError: error.message, id })));
  a.close(); b.close();
}
