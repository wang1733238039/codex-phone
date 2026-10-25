// Local, disposable native project test. Never invoke a model or inspect prompts.
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.mjs';
import { loadConfig } from '../src/config.mjs';
const agent = new Agent(loadConfig('agent'));
let id;
try {
  const begin = performance.now(), snapshot = agent.source.snapshot();
  const project = snapshot.sidebar.projects.find(p => p.nativeId && p.rootPaths.some(root => root === process.cwd())) ||
    snapshot.sidebar.projects.find(p => p.nativeId && p.rootPaths.length);
  assert.ok(project);
  const result = await agent.handle('create-thread', { projectId: project.id, rootPath: project.rootPaths[0], title: 'Codex 随行 · 新建接口验证' });
  id = result.thread.id;
  assert.equal(result.thread.projectId, project.id);
  const indexed = agent.source.snapshot().threads.find(t => t.id === id);
  assert.ok(indexed, 'new empty thread must be visible in the native index');
  const detail = await agent.handle('detail', { threadId: id });
  assert.equal(detail.messages.length, 0);
  console.log(JSON.stringify({ passed: true, testThreadId: id, nativeProjectAssigned: true, emptyThreadReadable: true,
    scannedThreads: snapshot.threads.length, elapsedMs: Math.round(performance.now() - begin) }));
} finally {
  if (id) { await agent.codex.start(); await agent.codex.call('thread/archive', { threadId: id }); }
  agent.close();
}
