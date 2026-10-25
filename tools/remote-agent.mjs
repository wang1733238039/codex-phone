import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from '../src/agent.mjs';
import { ROOT } from '../src/config.mjs';

const config = JSON.parse(readFileSync(resolve(ROOT, '.data', 'agent.remote.json'), 'utf8'));
if (new URL(config.serverUrl).protocol !== 'https:') throw new Error('The remote agent requires HTTPS');
const agent = new Agent(config);
agent.start();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { agent.close(); process.exit(0); });
