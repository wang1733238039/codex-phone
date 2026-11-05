import { readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validThreadId } from './thread-family.mjs';

// Ordinary native forks can be created while the desktop holds the parent.
// Only forks created here and confirmed by native metadata join a phone family.
export class PhoneChildren {
  constructor(home) { this.home = realpathSync.native(home); this.path = join(this.home, '.codex-phone-children.json'); this.verified = new Map(); }
  entries() {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.children)) throw new Error('Invalid child registry');
      return value.children;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  metadata(row) {
    let fd;
    try {
      const path = realpathSync.native(row.rollout_path);
      const rel = relative(join(this.home, 'sessions'), path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      const stat = statSync(path), key = `${path}:${stat.birthtimeMs}`;
      if (this.verified.has(key)) return this.verified.get(key);
      fd = openSync(path, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
      const size = readSync(fd, buffer, 0, buffer.length, 0), end = buffer.indexOf(10, 0);
      if (end < 0 || end >= size) return null;
      const entry = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      const meta = entry.type === 'session_meta' ? entry.payload : null;
      if ((meta?.id || meta?.session_id) !== row.id) return null;
      const relation = { forked_from_id: meta.forked_from_id };
      this.verified.set(key, relation);
      return relation;
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  }
  decorate(rows) {
    const entries = new Map(this.entries().map(entry => [entry.id, entry]));
    return rows.map(row => {
      const entry = entries.get(row.id);
      if (!entry || !validThreadId(entry.parentId) || entry.parentId === row.id ||
          !Number.isSafeInteger(entry.historyStart) || entry.historyStart < 0 ||
          this.metadata(row)?.forked_from_id !== entry.parentId) return row;
      return { ...row, phone_child_parent_id: entry.parentId, phone_child_history_start: entry.historyStart };
    });
  }
  register(row, parentId) {
    if (!validThreadId(row.id) || !validThreadId(parentId) || row.id === parentId ||
        this.metadata(row)?.forked_from_id !== parentId) throw new Error('原生分支的父子关系未通过核验');
    const historyStart = statSync(row.rollout_path).size;
    const children = this.entries().filter(entry => entry.id !== row.id);
    children.push({ id: row.id, parentId, historyStart });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, children }) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
