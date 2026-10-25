import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig(kind) {
  const path = process.env[kind === 'server' ? 'SERVER_CONFIG' : 'AGENT_CONFIG'] || resolve(ROOT, '.data', `${kind}.json`);
  try { return { ...JSON.parse(readFileSync(path, 'utf8')), configPath: path }; }
  catch (error) { throw new Error(`Cannot read ${kind} config at ${path}. Run npm run setup first. ${error.message}`); }
}
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  return Boolean(salt && hash) && equalSecret(hashPassword(password, salt), stored);
}
