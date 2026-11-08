import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { Transcript } from './transcript.mjs';
import { resolveSidebar } from './sidebar.mjs';
import { ActivityIndex } from './activity.mjs';
import { localFamily, threadSource, validThreadId } from './thread-family.mjs';
import { PhoneChildren } from './phone-children.mjs';
import { resolveRollout, rolloutLines } from './rollout.mjs';
export { validThreadId } from './thread-family.mjs';

export class LocalSource {
  constructor(home) {
    this.home = realpathSync.native(home);
    this.phoneChildren = new PhoneChildren(this.home);
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
      const allRows = this.phoneChildren.decorate(this.db.prepare('SELECT * FROM threads ORDER BY updated_at DESC').all());
      const { roots: rows, children } = localFamily(allRows, read('thread_spawn_edges'));
      const { sidebar, threadFields } = resolveSidebar(rows, { projects: read('projects'), roots: read('project_roots'), sections: read('thread_sections'), settings, home: this.home });
      const projectRow = r => {
        const historyAvailable = this.historyAvailable(r), local = this.isLocal(r);
        return {
        id: r.id, title: r.name || r.title || '未命名会话', preview: (r.preview || r.first_user_message || '').slice(0, 250),
        cwd: r.cwd, createdAt: r.created_at_ms || r.created_at * 1000,
        updatedAt: r.recency_at_ms || r.updated_at_ms || r.updated_at * 1000,
        archived: Boolean(r.archived), ...threadFields.get(r.id), model: r.model || '',
        provider: r.model_provider || '', source: r.source || '',
        local, historyAvailable,
        ...(!local ? { unavailableReason: historyAvailable
          ? '原工作目录不可用，只能查看历史；请先在电脑恢复该目录'
          : '会话历史文件不可用，请在电脑核对记录是否完整' } : {}),
        activity: this.activity.read(r),
      }; };
      const childThreads = children.map(r => ({
        ...projectRow(r), title: (r.name || r.agent_nickname || r.title || '子对话').slice(0, 160),
        projectId: threadFields.get(r.rootThreadId)?.projectId || null,
        projectName: threadFields.get(r.rootThreadId)?.projectName || null,
        parentThreadId: r.parentThreadId, rootThreadId: r.rootThreadId, depth: r.depth, readOnly: !this.isLocal(r) || Boolean(r.archived),
        historyAvailable: this.historyAvailable(r),
      }));
      const counts = new Map();
      for (const child of childThreads) counts.set(child.rootThreadId, (counts.get(child.rootThreadId) || 0) + 1);
      const threads = rows.map(r => ({ ...projectRow(r), childCount: counts.get(r.id) || 0 }));
      return { threads, childThreads, sidebar };
    } finally { this.db.exec('ROLLBACK'); }
  }
  historyAvailable(row) {
    try { resolveRollout(this.home, row.rollout_path); return true; } catch { return false; }
  }
  isLocal(row) {
    try { return Boolean(row.cwd && isAbsolute(row.cwd) && statSync(row.cwd).isDirectory() && this.historyAvailable(row)); }
    catch { return false; }
  }
  row(id) {
    if (!validThreadId(id)) throw new Error('Invalid thread ID');
    const row = this.db.prepare('SELECT * FROM threads WHERE id=?').get(id);
    if (!row) throw new Error('Thread not found');
    return this.phoneChildren.decorate([row])[0];
  }
  registerChild(id, parentId) { this.phoneChildren.register(this.row(id), parentId); }
  isChild(row) {
    const source = threadSource(row);
    if (source.subagent || source.parentId) return true;
    const hasEdges = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get();
    return Boolean(hasEdges && this.db.prepare('SELECT 1 FROM thread_spawn_edges WHERE child_thread_id=?').get(row.id));
  }
  async detail(id) {
    const row = this.row(id);
    const storage = resolveRollout(this.home, row.rollout_path);
    const historyStart = row.phone_child_history_start;
    const { path, stat } = storage, signature = `${path}:${stat.size}:${stat.mtimeMs}:${historyStart ?? ''}`;
    const cached = this.cache.get(id);
    const cacheFresh = cached && cached.signature === signature &&
      (!cached.detail.running || Date.now() - cached.cachedAt < this.runningCacheTtlMs);
    if (cacheFresh) return { ...cached.detail };
    const child = this.isChild(row);
    const transcript = new Transcript(child && historyStart == null ? { childThreadId: id } : {});
    for await (const line of rolloutLines(storage, { start: historyStart ?? 0 })) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      transcript.push(entry);
    }
    const detail = { id, ...transcript.finish(), readAt: Date.now(), ...(child ? { readOnly: !this.isLocal(row) || Boolean(row.archived) } : {}) };
    this.cache.set(id, { signature, detail, cachedAt: Date.now() });
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    return { ...detail };
  }
  close() { this.db.close(); }
}
