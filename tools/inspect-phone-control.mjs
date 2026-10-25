import { LocalSource } from '../src/local-source.mjs';
import { loadConfig } from '../src/config.mjs';

const config = loadConfig('agent');
const source = new LocalSource(config.codexHome);
try {
  const snapshot = source.snapshot();
  const rows = [];
  for (const row of snapshot.threads.filter((row) => /手机|phone|codex/i.test(`${row.title ?? ''} ${row.name ?? ''} ${row.preview ?? ''}`))) {
      let detail;
      try { detail = await source.detail(row.id); } catch (error) { detail = { error: error.message }; }
      rows.push({
        id: row.id,
        title: row.title ?? row.name ?? '',
        archived: Boolean(row.archived),
        cwd: row.cwd,
        rowRunning: Boolean(row.running),
        detailRunning: Boolean(detail?.running),
        local: source.isLocal(row),
        updatedAt: row.updatedAt ?? row.updated_at ?? null,
        detailError: detail?.error ?? null,
      });
  }
  console.log(JSON.stringify({
    computerName: config.computerName,
    controlsEnabled: Boolean(config.controlsEnabled),
    threadCount: snapshot.threads.length,
    matches: rows,
  }, null, 2));
} finally {
  source.close();
}
