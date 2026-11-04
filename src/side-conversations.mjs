import { readdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { desktopTurns } from '../vendor/agent-hub/dist/desktop-ipc.mjs';
import { validThreadId } from './thread-family.mjs';
import { userText, TRANSCRIPT_VERSION } from './transcript.mjs';
import { attachmentText } from './attachment-common.mjs';

// Logs supply candidates only. Membership always requires a fresh, verified
// desktop owner snapshot with an explicit side-conversation parent.
export function desktopLogCandidates(directory) {
  if (!directory) return [];
  const ids = new Set();
  try {
    const files = readdirSync(directory).filter(n => /^codex-desktop-.*\.log$/.test(n)).sort().slice(-12);
    for (const name of files) {
      let fd;
      try {
        fd = openSync(join(directory, name), 'r');
        const tail = Buffer.alloc(4 * 1024 * 1024);
        // Negative positions are not portable; obtain the size from the handle.
        const size = fstatSync(fd).size;
        const count = readSync(fd, tail, 0, Math.min(size, tail.length), Math.max(0, size - tail.length));
        for (const line of tail.subarray(0, count).toString('utf8').split('\n')) {
          if (!line.includes('thread_stream_role_changed') || !line.includes('role=owner')) continue;
          const id = line.match(/\bconversationId=([a-f0-9-]{36})\b/i)?.[1];
          if (validThreadId(id)) { ids.delete(id); ids.add(id); }
        }
      } catch {} finally { if (fd !== undefined) closeSync(fd); }
    }
  } catch {}
  return [...ids].slice(-128);
}

export function sideParent(state) {
  if (state?.hostId !== 'local' || state.sideConversation !== true || state.ephemeral !== true ||
    !validThreadId(state.id) || !validThreadId(state.forkedFromId) || state.id === state.forkedFromId) return null;
  // This field is supplied by the original desktop; reject contradictory roots.
  if (state.sideConversationParentNavigationPath !== `/local/${state.forkedFromId}`) return null;
  return state.forkedFromId;
}

export function sideDetail(state) {
  const turns = desktopTurns(state).filter(t => !Number.isFinite(state.createdAt) || !Number.isFinite(t.turnStartedAtMs) || t.turnStartedAtMs >= state.createdAt), messages = [];
  for (const turn of turns) {
    const items = turn.items || [];
    const legacyFinal = turn.status !== 'inProgress' ? items.findLast(i => i.type === 'agentMessage' && !i.phase) : null;
    for (const item of items) {
      let role, projected;
      if (item.type === 'userMessage') {
        role = 'user';
        projected = attachmentText(userText((item.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n')));
      } else if (item.type === 'agentMessage' && (item.phase === 'final_answer' || item === legacyFinal)) {
        role = 'assistant'; projected = { text: item.text || '' };
      } else continue;
      if (!projected.text.trim() && !projected.attachmentIds?.length) continue;
      messages.push({ id: item.id, role, ...projected, time: new Date(item.completedAtMs || item.startedAtMs || turn.turnStartedAtMs || 0).toISOString(),
        ...(role === 'assistant' ? { phase: 'final_answer' } : {}) });
    }
  }
  const turn = turns.at(-1), running = turns.some(t => t.status === 'inProgress');
  return { id: state.id, messages: messages.slice(-15), running, turnStatus: running ? 'running' : turn?.status || 'idle',
    turnId: turn?.turnId || null, lastActivityAt: state.updatedAt || state.recencyAt || 0,
    transcriptVersion: TRANSCRIPT_VERSION, readAt: Date.now(), readOnly: false, ephemeral: true };
}

export function mergeSideConversations(snapshot, states) {
  const children = [...snapshot.childThreads], roots = new Map(snapshot.threads.map(t => [t.id, t]));
  const known = new Set([...roots.keys(), ...children.map(t => t.id)]);
  for (const state of states) {
    const parentId = sideParent(state), parent = roots.get(parentId);
    if (!parent || parent.archived || !parent.local || known.has(state.id)) continue;
    const detail = sideDetail(state);
    const first = desktopTurns(state).filter(t => !Number.isFinite(state.createdAt) || !Number.isFinite(t.turnStartedAtMs) || t.turnStartedAtMs >= state.createdAt)
      .flatMap(t => t.items || []).find(i => i.type === 'userMessage');
    const title = first ? userText((first.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n')) : '';
    children.push({ ...parent, id: state.id, title: title.slice(0, 100) || '桌面侧栏对话', preview: title.slice(0, 250),
      parentThreadId: parentId, rootThreadId: parentId, depth: 1, readOnly: false, historyAvailable: true,
      ephemeral: true, childCount: 0, updatedAt: state.recencyAt || parent.updatedAt,
      activity: { state: detail.running ? 'unconfirmed' : detail.turnStatus, at: detail.lastActivityAt,
        resultAt: Date.parse(detail.messages.findLast(m => m.role === 'assistant')?.time || '') || 0,
        resultKey: detail.messages.findLast(m => m.role === 'assistant')?.id || '' } });
    known.add(state.id);
  }
  return { ...snapshot, childThreads: children, threads: snapshot.threads.map(t => ({ ...t,
    childCount: children.filter(c => c.rootThreadId === t.id).length })) };
}
