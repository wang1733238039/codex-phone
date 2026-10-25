import { readFileSync } from 'node:fs';
import { ROOT } from '../src/config.mjs';
import { resolve } from 'node:path';
const origin = 'http://127.0.0.1:3819';
const password = readFileSync(resolve(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
const res = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
const cookie = res.headers.get('set-cookie').split(';')[0];
const list = await (await fetch(origin + '/api/threads', { headers: { Cookie: cookie } })).json();
console.log(JSON.stringify({ online: list.online, total: list.total, archivedCount: list.archivedCount }));
for (const t of list.threads.slice(0, 4)) {
  const res = await fetch(origin + `/api/threads/${t.id}?refresh=1`, { headers: { Cookie: cookie } }); const d = await res.json();
  console.log(JSON.stringify({ id: t.id, local: t.local, status: res.status, messages: d.messages?.length, total: d.total, error: d.error, running: d.running }));
}
