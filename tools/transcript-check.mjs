import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { LocalSource } from '../src/local-source.mjs';
import { loadConfig } from '../src/config.mjs';
import { createHash } from 'node:crypto';
const fingerprint = text => createHash('sha256').update(text).digest('hex').slice(0, 10);
const textOf = p => (p.content || []).map(c => c.text || '').join('\n');

const source = new LocalSource(loadConfig('agent').codexHome);
try {
  const ids = process.argv[2] ? [process.argv[2]] : source.list().slice(0, 3).map(t => t.id);
  for (const id of ids) {
    const row = source.row(id), counts = {}, timeline = [], users = [], completed = new Map();
    const lines = createInterface({ input: createReadStream(row.rollout_path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const p = e.payload || {};
      const key = `${e.type}/${p.type}/${p.role || ''}/${p.phase || ''}/${p.channel || ''}`;
      counts[key] = (counts[key] || 0) + 1;
      if (e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = (p.content || []).map(c => c.text || '').join('\n');
        users.push({ keys: Object.keys(p), content: (p.content || []).map(c => ({ type: c.type, keys: Object.keys(c) })), length: text.length, markers: [...text.matchAll(/(?:^|\n)(?:<(\/?[a-z_]+)[^>]*>|(# [^\n]{1,55}))/gi)].slice(0, 12).map(m => m[1] || m[2]), time: e.timestamp });
      }
      if (e.type === 'event_msg' && p.type === 'item_completed') {
        const item = p.item || {}, itemKey = `${item.type}/${item.role || ''}/${item.phase || ''}`;
        if (['UserMessage', 'AgentMessage'].includes(item.type)) {
          const text = textOf(item);
          timeline.push({ key: itemKey, id: item.id, length: text.length, fingerprint: fingerprint(text), markers: [...text.matchAll(/(?:^|\n)<(\/?[a-z_-]+)[^>]*>/gi)].map(m => m[1]), time: e.timestamp });
        }
        const existing = completed.get(itemKey);
        if (existing) existing.count++;
        else completed.set(itemKey, { count: 1, keys: Object.keys(p), itemKeys: Object.keys(item), contentTypes: (Array.isArray(item.content) ? item.content : []).map(c => ({ type: c.type, keys: Object.keys(c) })) });
      }
      if ((e.type === 'event_msg' && ['user_message', 'agent_message', 'task_started', 'task_complete', 'turn_aborted'].includes(p.type)) || (e.type === 'response_item' && p.type === 'message' && p.role === 'assistant')) {
        timeline.push({ key, id: p.id, keys: Object.keys(p), textLength: (p.last_agent_message || textOf(p) || p.message)?.length, fingerprint: fingerprint(p.last_agent_message || textOf(p) || p.message || ''), time: e.timestamp, turnId: p.turn_id });
      }
    }
    console.log(JSON.stringify({ id, counts, users, completed: Object.fromEntries(completed), timeline: process.argv.includes('--timeline') ? timeline.slice(-35) : undefined }));
  }
} finally { source.close(); }
