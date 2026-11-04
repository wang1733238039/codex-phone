// Only explicit Codex relationships are used; cwd/title never establish ancestry.
export const validThreadId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);

export function threadSource(row) {
  let source;
  try { source = JSON.parse(row.source); } catch {}
  const spawn = source?.subagent?.thread_spawn;
  return {
    subagent: /subagent|sub_agent/i.test(row.thread_source || '') || Boolean(source?.subagent),
    internal: Boolean(source?.subagent && !spawn),
    parentId: row.attached_thread_parent_id || spawn?.parent_thread_id || null,
  };
}

// Validate the entire ancestry, including nested agents, before a child is exposed.
export function linkChildren(roots, children) {
  const rootIds = new Set(roots.map(r => r.id));
  const byId = new Map(children.filter(r => validThreadId(r.id) && !rootIds.has(r.id)).map(r => [r.id, r]));
  const resolved = new Map();
  function resolve(id, visiting = new Set()) {
    if (rootIds.has(id)) return { rootThreadId: id, depth: 0 };
    if (resolved.has(id)) return resolved.get(id);
    const row = byId.get(id);
    if (!row || !validThreadId(row.parentThreadId) || visiting.has(id) || visiting.size >= 64) return null;
    visiting.add(id);
    const parent = resolve(row.parentThreadId, visiting);
    visiting.delete(id);
    const result = parent ? { rootThreadId: parent.rootThreadId, depth: parent.depth + 1 } : null;
    resolved.set(id, result);
    return result;
  }
  return [...byId.values()].flatMap(row => {
    const relation = resolve(row.id);
    return relation ? [{ ...row, ...relation, readOnly: row.readOnly === true || row.local !== true || row.archived === true || row.historyAvailable === false }] : [];
  });
}

export function localFamily(rows, edges = []) {
  const edgeParents = new Map(edges.map(e => [e.child_thread_id, e.parent_thread_id]));
  const candidates = [], roots = [];
  for (const row of rows) {
    const source = threadSource(row), parentThreadId = source.parentId || edgeParents.get(row.id);
    if (source.internal) continue;
    if (parentThreadId) candidates.push({ ...row, parentThreadId });
    else if (!source.subagent && (row.source === undefined || ['cli', 'vscode'].includes(row.source))) roots.push(row);
  }
  return { roots, children: linkChildren(roots, candidates) };
}
