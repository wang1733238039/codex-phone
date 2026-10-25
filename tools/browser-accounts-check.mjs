import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/config.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'phone-browser-accounts-')), artifacts = resolve('artifacts/accounts');
mkdirSync(artifacts, { recursive: true });
const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-admin-password'), agentToken: 'test-agent', controlsEnabled: true });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const adminContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const memberContext = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
const admin = await adminContext.newPage(), member = await memberContext.newPage(), errors = [];
for (const page of [admin, member]) page.on('pageerror', e => errors.push(e.message));
let agent;
const wait = async fn => { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Browser setup timed out'); };
try {
  await admin.goto(origin); await admin.locator('#password').fill('test-admin-password'); await admin.locator('#login-button').click();
  await admin.locator('#account-banner').click(); await admin.locator('#open-admin').click();
  await admin.locator('#admin-create-submit').click();
  await admin.locator('#admin-invite-result').waitFor({ state: 'visible' });
  const inviteLink = await admin.locator('#admin-invite-link').inputValue();
  assert.match(inviteLink, /#invite=/);
  await admin.screenshot({ path: join(artifacts, 'phone-admin-invite.png') });
  await member.goto(inviteLink); await member.locator('#registration-form').waitFor({ state: 'visible' });
  assert.equal(new URL(member.url()).hash, '', 'invitation is removed from browser URL');
  await member.locator('#register-username').fill('phone-member');
  await member.locator('#register-password').fill('member-test-password'); await member.locator('#register-confirm').fill('member-test-password');
  await member.locator('#register-submit').click(); await member.locator('#app-view').waitFor({ state: 'visible' });
  await member.locator('#account-banner').click();
  assert.equal(await member.locator('#open-admin').isVisible(), false);
  await member.screenshot({ path: join(artifacts, 'phone-member-account.png') });
  await member.keyboard.press('Escape'); await member.locator('#device-button').click(); await member.locator('#pair-button').click();
  await member.waitForFunction(() => document.getElementById('pair-code').textContent.length > 0);
  const code = await member.locator('#pair-code').textContent();
  const response = await fetch(origin + '/api/device-pairings/claim', { method: 'POST', body: JSON.stringify({ code, name: '我的笔记本' }) });
  assert.equal(response.status, 201); const device = await response.json(), threadId = randomUUID();
  agent = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${device.agentToken}` } });
  await once(agent, 'open');
  agent.on('message', raw => { const msg = JSON.parse(raw); if (msg.type !== 'request') return;
    agent.send(JSON.stringify({ type: 'response', id: msg.id, data: msg.action === 'detail'
      ? { id: threadId, transcriptVersion: TRANSCRIPT_VERSION, running: false, messages: [{ role: 'user', text: '帮我检查产品开通流程。' },
        { role: 'assistant', phase: 'final_answer', text: '你的独立账号已开通，电脑绑定成功。可以继续发送消息。' }] }
      : msg.action === 'models' ? { models: [] } : { delivery: 'started' } }));
  });
  agent.send(JSON.stringify({ type: 'snapshot', threads: [{ id: threadId, title: '新用户的第一段会话', archived: false, local: true }],
    info: { computer: '我的笔记本', controls: true, capabilities: { createThread: true } }, sidebar: { projects: [] } }));
  await member.locator(`[data-device-id="${device.deviceId}"]`).click();
  await member.locator('.thread-row').click(); await member.getByText('你的独立账号已开通，电脑绑定成功。可以继续发送消息。', { exact: true }).waitFor();
  assert.equal((await member.evaluate(async () => (await fetch('/api/admin/accounts')).status)), 403);
  await member.locator('#message').fill('这条新消息可以发送');
  assert.equal(await member.locator('#send-button').isDisabled(), false);
  await admin.locator('#admin-refresh').click();
  await admin.getByRole('button', { name: '管理账号 phone-member' }).click();
  const accountId = app.store.db.prepare("SELECT id FROM accounts WHERE username='phone-member'").get().id;
  const oldExpiry = app.accounts.get(accountId).expires_at;
  await admin.locator('#admin-renew-form button').click();
  await wait(() => app.accounts.get(accountId).expires_at === oldExpiry + 30 * 86400000);
  await admin.waitForFunction(() => !document.querySelector('#admin-renew-form button').disabled);
  await admin.screenshot({ path: join(artifacts, 'phone-admin-renew.png') });
  const past = new Date(Date.now() - 86400000);
  const local = new Date(past.getTime() - past.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await admin.locator('#admin-edit-expiry').fill(local);
  await admin.locator('#admin-limits-form button').click();
  await member.waitForFunction(() => document.getElementById('account-banner-label').textContent.includes('已到期'));
  assert.equal(await member.locator('#send-button').isDisabled(), true);
  assert.equal(await member.locator('#message').isDisabled(), false);
  assert.match(await member.locator('#messages').innerText(), /电脑绑定成功/);
  await member.getByRole('button', { name: '账户与套餐', exact: true }).first().click();
  await member.screenshot({ path: join(artifacts, 'phone-expired-account.png') });
  for (const [width, height] of [[375, 812], [390, 844], [1440, 1000]]) {
    await admin.setViewportSize({ width, height }); await member.setViewportSize({ width, height });
    for (const page of [admin, member]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await admin.locator('#admin-renew-form button').click();
  await member.waitForFunction(() => !document.getElementById('account-banner-label').textContent.includes('已到期'));
  await admin.keyboard.press('Escape');
  await admin.locator('#admin-create-mode').selectOption('account'); await admin.locator('#admin-username').fill('direct-user');
  await admin.locator('#admin-password').fill('direct-user-password'); await admin.locator('#admin-create-submit').click();
  await admin.getByRole('button', { name: '管理账号 direct-user' }).waitFor();
  await admin.getByRole('button', { name: '管理账号 phone-member' }).click();
  admin.once('dialog', dialog => dialog.accept()); await admin.locator('#admin-toggle-user').click();
  await member.locator('#login-view').waitFor({ state: 'visible' });
  assert.equal(await member.locator('#messages').textContent(), '');
  await admin.locator('#admin-toggle-user').click();
  await member.locator('#username').fill('phone-member'); await member.locator('#password').fill('member-test-password'); await member.locator('#login-button').click();
  await member.locator('#app-view').waitFor({ state: 'visible' });
  await member.reload(); await member.locator('#app-view').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  const report = { passed: true, verifiedAt: new Date().toISOString(), pageErrors: errors,
    checked: ['admin-invitation', 'invite-registration', 'hash-removed', 'private-empty-account', 'member-no-admin-access',
      'own-device-pairing', 'conversation-history', 'renewal-from-existing-expiry', 'expiry-cached-read', 'expiry-draft-allowed',
      'expiry-send-disabled', 'direct-account-create', 'suspension-logout-clears-history', 'restore-login', 'reload-session',
      '375-390-1440-no-overflow'] };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report));
} catch (e) {
  await admin.screenshot({ path: join(artifacts, 'admin-failure.png') }); await member.screenshot({ path: join(artifacts, 'member-failure.png') });
  console.error(JSON.stringify({ pageErrors: errors, adminError: await admin.locator('#admin-error').textContent(), registerError: await member.locator('#register-error').textContent() }));
  throw e;
} finally { await browser.close(); agent?.terminate(); await app.close(); rmSync(dir, { force: true, recursive: true }); }
