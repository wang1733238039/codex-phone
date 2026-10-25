import { writeFileSync, copyFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
const url = new URL(process.argv[2] || 'invalid');
if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Usage: node tools/connect.mjs https://your-domain.example');
const { configPath, ...config } = loadConfig('agent');
copyFileSync(configPath, `${configPath}.backup`);
config.serverUrl = url.origin;
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
console.log('Agent URL updated. Restart the agent to connect. Previous config saved as agent.json.backup.');
