import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { ROOT } from '../src/config.mjs';

const config = JSON.parse(readFileSync(process.env.AGENT_CONFIG || resolve(ROOT, '.data', 'agent.remote.json'), 'utf8'));
const url = new URL('/agent', config.serverUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.agentToken}`, ...(config.deviceId ? { 'X-Device-Id': config.deviceId } : {}) }, handshakeTimeout: 10000 });
const timer = setTimeout(() => { console.error('Connection check timed out'); ws.terminate(); process.exitCode = 1; }, 12000);
function finish(data, code = 0) { clearTimeout(timer); console.log(JSON.stringify(data)); process.exitCode = code; ws.close(); }
ws.on('message', raw => {
  const data = JSON.parse(raw);
  if (data.type === 'hello') finish({ authenticated: true, server: config.serverUrl, computer: config.computerName, deviceId: data.deviceId });
});
ws.on('unexpected-response', (_, res) => {
  res.resume(); clearTimeout(timer);
  if (res.statusCode === 409) finish({ connectorAlreadyOnline: true, server: config.serverUrl, computer: config.computerName, deviceId: config.deviceId || 'legacy-primary' });
  else finish({ authenticated: false, status: res.statusCode }, 1);
  ws.terminate();
});
ws.on('error', () => { clearTimeout(timer); console.error('Connection check failed'); process.exitCode = 1; });
