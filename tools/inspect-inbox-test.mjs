import { LocalSource } from '../src/local-source.mjs';
import { loadConfig } from '../src/config.mjs';
const source = new LocalSource(loadConfig('agent').codexHome);
try {
  const threads = source.snapshot().threads.filter(t => t.title === 'Codex 随行 · 新建与结果验证');
  for (const thread of threads.slice(0, 5)) {
    const detail = await source.detail(thread.id);
    console.log(JSON.stringify({ id: thread.id, archived: thread.archived, activity: thread.activity, model: thread.model,
      turnStatus: detail.turnStatus, running: detail.running,
      messages: detail.messages.map(m => ({ role: m.role, phase: m.phase, length: m.text.length })) }));
  }
} finally { source.close(); }
