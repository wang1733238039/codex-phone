import { randomUUID, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { credentialHash } from './store.mjs';

const derive = promisify(scrypt);
const DAY = 86400000;
export class AccountError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AccountError(status, message); };
export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `${label}应为 ${min}–${max} 的整数`);
  return value;
}
function username(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.@-]{2,79}$/i.test(value.trim())) fail(400, '账号应为 3–80 位字母、数字或 _.@-');
  return value.trim().toLowerCase();
}
export async function passwordHash(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) fail(400, '新密码应为 10–128 个字符');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(value, salt, 64)).toString('hex')}`;
}
async function verify(value, stored) {
  const [salt, hex] = String(stored).split(':');
  if (typeof value !== 'string' || value.length > 500 || !salt || !/^[a-f0-9]{128}$/i.test(hex || '')) return false;
  const actual = await derive(value, salt, 64), expected = Buffer.from(hex, 'hex');
  return timingSafeEqual(actual, expected);
}

export class Accounts {
  constructor(store, config) {
    this.store = store; this.db = store.db; this.config = config;
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE name='accounts'").get();
    if (!existing && this.db.prepare('SELECT id FROM devices WHERE token_hash IS NOT NULL LIMIT 1').get()) {
      this.backupPath = `${this.db.location()}.before-accounts-${Date.now()}.sqlite`;
      this.db.prepare('VACUUM INTO ?').run(this.backupPath);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT,
        role TEXT NOT NULL CHECK(role IN ('admin','member')), status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','disabled','deleted')),
        expires_at INTEGER, device_limit INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
        expires_at INTEGER NOT NULL, service_days INTEGER NOT NULL, device_limit INTEGER NOT NULL,
        created_at INTEGER NOT NULL, claimed_at INTEGER, claimed_by TEXT, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS account_audit (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS devices_owner ON devices(owner_id,revoked);
      CREATE INDEX IF NOT EXISTS accounts_expiry ON accounts(status,expires_at);`);
      if (!existing) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO accounts VALUES (?,?,?,'admin','active',NULL,50,?,?)`)
          .run(store.ownerId, config.username || 'admin', config.passwordHash, now, now);
      }
      const columns = this.db.prepare('PRAGMA table_info(sessions)').all();
      if (!columns.some(c => c.name === 'owner_id')) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
        this.db.prepare('UPDATE sessions SET owner_id=?').run(store.ownerId);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_id); PRAGMA user_version=3; COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // Equal-cost unknown-account verification; never store or return this password.
    this.dummyHash = config.passwordHash;
  }
  get(id) { return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id); }
  access(account, now = Date.now()) {
    if (!account || account.status === 'deleted') return 'deleted';
    if (account.status !== 'active') return 'disabled';
    return account.expires_at !== null && account.expires_at <= now ? 'expired' : 'active';
  }
  requireActive(id) {
    const account = this.get(id), access = this.access(account);
    if (access !== 'active') fail(access === 'expired' ? 402 : 403, access === 'expired' ? '套餐已到期，请联系管理员续期；仍可查看自己的缓存' : '账号已停用');
    return account;
  }
  public(account) {
    return { id: account.id, username: account.username, role: account.role, status: account.status,
      accessState: this.access(account), expiresAt: account.expires_at, deviceLimit: account.device_limit,
      deviceCount: this.db.prepare('SELECT COUNT(*) n FROM devices WHERE owner_id=? AND revoked=0').get(account.id).n,
      createdAt: account.created_at };
  }
  audit(actor, target, action) {
    this.db.prepare('INSERT INTO account_audit VALUES(?,?,?,?,?)').run(randomUUID(), actor, target, action, Date.now());
  }
  async authenticate(name, password) {
    const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
    const account = normalized.length <= 100 ? this.db.prepare('SELECT * FROM accounts WHERE username=?').get(normalized) : null;
    const matches = await verify(password, account?.password_hash || this.dummyHash);
    // Re-read after asynchronous password verification: a concurrent suspension/reset must win.
    const current = account && this.get(account.id);
    return matches && current?.password_hash === account.password_hash && current.status === 'active' ? current : null;
  }
  async checkPassword(id, value) {
    const account = this.get(id), matches = await verify(value, account?.password_hash || this.dummyHash);
    const current = this.get(id);
    return Boolean(matches && current?.password_hash === account.password_hash && current.status === 'active');
  }
  async create(data, actor) {
    const name = username(data.username), hash = await passwordHash(data.password);
    const days = integer(data.serviceDays ?? 30, 1, 3660, '服务天数');
    const deviceLimit = integer(data.deviceLimit ?? this.config.defaultDeviceLimit ?? 3, 1, 50, '电脑上限');
    this.requireAdmin(actor);
    return this.insert(name, hash, days, deviceLimit, actor);
  }
  insert(name, hash, days, deviceLimit, actor) {
    if (this.db.prepare('SELECT id FROM accounts WHERE username=?').get(name)) fail(409, '此账号已被使用');
    const id = randomUUID(), now = Date.now();
    this.db.prepare("INSERT INTO accounts VALUES (?,?,?,'member','active',?,?,?,?)")
      .run(id, name, hash, now + days * DAY, deviceLimit, now, now);
    this.audit(actor, id, 'account.create'); return this.get(id);
  }
  requireAdmin(id) {
    const account = this.requireActive(id);
    if (account.role !== 'admin') fail(403, '仅管理员可以执行此操作');
    return account;
  }
  list(search = '', offset = 0) {
    const value = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const where = "status!='deleted' AND username LIKE ? ESCAPE '\\'";
    const total = this.db.prepare(`SELECT COUNT(*) n FROM accounts WHERE ${where}`).get(value).n;
    const rows = this.db.prepare(`SELECT * FROM accounts WHERE ${where} ORDER BY created_at DESC,id LIMIT 100 OFFSET ?`).all(value, offset);
    return { accounts: rows.map(a => this.public(a)), total, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }
  invite(data, actor) {
    this.requireAdmin(actor);
    const days = integer(data.serviceDays ?? 30, 1, 3660, '服务天数');
    const deviceLimit = integer(data.deviceLimit ?? this.config.defaultDeviceLimit ?? 3, 1, 50, '电脑上限');
    const validityDays = integer(data.validityDays ?? 7, 1, 30, '邀请有效天数');
    const code = randomBytes(32).toString('base64url'), id = randomUUID(), now = Date.now();
    const expiresAt = now + validityDays * DAY;
    this.db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL)')
      .run(id, credentialHash(code), actor, expiresAt, days, deviceLimit, now);
    this.audit(actor, id, 'invitation.create');
    return { id, code, expiresAt, serviceDays: days, deviceLimit };
  }
  invitations() {
    return this.db.prepare(`SELECT id,expires_at AS expiresAt,service_days AS serviceDays,device_limit AS deviceLimit,
      created_at AS createdAt,claimed_at AS claimedAt,revoked_at AS revokedAt
      FROM invitations ORDER BY created_at DESC LIMIT 100`).all();
  }
  revokeInvitation(id, actor) {
    this.requireAdmin(actor);
    if (!this.db.prepare('SELECT id FROM invitations WHERE id=?').get(id)) fail(404, '找不到邀请');
    this.db.prepare('UPDATE invitations SET revoked_at=? WHERE id=? AND claimed_at IS NULL').run(Date.now(), id);
    this.audit(actor, id, 'invitation.revoke');
  }
  async register(data) {
    if (typeof data.code !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(data.code)) fail(400, '邀请链接无效或已过期');
    const name = username(data.username), hash = await passwordHash(data.password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT * FROM invitations WHERE hash=? AND expires_at>? AND claimed_at IS NULL AND revoked_at IS NULL')
        .get(credentialHash(data.code), Date.now());
      if (!invite || this.access(this.get(invite.created_by)) !== 'active') fail(400, '邀请链接无效或已过期');
      const account = this.insert(name, hash, invite.service_days, invite.device_limit, invite.created_by);
      this.db.prepare('UPDATE invitations SET claimed_at=?,claimed_by=? WHERE id=?').run(Date.now(), account.id, invite.id);
      this.db.exec('COMMIT'); return account;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  update(id, data, actor) {
    this.requireAdmin(actor);
    const account = this.get(id);
    if (!account || account.status === 'deleted') fail(404, '找不到账号');
    if (account.role === 'admin') fail(403, '此入口只管理普通用户，管理员密码请在账户页修改');
    const allowed = ['status', 'extendDays', 'deviceLimit', 'expiresAt'];
    if (!Object.keys(data).length || Object.keys(data).some(k => !allowed.includes(k))) fail(400, '账号更新参数无效');
    let expiry = account.expires_at, status = account.status, deviceLimit = account.device_limit;
    if ('extendDays' in data) expiry = Math.max(Date.now(), expiry || Date.now()) + integer(data.extendDays, 1, 3660, '续期天数') * DAY;
    if ('expiresAt' in data) {
      if ('extendDays' in data || !Number.isSafeInteger(data.expiresAt) || data.expiresAt < 0 || data.expiresAt > Date.now() + 3660 * DAY) fail(400, '到期时间无效');
      expiry = data.expiresAt;
    }
    if ('status' in data) {
      if (!['active', 'disabled'].includes(data.status)) fail(400, '账号状态无效');
      status = data.status;
    }
    if ('deviceLimit' in data) deviceLimit = integer(data.deviceLimit, 1, 50, '电脑上限');
    this.db.prepare('UPDATE accounts SET status=?,expires_at=?,device_limit=?,updated_at=? WHERE id=?')
      .run(status, expiry, deviceLimit, Date.now(), id);
    this.audit(actor, id, 'account.update'); return this.get(id);
  }
  async changePassword(id, current, next) {
    if (!await this.checkPassword(id, current)) fail(403, '当前密码不正确');
    const oldHash = this.get(id).password_hash, hash = await passwordHash(next);
    const result = this.db.prepare("UPDATE accounts SET password_hash=?,updated_at=? WHERE id=? AND password_hash=? AND status='active'")
      .run(hash, Date.now(), id, oldHash);
    if (!result.changes) fail(409, '账号状态已变化，请重新登录');
    this.audit(id, id, 'password.change');
  }
  async resetPassword(id, next, actor) {
    const hash = await passwordHash(next); this.requireAdmin(actor);
    const account = this.get(id);
    if (!account || account.status === 'deleted') fail(404, '找不到账号');
    if (account.role === 'admin') fail(403, '管理员密码请在账户页修改');
    this.db.prepare('UPDATE accounts SET password_hash=?,updated_at=? WHERE id=?').run(hash, Date.now(), id);
    this.audit(actor, id, 'password.reset');
  }
  claimDevice(hash, name, token) {
    const pairing = this.db.prepare('SELECT owner_id FROM pairings WHERE hash=? AND expires>?').get(hash, Date.now());
    if (!pairing || this.access(this.get(pairing.owner_id)) !== 'active') return null;
    const account = this.get(pairing.owner_id), scoped = this.store.forOwner(account.id);
    if (scoped.devices().length >= account.device_limit) fail(409, '已达到此账号的电脑数量上限');
    const device = scoped.claim(hash, name, token);
    return device ? { ...device, ownerId: account.id } : null;
  }
  markDeleted(id, actor) {
    const account = this.get(id);
    if (!account || account.status === 'deleted') fail(404, '找不到账号');
    if (account.role === 'admin') fail(403, '不能删除管理员账号');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE accounts SET status='deleted',password_hash=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
      for (const table of ['sessions', 'pairings', 'threads', 'details', 'commands', 'device_meta', 'devices']) {
        this.db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(id);
      }
      this.audit(actor, id, 'account.delete'); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
