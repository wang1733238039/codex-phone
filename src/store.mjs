import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TRANSCRIPT_VERSION } from './transcript.mjs';

export const credentialHash = value => createHash('sha256').update(value).digest('hex');

export class Store {
  constructor(path, ownerId = 'personal') {
    mkdirSync(dirname(path), { recursive: true });
    this.ownerId = ownerId;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const old = this.db.prepare('PRAGMA table_info(threads)').all();
    if (old.length && !old.some(c => c.name === 'device_id')) {
      this.backupPath = `${path}.before-devices-${Date.now()}.sqlite`;
      this.db.prepare('VACUUM INTO ?').run(this.backupPath);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.primaryDeviceId = this.db.prepare("SELECT value FROM meta WHERE key='primaryDeviceId'").get()?.value || randomUUID();
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('primaryDeviceId', this.primaryDeviceId);
      const migrating = old.length && !old.some(c => c.name === 'device_id');
      if (migrating) for (const table of ['threads', 'details', 'commands']) this.db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          owner_id TEXT NOT NULL, id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE,
          created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, auto_name INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pairings (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS threads (
          owner_id TEXT NOT NULL, device_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(owner_id,device_id,id)
        );
        CREATE TABLE IF NOT EXISTS details (
          owner_id TEXT NOT NULL, device_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, synced INTEGER NOT NULL,
          PRIMARY KEY(owner_id,device_id,id)
        );
        CREATE TABLE IF NOT EXISTS commands (
          owner_id TEXT NOT NULL, device_id TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL,
          state TEXT NOT NULL, payload TEXT, created INTEGER NOT NULL, PRIMARY KEY(owner_id,device_id,id)
        );
        CREATE TABLE IF NOT EXISTS device_meta (
          owner_id TEXT NOT NULL, device_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          PRIMARY KEY(owner_id,device_id,key)
        );`);
      this.db.prepare('INSERT OR IGNORE INTO devices(owner_id,id,name,created,auto_name) VALUES (?,?,?,?,1)')
        .run(ownerId, this.primaryDeviceId, '我的电脑', Date.now());
      if (migrating) {
        for (const table of ['threads', 'details', 'commands']) {
          this.db.prepare(`INSERT INTO ${table} SELECT ?, ?, * FROM legacy_${table}`).run(ownerId, this.primaryDeviceId);
          this.db.exec(`DROP TABLE legacy_${table}`);
        }
        this.db.prepare("INSERT INTO device_meta SELECT ?, ?, key, value FROM meta WHERE key IN ('sidebar','lastSync')")
          .run(ownerId, this.primaryDeviceId);
        this.db.exec("DELETE FROM meta WHERE key IN ('sidebar','lastSync')");
      }
      this.db.exec("UPDATE commands SET state='unknown' WHERE state='pending';");
      if (this.db.prepare('PRAGMA user_version').get().user_version < 2) this.db.exec('PRAGMA user_version=2');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  scope(deviceId = this.primaryDeviceId) { return [this.ownerId, deviceId]; }
  forOwner(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) throw new Error('An authenticated owner is required');
    const scoped = Object.create(Store.prototype);
    scoped.db = this.db; scoped.ownerId = ownerId;
    scoped.primaryDeviceId = ownerId === this.ownerId && this.device(this.primaryDeviceId) ? this.primaryDeviceId
      : this.db.prepare('SELECT id FROM devices WHERE owner_id=? AND revoked=0 ORDER BY created,id LIMIT 1').get(ownerId)?.id || null;
    return Object.freeze(scoped);
  }
  initializePrimary(token) {
    if (token) this.db.prepare('UPDATE devices SET token_hash=? WHERE owner_id=? AND id=? AND token_hash IS NULL AND revoked=0')
      .run(credentialHash(token), ...this.scope());
  }
  devices() { return this.db.prepare('SELECT id,name,created FROM devices WHERE owner_id=? AND revoked=0 ORDER BY created,id').all(this.ownerId); }
  device(id) { return this.db.prepare('SELECT * FROM devices WHERE owner_id=? AND id=? AND revoked=0').get(...this.scope(id)); }
  authenticate(token) {
    if (typeof token !== 'string' || token.length > 512) return null;
    return this.db.prepare('SELECT owner_id,id FROM devices WHERE token_hash=? AND owner_id=? AND revoked=0').get(credentialHash(token), this.ownerId);
  }
  authenticateAny(token) {
    if (typeof token !== 'string' || token.length > 512) return null;
    return this.db.prepare('SELECT owner_id,id FROM devices WHERE token_hash=? AND revoked=0').get(credentialHash(token));
  }
  rename(id, name) { this.db.prepare('UPDATE devices SET name=?,auto_name=0 WHERE owner_id=? AND id=? AND revoked=0').run(name, ...this.scope(id)); }
  computerName(id, name) {
    if (typeof name === 'string' && name.trim()) this.db.prepare('UPDATE devices SET name=? WHERE owner_id=? AND id=? AND auto_name=1 AND revoked=0')
      .run(name.trim().slice(0, 80), ...this.scope(id));
  }
  revoke(id) { this.db.prepare('UPDATE devices SET revoked=1,token_hash=NULL WHERE owner_id=? AND id=?').run(...this.scope(id)); }
  pairing(hash, expires) {
    this.db.prepare('DELETE FROM pairings WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO pairings VALUES (?,?,?)').run(hash, this.ownerId, expires);
  }
  claim(hash, name, token, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pairing = this.db.prepare('SELECT * FROM pairings WHERE hash=? AND owner_id=? AND expires>?').get(hash, this.ownerId, now);
      if (!pairing) { this.db.exec('ROLLBACK'); return null; }
      const id = randomUUID();
      this.db.prepare('DELETE FROM pairings WHERE hash=?').run(hash);
      this.db.prepare('INSERT INTO devices(owner_id,id,name,token_hash,created) VALUES (?,?,?,?,?)')
        .run(this.ownerId, id, name, credentialHash(token), now);
      this.db.exec('COMMIT');
      return { id, name };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot(threads, sidebar = null, deviceId = this.primaryDeviceId) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM threads WHERE owner_id=? AND device_id=?').run(...this.scope(deviceId));
      const stmt = this.db.prepare('INSERT INTO threads VALUES (?,?,?,?)');
      for (const thread of threads) stmt.run(...this.scope(deviceId), thread.id, JSON.stringify(thread));
      this.setMeta(deviceId, 'lastSync', String(Date.now()));
      this.setMeta(deviceId, 'sidebar', JSON.stringify(sidebar || { projects: [] }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setMeta(deviceId, key, value) { this.db.prepare('INSERT OR REPLACE INTO device_meta VALUES (?,?,?,?)').run(...this.scope(deviceId), key, value); }
  getMeta(deviceId, key) { return this.db.prepare('SELECT value FROM device_meta WHERE owner_id=? AND device_id=? AND key=?').get(...this.scope(deviceId), key)?.value; }
  list(deviceId = this.primaryDeviceId) { return this.db.prepare('SELECT payload FROM threads WHERE owner_id=? AND device_id=?').all(...this.scope(deviceId)).map(x => JSON.parse(x.payload)); }
  sidebar(deviceId = this.primaryDeviceId) { return JSON.parse(this.getMeta(deviceId, 'sidebar') || '{"projects":[]}'); }
  thread(id, deviceId = this.primaryDeviceId) { const r = this.db.prepare('SELECT payload FROM threads WHERE owner_id=? AND device_id=? AND id=?').get(...this.scope(deviceId), id); return r ? JSON.parse(r.payload) : null; }
  saveThread(thread, deviceId) { this.db.prepare('INSERT OR REPLACE INTO threads VALUES (?,?,?,?)').run(...this.scope(deviceId), thread.id, JSON.stringify(thread)); }
  saveDetail(id, detail, deviceId = this.primaryDeviceId) {
    this.db.prepare('INSERT OR REPLACE INTO details VALUES (?,?,?,?,?)').run(...this.scope(deviceId), id, JSON.stringify(detail), Date.now());
  }
  detail(id, deviceId = this.primaryDeviceId) {
    const r = this.db.prepare('SELECT * FROM details WHERE owner_id=? AND device_id=? AND id=?').get(...this.scope(deviceId), id);
    if (!r) return null;
    const detail = JSON.parse(r.payload);
    // Re-read old caches on connection rather than exposing unclassified messages offline.
    if (detail.transcriptVersion !== TRANSCRIPT_VERSION) return null;
    return { ...detail, messages: detail.messages.filter(m => m.role === 'user' || (m.role === 'assistant' && m.phase === 'final_answer')), syncedAt: r.synced };
  }
  command(deviceId, id) { return this.db.prepare('SELECT * FROM commands WHERE owner_id=? AND device_id=? AND id=?').get(...this.scope(deviceId), id); }
  beginCommand(deviceId, id, threadId) {
    this.db.prepare("INSERT INTO commands VALUES (?,?,?,?,'pending',NULL,?)").run(...this.scope(deviceId), id, threadId, Date.now());
  }
  finishCommand(deviceId, id, state, payload) {
    this.db.prepare('UPDATE commands SET state=?,payload=? WHERE owner_id=? AND device_id=? AND id=?')
      .run(state, JSON.stringify(payload), ...this.scope(deviceId), id);
  }
  lastSync(deviceId = this.primaryDeviceId) { return Number(this.getMeta(deviceId, 'lastSync') || 0); }
  close() { this.db.close(); }
}
