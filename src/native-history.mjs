import { sideDetail } from './side-conversations.mjs';

// The native display projection supplies only real user items and final answers.
// Recent turn pages avoid decoding an entire very large compressed rollout.
export function nativeRecentDetail(id, turns) {
  const normalized = [...turns].reverse().map(turn => ({
    ...turn, turnId: turn.id, turnStartedAtMs: turn.startedAt ? turn.startedAt * 1000 : 0,
    items: (turn.items || []).map(item => ({
      ...item, ...(turn.completedAt ? { completedAtMs: turn.completedAt * 1000 } : {}),
    })),
  }));
  const updatedAt = normalized.reduce((latest, turn) => Math.max(latest,
    (turn.completedAt || turn.startedAt || 0) * 1000), 0);
  const detail = sideDetail({ id, turns: normalized, updatedAt });
  delete detail.ephemeral;
  return { ...detail, recentOnly: true };
}
