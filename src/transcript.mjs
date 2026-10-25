// Only this projection crosses the computer/server boundary. Never cache raw rollout items.
import { attachmentText } from './attachment-common.mjs';
// Attachments are additive; keep v2 compatibility with existing text-only computers.
export const TRANSCRIPT_VERSION = 2;
const textTypes = new Set(['input_text', 'output_text', 'text', 'Text']);
const textOf = item => (Array.isArray(item.content) ? item.content : [])
  .filter(c => textTypes.has(c.type)).map(c => typeof c.text === 'string' ? c.text : '').join('\n');

export function userText(value) {
  let text = value;
  // Desktop attaches these envelopes to a prompt; they are not the user's input.
  const ambient = /^\s*<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/;
  if (ambient.test(text)) text = text.replace(ambient, '').replace(/^## My request:\s*/, '');
  text = text.replace(/^\s*# AGENTS\.md instructions[^\n]*\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/, '');
  text = text.replace(/^\s*<environment_context\b[^>]*>[\s\S]*?<\/environment_context>\s*/, '');
  return text.trim();
}

export class Transcript {
  constructor() { this.messages = []; this.pending = []; this.seen = new Set(); this.sequence = 0; this.running = false; this.turnStatus = 'idle'; this.lastActivityAt = 0; this.turnId = null; }
  add(role, text, item, entry, rank) {
    if (typeof text !== 'string') return;
    this.pending.push({ id: item.id || null, role, text, time: entry.timestamp, phase: item.phase || null, rank, order: this.sequence++ });
  }
  push(entry) {
    const p = entry.payload || {};
    const time = Date.parse(entry.timestamp);
    if (Number.isFinite(time)) this.lastActivityAt = Math.max(this.lastActivityAt, time);
    if (entry.type === 'event_msg') {
      if (p.type === 'task_started') { this.flush(); this.running = true; this.turnStatus = 'running'; this.turnId = p.turn_id || p.turnId || null; }
      if (['task_complete', 'turn_aborted', 'task_failed'].includes(p.type)) {
        this.running = false; this.turnStatus = p.type === 'task_complete' ? 'completed' : p.type === 'turn_aborted' ? 'interrupted' : 'failed';
        this.flush(p.type === 'task_complete' ? p.last_agent_message : null, entry.timestamp);
      }
      if (p.type === 'user_message' || p.type === 'agent_message') {
        this.add(p.type === 'user_message' ? 'user' : 'assistant', p.message, p, entry, 2);
      }
      if (p.type === 'item_completed') {
        const item = p.item || {};
        if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
          this.add(item.type === 'UserMessage' ? 'user' : 'assistant', textOf(item), item, entry, 3);
        }
      }
    }
    if (entry.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      this.add(p.role, textOf(p), p, entry, 1);
    }
  }
  flush(lastAgentMessage, completedAt) {
    const chosen = [];
    for (const role of ['user', 'assistant']) {
      const candidates = this.pending.filter(m => m.role === role);
      const rank = candidates.reduce((value, m) => Math.max(value, m.rank), 0);
      // Completed UI items omit injected instructions and context-compaction summaries.
      // Prefer them per turn/role, so older and newer log formats can coexist.
      for (const message of candidates.filter(m => m.rank === rank)) {
        const projected = role === 'user' ? attachmentText(userText(message.text)) : { text: message.text };
        const text = projected.text;
        const final = message.phase === 'final_answer' || (!message.phase && text === lastAgentMessage);
        if ((text.trim() || projected.attachmentIds?.length) && (role === 'user' || final)) chosen.push({ ...message, ...projected });
      }
    }
    // Old logs may identify the final reply only in the completion event.
    if (typeof lastAgentMessage === 'string' && lastAgentMessage.trim() &&
        !chosen.some(m => m.role === 'assistant') &&
        !this.pending.some(m => m.role === 'assistant' && m.phase && m.phase !== 'final_answer' && m.text === lastAgentMessage)) {
      chosen.push({ role: 'assistant', text: lastAgentMessage, phase: 'final_answer', time: completedAt, order: this.sequence++ });
    }
    chosen.sort((a, b) => a.order - b.order);
    for (const message of chosen) {
      const key = message.id && `${message.role}:${message.id}`;
      if (key && this.seen.has(key)) continue;
      if (key) this.seen.add(key);
      this.messages.push({ id: message.id || `m${message.order}`, role: message.role, text: message.text, time: message.time,
        ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
        ...(message.role === 'assistant' ? { phase: 'final_answer' } : {}) });
    }
    this.pending = [];
  }
  finish() { this.flush(); return { messages: this.messages, running: this.running, turnStatus: this.turnStatus, turnId: this.turnId, lastActivityAt: this.lastActivityAt, transcriptVersion: TRANSCRIPT_VERSION }; }
}
