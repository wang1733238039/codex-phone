import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const db = new DatabaseSync(join(homedir(), '.codex', 'state_5.sqlite'), { readOnly: true });
console.log('COLUMNS', JSON.stringify(db.prepare('PRAGMA table_info(threads)').all().map(x => ({ name: x.name, type: x.type }))));
console.log('COUNTS', JSON.stringify(db.prepare('SELECT archived, count(*) as count FROM threads GROUP BY archived').all()));
db.close();
const mode = process.argv[2] || 'proxy';
const proc = spawn('codex', ['app-server', ...(mode === 'proxy' ? ['proxy'] : ['--stdio'])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let seq = 0;
const pending = new Map();
const lines = createInterface({ input: proc.stdout });
lines.on('line', line => {
  try {
    const data = JSON.parse(line);
    if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
  } catch {}
});
proc.stderr.on('data', d => console.log('STDERR', d.toString().slice(0, 700)));
proc.on('error', error => console.log('SPAWN_ERROR', error.message));
proc.on('exit', code => console.log('EXIT', code));
const timer = setTimeout(() => { proc.kill(); process.exit(1); }, 20000);
async function rpc(method, params) {
  const id = ++seq;
  const p = new Promise(resolve => pending.set(id, resolve));
  proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  return p;
}
const init = await rpc('initialize', { clientInfo: { name: 'codex_phone_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
console.log('INIT', JSON.stringify(init));
proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
const result = await rpc('thread/list', { limit: 2, modelProviders: [] });
if (result.result) {
  const threads = result.result.data;
  console.log('THREAD_LIST', JSON.stringify({ keys: Object.keys(result.result), count: threads.length, firstKeys: Object.keys(threads[0] || {}), firstId: threads[0]?.id, status: threads[0]?.status }));
  if (threads[0]) {
    const detail = await rpc('thread/read', { threadId: threads[0].id, includeTurns: true });
    console.log('READ', JSON.stringify(detail.error || { keys: Object.keys(detail.result || {}), turnCount: detail.result?.thread?.turns?.length, turnKeys: Object.keys(detail.result?.thread?.turns?.[0] || {}), itemTypes: [...new Set((detail.result?.thread?.turns || []).flatMap(t => t.items || []).map(i => i.type))], status: detail.result?.thread?.status }));
  }
} else console.log('LIST_ERROR', JSON.stringify(result.error));
clearTimeout(timer);
proc.kill();
