import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dbPath = join(root, '.data', 'cache.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x) => x.name);
  const result = { tables };
  for (const table of tables) {
    if (!/threads|commands|devices|device_meta/i.test(table)) continue;
    try {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      result[table] = rows.map((row) => {
        const safe = { ...row };
        for (const key of Object.keys(safe)) {
          if (/token|secret|password|cookie|payload/i.test(key)) {
            if (key === 'payload' && typeof safe[key] === 'string') {
              try {
                const p = JSON.parse(safe[key]);
                safe[key] = { id: p.id, title: p.title, running: p.running, updatedAt: p.updatedAt, archived: p.archived, local: p.local, cwd: p.cwd };
              } catch { safe[key] = '[json]'; }
            } else safe[key] = '[redacted]';
          }
        }
        return safe;
      });
    } catch (error) { result[table] = { error: error.message }; }
  }
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
