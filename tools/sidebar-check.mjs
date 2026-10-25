import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalSource } from '../src/local-source.mjs';
import { loadConfig } from '../src/config.mjs';
const home = loadConfig('agent').codexHome;
const source = new LocalSource(home);
try {
  console.log(JSON.stringify({ columns: [...source.columns], tables: source.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name) }));
  const global = JSON.parse(readFileSync(join(home, '.codex-global-state.json'), 'utf8'));
  if (process.argv.includes('--data')) {
    for (const table of ['projects', 'project_roots', 'thread_sections']) {
      console.log(JSON.stringify({ table, rows: source.db.prepare(`SELECT * FROM ${table}`).all() }));
    }
    console.log(JSON.stringify({ membership: source.db.prepare('SELECT project_id, thread_section_id, is_pinned, COUNT(*) AS count FROM threads GROUP BY project_id, thread_section_id, is_pinned').all() }));
    console.log(JSON.stringify({ atoms: Object.fromEntries(Object.entries(global['electron-persisted-atom-state'] || {}).filter(([k]) => /sort|order|sidebar.*prefer/i.test(k))) }));
    console.log(JSON.stringify({ keys: Object.keys(global) }));
    console.log(JSON.stringify({ expanded: Object.fromEntries(Object.entries(global['electron-persisted-atom-state'] || {}).filter(([k]) => /expanded|collapsed|group/i.test(k))) }));
    for (const key of ['local-projects', 'thread-project-assignments', 'app-server-project-id-by-legacy-project-id-by-host', 'app-server-projects-migration-by-host', 'sidebar-project-thread-orders', 'sidebar-preferences', 'pinned-thread-ids']) {
      const value = global[key];
      console.log(JSON.stringify({ key, value: key === 'thread-project-assignments' || key === 'sidebar-project-thread-orders' ? Object.fromEntries(Object.entries(value || {}).slice(0, 4)) : value }));
    }
    process.exit(0);
  }
  for (const table of ['projects', 'project_roots', 'thread_sections']) {
    console.log(JSON.stringify({ table, columns: source.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name) }));
  }
  const visit = (value, path = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const location = path ? `${path}.${key}` : key;
      if ((path ? /sidebar|flat-project-sidebar|pinned.*sort/i : /project|workspace|sidebar|pinned|sort|group/i).test(key)) {
        console.log(JSON.stringify({ path: location, kind: Array.isArray(child) ? 'array' : typeof child,
          size: typeof child === 'object' && child ? Object.keys(child).length : undefined,
          keys: child && typeof child === 'object' && !Array.isArray(child) ? Object.keys(child).slice(0, 12) : undefined,
          itemKeys: Array.isArray(child) && child[0] && typeof child[0] === 'object' ? Object.keys(child[0]) : undefined,
          value: key === 'flat-project-sidebar-preferences-v1' ? child : undefined }));
      }
    }
  };
  visit(global);
  visit(global['electron-persisted-atom-state'], 'atom');
} finally { source.close(); }
