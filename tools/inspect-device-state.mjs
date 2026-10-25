// Read only. Print status metadata, never credentials or conversation content.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.mjs';
const password = readFileSync(join(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
for (const origin of [process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819']) {
  const login = await fetch(origin + '/api/login', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }), signal: AbortSignal.timeout(15000) });
  if (!login.ok) throw new Error(`Login failed: ${origin} ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
  try {
    const devices = await (await fetch(origin + '/api/devices', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) })).json();
    const status = await Promise.all(devices.devices.map(async device => {
      const response = await fetch(`${origin}/api/devices/${device.id}/status`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Status failed: ${response.status}`);
      const data = await response.json();
      return { deviceId: device.id, online: data.online, connectorVersion: data.connectorVersion, capabilities: data.capabilities,
        activeTurns: data.activeTurns?.length || 0, approvals: data.approvals?.length || 0 };
    }));
    console.log(JSON.stringify({ origin, devices: status }));
  } finally {
    await fetch(origin + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, signal: AbortSignal.timeout(15000) });
  }
}
