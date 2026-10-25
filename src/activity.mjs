import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, statSync, realpathSync } from 'node:fs';
import { relative, join, isAbsolute, sep } from 'node:path';

// A bounded, read-only projection. No message content leaves this module.
export function summarizeActivity(lines) {
  let state = 'unknown', at = 0, resultAt = 0, resultKey = '', turn = '', fingerprint = '';
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const p = entry.payload || {}, time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time)) continue;
    const event = entry.type === 'event_msg';
    if (event && p.type === 'task_started') { state = 'unconfirmed'; at = time; turn = p.turn_id || p.turnId || String(time); fingerprint = ''; }
    if (event && ['task_complete', 'turn_aborted', 'task_failed'].includes(p.type)) {
      state = p.type === 'task_complete' ? 'completed' : p.type === 'turn_aborted' ? 'interrupted' : 'failed'; at = time;
    }
    const item = event && p.type === 'item_completed' ? p.item : p;
    const final = (entry.type === 'response_item' && item.type === 'message' && item.role === 'assistant' ||
      event && (p.type === 'agent_message' || item.type === 'AgentMessage')) && item.phase === 'final_answer';
    const text = final ? item.message || (item.content || []).map(c => c.text || '').join('\n') :
      event && p.type === 'task_complete' ? p.last_agent_message : '';
    if (typeof text === 'string' && text.trim()) {
      // Duplicate UI/raw/completion events for one reply share a fingerprint.
      const key = createHash('sha256').update(text).digest('hex').slice(0, 24);
      if (key !== fingerprint) { resultAt = time; resultKey = createHash('sha256').update(`${turn || time}:${key}`).digest('hex').slice(0, 24); fingerprint = key; }
      at = Math.max(at, time);
    }
  }
  return { state, at, resultAt, resultKey };
}

export class ActivityIndex {
  constructor(home) { this.home = home; this.cache = new Map(); }
  read(row) {
    try {
      const path = realpathSync.native(row.rollout_path);
      const allowed = ['sessions', 'archived_sessions'].some(folder => {
        const rel = relative(join(this.home, folder), path);
        return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      });
      if (!allowed) return { state: 'unknown' };
      const stat = statSync(path), signature = `${path}:${stat.size}:${stat.mtimeMs}`;
      if (this.cache.get(row.id)?.signature === signature) return this.cache.get(row.id).activity;
      const fd = openSync(path, 'r'), offset = Math.max(0, stat.size - 1024 * 1024);
      let text;
      try {
        const bytes = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
        text = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, offset)).toString('utf8');
      } finally { closeSync(fd); }
      if (offset) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split('\n');
      // Ignore a partial final JSON record while the desktop is writing it.
      if (!text.endsWith('\n')) lines.pop();
      const activity = summarizeActivity(lines);
      const prior = this.cache.get(row.id)?.activity;
      if (!activity.resultKey && prior?.resultKey) { activity.resultKey = prior.resultKey; activity.resultAt = prior.resultAt; }
      this.cache.set(row.id, { signature, activity });
      return activity;
    } catch { return { state: 'unknown' }; }
  }
}
