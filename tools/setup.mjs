import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir, networkInterfaces, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, hashPassword } from '../src/config.mjs';

const dir = resolve(ROOT, '.data');
if (existsSync(join(dir, 'server.json')) || existsSync(join(dir, 'agent.json'))) {
  console.log('Configuration already exists. It was not overwritten.'); process.exit(0);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const ips = [...new Set(Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)).map(i => i.address))];
const password = randomBytes(18).toString('base64url'), agentToken = randomBytes(48).toString('base64url');
const found = process.platform === 'win32' ? spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/).find(p => p.endsWith('.exe')) : null;
const server = { host: '0.0.0.0', port: 3819, allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...ips], username: 'admin', passwordHash: hashPassword(password), agentToken, controlsEnabled: true };
const agent = { serverUrl: 'http://127.0.0.1:3819', codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'), codexBin: found || 'codex', agentToken, computerName: hostname(), controlsEnabled: true };
for (const [name, value] of [['server', server], ['agent', agent]]) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
const urls = ['http://127.0.0.1:3819', ...ips.map(ip => `http://${ip}:3819`)];
writeFileSync(join(dir, 'login.md'), `# Codex 随行登录资料\n\n账号：admin\n\n密码：\`${password}\`\n\n${urls.map(url => `- ${url}`).join('\n')}\n\n本地地址只适用于这台电脑或同一局域网。公网地址需要另行部署。此文件含密码，请勿公开。\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`Configuration created. Login details: ${join(dir, 'login.md')}\nLocal URLs:\n${urls.join('\n')}`);
