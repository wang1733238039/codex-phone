import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { LocalSource } from '../src/local-source.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';

const source = new LocalSource(loadConfig('agent').codexHome);
try {
  const ids = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  for (const id of ids) {
    const detail = await source.detail(id);
    assert.ok(detail.messages.every(m => m.role === 'user' || (m.role === 'assistant' && m.phase === 'final_answer')));
    console.log(JSON.stringify({ id, total: detail.messages.length, users: detail.messages.filter(m => m.role === 'user').length,
      finals: detail.messages.filter(m => m.role === 'assistant').length, running: detail.running, transcriptVersion: detail.transcriptVersion }));
  }
  if (process.argv.includes('--live')) {
    const origin = 'http://127.0.0.1:3819';
    const password = readFileSync(join(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await login.json();
    const request = async path => (await fetch(origin + path, { headers: { Cookie: cookie } })).json();
    const status = await request('/api/status');
    console.log(JSON.stringify({ online: status.online, activePhoneTasks: status.activeTurns.length }));
    for (const id of ids) {
      const detail = await request(`/api/threads/${id}?refresh=1`), expected = await source.detail(id);
      assert.equal(detail.transcriptVersion, 2);
      assert.deepEqual(detail.messages.map(m => [m.role, m.text]), expected.messages.slice(-80).map(m => [m.role, m.text]));
      console.log(JSON.stringify({ id, liveVerified: true, total: detail.total, fromCache: detail.fromCache }));
    }
    await fetch(`${origin}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: '{}' });
  }
} finally { source.close(); }
