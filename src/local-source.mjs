import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, createReadStream, realpathSync, existsSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Transcript } from './transcript.mjs';
import { resolveSidebar } from './sidebar.mjs';
import { ActivityIndex } from './activity.mjs';
import { localFamily, threadSource, validThreadId } from './thread-family.mjs';
export { validThreadId } from './thread-family.mjs';

export class LocalSource {
  constructor(home) {
    this.home = realpathSync.native(home);
    this.activity = new ActivityIndex(this.home);
    this.cache = new Map();
    const files = readdirSync(home).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!files.length) throw new Error('Codex state database not found');
    this.runningCacheTtlMs = 1500;
    this.db = new DatabaseSync(join(home, files[0]), { readOnly: true });
    this.db.exec('PRAGMA busy_timeout=3000');
    this.columns = new Set(this.db.prepare('PRAGMA table_info(threads)').all().map(c => c.name));
    for (const col of ['id', 'rollout_path', 'title', 'cwd']) if (!this.columns.has(col)) throw new Error(`Unsupported Codex schema: missing ${col}`);
  }
  list() { return this.snapshot().threads; }
  snapshot() {
    let settings = {};
    try { settings = JSON.parse(readFileSync(join(this.home, '.codex-global-state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.db.exec('BEGIN');
    try {
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name));
      const read = name => tables.has(name) ? this.db.prepare(`SELECT * FROM ${name}`).all() : [];
      const allRows = this.db.prepare('SELECT * FROM threads ORDER BY updated_at DESC').all();
      const { roots: rows, children } = localFamily(allRows, read('thread_spawn_edges'));
      const { sidebar, threadFields } = resolveSidebar(rows, { projects: read('projects'), roots: read('project_roots'), sections: read('thread_sections'), settings, home: this.home });
      const projectRow = r => ({
        id: r.id, title: r.name || r.title || '未命名会话', preview: (r.preview || r.first_user_message || '').slice(0, 250),
        cwd: r.cwd, createdAt: r.created_at_ms || r.created_at * 1000,
        updatedAt: r.recency_at_ms || r.updated_at_ms || r.updated_at * 1000,
        archived: Boolean(r.archived), ...threadFields.get(r.id), model: r.model || '',
        provider: r.model_provider || '', source: r.source || '',
        local: this.isLocal(r),
        activity: this.activity.read(r),
      });
      const childThreads = children.map(r => ({
        ...projectRow(r), title: (r.name || r.agent_nickname || r.title || '子对话').slice(0, 160),
        projectId: threadFields.get(r.rootThreadId)?.projectId || null,
        projectName: threadFields.get(r.rootThreadId)?.projectName || null,
        parentThreadId: r.parentThreadId, rootThreadId: r.rootThreadId, depth: r.depth, readOnly: !this.isLocal(r) || Boolean(r.archived),
        historyAvailable: Boolean(r.rollout_path && existsSync(r.rollout_path)),
      }));
      const counts = new Map();
      for (const child of childThreads) counts.set(child.rootThreadId, (counts.get(child.rootThreadId) || 0) + 1);
      const threads = rows.map(r => ({ ...projectRow(r), childCount: counts.get(r.id) || 0 }));
      return { threads, childThreads, sidebar };
    } finally { this.db.exec('ROLLBACK'); }
  }
  isLocal(row) { return Boolean(row.cwd && isAbsolute(row.cwd) && existsSync(row.cwd) && row.rollout_path && existsSync(row.rollout_path)); }
  row(id) {
    if (!validThreadId(id)) throw new Error('Invalid thread ID');
    const row = this.db.prepare('SELECT * FROM threads WHERE id=?').get(id);
    if (!row) throw new Error('Thread not found');
    return row;
  }
  isChild(row) {
    const source = threadSource(row);
    if (source.subagent || source.parentId) return true;
    const hasEdges = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get();
    return Boolean(hasEdges && this.db.prepare('SELECT 1 FROM thread_spawn_edges WHERE child_thread_id=?').get(row.id));
  }
  async detail(id) {
    const row = this.row(id);
    if (!row.rollout_path || !existsSync(row.rollout_path)) throw new Error('会话文件不在此电脑，无法读取该历史');
    const path = realpathSync.native(row.rollout_path);
    const allowed = ['sessions', 'archived_sessions'].some(folder => {
      const rel = relative(join(this.home, folder), path);
      return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    });
    if (!allowed) throw new Error('Session path is outside the Codex session directories');
    const stat = statSync(path), signature = `${path}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.cache.get(id);
    const cacheFresh = cached && cached.signature === signature &&
      (!cached.detail.running || Date.now() - cached.cachedAt < this.runningCacheTtlMs);
    if (cacheFresh) return { ...cached.detail };
    if (stat.size > 256 * 1024 * 1024) throw new Error('会话文件超过 256 MB，暂不支持在手机读取');
    const child = this.isChild(row);
    const transcript = new Transcript(child ? { childThreadId: id } : {});
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        transcript.push(entry);
      }
    } finally { lines.close(); stream.destroy(); }
    const detail = { id, ...transcript.finish(), readAt: Date.now(), ...(child ? { readOnly: !this.isLocal(row) || Boolean(row.archived) } : {}) };
    this.cache.set(id, { signature, detail, cachedAt: Date.now() });
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    return { ...detail };
  }
  close() { this.db.close(); }
}
