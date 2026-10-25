// Codex has both desktop project assignments and newer app-server project IDs.
// Resolve explicit membership before considering workspace roots.
const strings = value => Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
const pathKey = value => typeof value === 'string' ? value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() : '';
const position = value => Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
const rank = (ids, id) => { const index = ids.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };

export function resolveSidebar(rows, { projects = [], roots = [], sections = [], settings = {}, home = '' } = {}) {
  const atoms = settings['electron-persisted-atom-state'] || {};
  const hostKey = Object.keys(settings['app-server-project-id-by-legacy-project-id-by-host'] || {}).find(k => k.startsWith('local:') && pathKey(k.slice(6)) === pathKey(home));
  const aliases = settings['app-server-project-id-by-legacy-project-id-by-host']?.[hostKey] || {};
  const migration = settings['app-server-projects-migration-by-host']?.[hostKey];
  const legacy = Object.values(settings['local-projects'] || {}).filter(p => p && typeof p.id === 'string');
  const legacyByNative = new Map(legacy.filter(p => aliases[p.id]).map(p => [aliases[p.id], p]));
  const catalog = new Map();
  for (const p of projects) {
    const old = legacyByNative.get(p.id), id = old?.id || p.id;
    catalog.set(id, { id, nativeId: p.id, name: p.name, position: position(p.position),
      rootPaths: roots.filter(r => r.project_id === p.id).sort((a, b) => a.position - b.position).map(r => r.path) });
  }
  for (const p of legacy) if (!catalog.has(p.id)) catalog.set(p.id, { id: p.id, name: p.name, position: Number.MAX_SAFE_INTEGER, rootPaths: strings(p.rootPaths) });
  const canonical = id => legacyByNative.get(id)?.id || id;
  const projectOrder = strings(settings['project-order']).map(canonical);
  const unifiedOrder = strings(atoms['unified-sidebar-project-order-v1']).filter(x => x.startsWith('codex:project:')).map(x => canonical(x.slice(14)));
  const order = unifiedOrder.length ? unifiedOrder : projectOrder;
  const pinnedProjects = new Set(strings(settings['pinned-project-ids']).map(canonical));
  for (const p of catalog.values()) {
    p.name ||= p.rootPaths[0]?.split(/[\\/]/).pop() || '未命名项目';
    p.position = order.includes(p.id) ? order.indexOf(p.id) : p.position;
    p.expanded = atoms[`sidebar-project-expanded-v1-codex:${p.id}`] ?? atoms[`sidebar-project-expanded-v1-codex:${p.nativeId}`] ?? atoms[`sidebar-project-expanded-v1-codex:${p.rootPaths[0]}`] ?? false;
    p.pinned = pinnedProjects.has(p.id);
  }
  const assignments = settings['thread-project-assignments'] || {};
  const projectless = new Set(strings(settings['projectless-thread-ids']));
  const pinnedSections = new Set(sections.filter(s => s.name?.toLowerCase() === 'pinned').map(s => s.id));
  const legacyPins = strings(settings['pinned-thread-ids']);
  const pinOrder = strings(atoms['app-server-pinned-thread-order-v1']);
  const flat = atoms['flat-project-sidebar-preferences-v1'] || {};
  const preferences = { grouping: { mode: flat.mode === 'list' ? 'list' : 'project' },
    sorting: { chats: flat.chatSortMode === 'manual' ? 'manual' : 'updated_at', pinned: atoms['pinned-sidebar-sort-mode-v1'] === 'manual' ? 'manual' : 'updated_at' } };
  const membership = row => {
    if (row.project_id) return canonical(row.project_id);
    // Once migration completes, null is authoritative and old assignments are stale.
    if (migration?.threadAssignmentsMigrated === true || (Object.hasOwn(row, 'project_id') && !legacy.length) || projectless.has(row.id)) return null;
    if (Object.hasOwn(assignments, row.id)) {
      const a = assignments[row.id];
      return a?.projectKind === 'local' ? canonical(a.projectId) : null;
    }
    const path = pathKey(settings['thread-workspace-root-hints']?.[row.id] || row.cwd);
    if (!path) return null;
    // Roots can be shared by projects: prefer a primary root, never arbitrarily
    // assign a chat to a project just because it has the same folder name.
    const candidates = [...catalog.values()].flatMap(p => p.rootPaths.map((root, i) => ({ id: p.id, root: pathKey(root), primary: i === 0 })))
      .filter(p => path === p.root || path.startsWith(p.root + '/'))
      .sort((a, b) => b.root.length - a.root.length || Number(b.primary) - Number(a.primary));
    const first = candidates[0];
    if (!first) return null;
    return new Set(candidates.filter(p => p.root.length === first.root.length && p.primary === first.primary).map(p => p.id)).size === 1 ? first.id : null;
  };
  const threadFields = new Map(rows.map(row => {
    const id = membership(row), project = catalog.get(id);
    const threadOrder = strings(settings['sidebar-project-thread-orders']?.[project?.id]?.threadIds);
    const nativePin = Boolean(row.is_pinned) || pinnedSections.has(row.thread_section_id);
    return [row.id, { projectId: project?.id || null, projectName: project?.name || '',
      pinned: Object.hasOwn(row, 'thread_section_id') || Object.hasOwn(row, 'is_pinned') ? nativePin : legacyPins.includes(row.id),
      pinPosition: pinOrder.includes(row.id) ? rank(pinOrder, row.id) : position(row.section_position),
      projectPosition: rank(threadOrder, row.id) }];
  }));
  return { threadFields, sidebar: { version: 1, projects: [...catalog.values()].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)), preferences,
    expanded: { pinned: !atoms['sidebar-collapsed-sections-v1']?.pinned, unassigned: !atoms['sidebar-collapsed-sections-v1']?.threads } } };
}

export function compareThreads(a, b, sidebar = {}) {
  const sorting = sidebar.preferences?.sorting || {};
  return Number(b.pinned) - Number(a.pinned) ||
    (a.pinned && sorting.pinned === 'manual' ? position(a.pinPosition) - position(b.pinPosition) : 0) ||
    (!a.pinned && a.projectId === b.projectId && sorting.chats === 'manual' ? position(a.projectPosition) - position(b.projectPosition) : 0) ||
    (b.updatedAt || 0) - (a.updatedAt || 0) || a.id.localeCompare(b.id);
}

export function sidebarGroups(threads, sidebar = {}, { archived = false, searching = false } = {}) {
  const ids = members => [...members].sort((a, b) => compareThreads(a, b, sidebar)).map(t => t.id);
  const groups = [], projects = sidebar.projects || [], known = new Set(projects.map(p => p.id));
  const pinned = archived ? [] : threads.filter(t => t.pinned);
  if (pinned.length) groups.push({ id: 'pinned', name: '置顶', kind: 'pinned', expanded: sidebar.expanded?.pinned ?? true, threadIds: ids(pinned) });
  const rest = threads.filter(t => archived || !t.pinned);
  if (sidebar.preferences?.grouping?.mode !== 'list') {
    for (const p of projects) {
      const members = rest.filter(t => t.projectId === p.id);
      if (!members.length && (searching || archived)) continue;
      groups.push({ id: `project:${p.id}`, name: p.name, kind: 'project', expanded: Boolean(p.expanded), threadIds: ids(members) });
    }
  }
  const others = sidebar.preferences?.grouping?.mode === 'list' ? rest : rest.filter(t => !known.has(t.projectId));
  if (others.length) groups.push({ id: 'unassigned', name: sidebar.preferences?.grouping?.mode === 'list' ? '会话' : '其他会话', kind: 'chats', expanded: sidebar.expanded?.unassigned ?? true, threadIds: ids(others) });
  return groups;
}
