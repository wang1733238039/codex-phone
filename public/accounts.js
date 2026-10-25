/* Account pages share the existing origin and HttpOnly session; no bearer credentials are persisted. */
const PhoneAccounts = (() => {
  const $ = id => document.getElementById(id);
  const labels = { active: '使用中', expired: '已到期', disabled: '已停用', deleted: '已删除' };
  let ctx, account = null, generation = 0, adminSequence = 0, selected = null, nextOffset = null, invitation = '';
  const datetime = value => value == null ? '长期有效' : new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const inputTime = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  function error(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
  function node(tag, cls, text) { return ctx.el(tag, cls, text); }
  function update(value) {
    if (!value || !ctx.getState().csrf) return;
    account = value;
    const near = value.expiresAt && value.expiresAt - Date.now() <= 3 * 86400000;
    $('account-banner-label').textContent = `${value.username} · ${value.accessState === 'expired' ? '套餐已到期，联系管理员续期' : value.role === 'admin' ? '管理账户与用户' : near ? `即将到期 ${datetime(value.expiresAt)}` : `有效至 ${datetime(value.expiresAt)}`}`;
    $('account-banner').classList.toggle('expired', value.accessState !== 'active');
    $('open-admin').hidden = value.role !== 'admin'; $('account-delete-section').hidden = value.role === 'admin';
    const rows = [['账号', value.username], ['状态', value.role === 'admin' ? '管理员' : labels[value.accessState]], ['到期时间', datetime(value.expiresAt)], ['已绑定电脑', `${value.deviceCount} / ${value.deviceLimit}`]];
    $('account-summary').replaceChildren(...rows.map(([label, text]) => { const row = node('div', 'status-item'); row.append(node('span', '', label), node('span', '', text)); return row; }));
    $('account-service-note').textContent = value.role === 'admin' ? '在管理页创建用户或生成邀请。现有电脑与会话保留。' :
      value.accessState === 'expired' ? '套餐已到期。仍可查看自己的缓存、解绑电脑和管理账号；续期后恢复电脑接入与发送。请联系为你开通账号的管理员。' :
      '续费请联系为你开通账号的管理员。托管服务不包含模型费用，使用时电脑需保持开机联网。';
    ctx.updateComposer();
  }
  async function refresh() {
    const seq = generation, data = await ctx.api('/api/account');
    if (seq === generation) update(data.account);
  }
  function clear() {
    generation++; account = null; selected = null;
    for (const id of ['account-dialog', 'admin-dialog', 'admin-edit-dialog']) $(id).close();
    for (const id of ['account-password-form', 'account-delete-form', 'admin-create-form', 'admin-reset-password-form', 'admin-delete-form']) $(id).reset();
    $('admin-users').replaceChildren(); $('admin-invitations').replaceChildren(); $('account-summary').replaceChildren();
    $('admin-invite-link').value = ''; $('admin-invite-result').hidden = true;
    $('register-password').value = ''; $('register-confirm').value = '';
    mode();
  }
  function prepareInvite() {
    const match = location.hash.match(/^#invite=([A-Za-z0-9_-]{43})$/);
    if (match) { invitation = match[1]; history.replaceState(null, '', location.pathname + location.search); }
    $('registration-form').hidden = !invitation; $('login-form').hidden = Boolean(invitation);
    return Boolean(invitation);
  }
  function show() {
    $('status-dialog').close(); $('account-dialog').showModal();
    refresh().catch(e => ctx.notice(e.message));
  }
  async function loadAdmin(append = false) {
    const seq = generation, request = ++adminSequence;
    error('admin-error', '');
    if (!append) $('admin-users').replaceChildren(...Array.from({ length: 2 }, () => node('div', 'skeleton')));
    try {
      const data = await ctx.api(`/api/admin/accounts?q=${encodeURIComponent($('admin-search').value)}&offset=${append ? nextOffset || 0 : 0}`);
      if (seq !== generation || request !== adminSequence || account?.role !== 'admin') return;
      if (!append) $('admin-users').replaceChildren();
      for (const user of data.accounts) {
        const row = node('article', 'admin-account-row'), copy = node('div', 'admin-account-copy');
        row.dataset.accountId = user.id;
        const title = node('strong', '', user.username), badge = node('span', `account-state ${user.accessState}`, user.role === 'admin' ? '管理员' : labels[user.accessState]);
        const detail = node('p', '', `到期：${datetime(user.expiresAt)} · 电脑 ${user.deviceCount}/${user.deviceLimit}`);
        copy.append(title, badge, detail); row.append(copy);
        if (user.role !== 'admin') { const button = node('button', 'secondary', '管理'); button.type = 'button'; button.setAttribute('aria-label', `管理账号 ${user.username}`); button.onclick = () => edit(user); row.append(button); }
        $('admin-users').append(row);
      }
      if (!data.accounts.length && !append) $('admin-users').append(node('p', 'account-note', '没有匹配账号。可在上方生成邀请，开通第一位用户。'));
      nextOffset = data.nextOffset; $('admin-load-more').hidden = nextOffset === null;
      const invites = await ctx.api('/api/admin/invitations');
      if (seq !== generation || request !== adminSequence || account?.role !== 'admin') return;
      $('admin-invitations').replaceChildren();
      for (const item of invites.invitations) {
        const row = node('div', 'admin-account-row'), copy = node('div', 'admin-account-copy');
        const expired = item.expiresAt <= Date.now();
        copy.append(node('strong', '', `${item.serviceDays} 天 · ${item.deviceLimit} 台电脑`),
          node('p', '', `${item.claimedAt ? '已兑换' : item.revokedAt ? '已撤销' : expired ? '已过期' : '待兑换'} · 邀请截止 ${datetime(item.expiresAt)}`));
        row.append(copy);
        if (!item.claimedAt && !item.revokedAt && !expired) {
          const button = node('button', 'secondary', '撤销'); button.type = 'button';
          button.onclick = () => busy(button, 'admin-error', async () => { await ctx.api(`/api/admin/invitations/${item.id}/revoke`, {}); await loadAdmin(); ctx.notice('邀请已撤销'); });
          row.append(button);
        }
        $('admin-invitations').append(row);
      }
      if (!invites.invitations.length) $('admin-invitations').append(node('p', 'account-note', '还没有邀请记录。生成后只向指定用户提供链接。'));
    } catch (e) { if (seq === generation && request === adminSequence) { error('admin-error', e.message); if (!append) $('admin-users').replaceChildren(); } }
  }
  function edit(user) {
    selected = user; error('admin-edit-error', '');
    $('admin-edit-title').textContent = user.username;
    $('admin-edit-summary').textContent = `${labels[user.accessState]} · ${user.deviceCount} 台电脑 · 到期 ${datetime(user.expiresAt)}`;
    $('admin-edit-expiry').value = inputTime(user.expiresAt); $('admin-edit-limit').value = user.deviceLimit;
    $('admin-toggle-user').textContent = user.status === 'disabled' ? '恢复账号' : '停用账号';
    $('admin-renew-days').value = '30'; $('admin-reset-password').value = ''; $('admin-delete-name').value = '';
    if (!$('admin-edit-dialog').open) $('admin-edit-dialog').showModal();
  }
  async function change(data) {
    const id = selected.id, result = await ctx.api(`/api/admin/accounts/${id}`, data);
    if (selected?.id === id && $('admin-edit-dialog').open) edit(result.account);
    await loadAdmin(); ctx.notice('账号设置已更新');
  }
  async function busy(button, id, action) {
    const seq = generation; button.disabled = true; error(id, '');
    try { await action(); }
    catch (e) { if (seq === generation) error(id, e.message); }
    finally { button.disabled = false; }
  }
  function form(id, errorId, action) {
    $(id).addEventListener('submit', event => { event.preventDefault(); void busy(event.submitter || $(id).querySelector('[type=submit]'), errorId, action); });
  }
  function mode() {
    const direct = $('admin-create-mode').value === 'account';
    $('admin-credentials').hidden = !direct;
    $('admin-username').required = direct; $('admin-password').required = direct;
    $('admin-invite-validity-label').hidden = direct; $('admin-invite-validity').required = !direct;
    $('admin-create-submit').textContent = direct ? '创建独立账号' : '生成一次性邀请';
  }
  function mount(context) {
    ctx = context;
    $('admin-edit-dialog').addEventListener('close', () => { selected = null; });
    $('register-back').onclick = () => { invitation = ''; prepareInvite(); };
    form('registration-form', 'register-error', async () => {
      if ($('register-password').value !== $('register-confirm').value) throw new Error('两次输入的密码不一致');
      const session = await ctx.api('/api/register', { code: invitation, username: $('register-username').value, password: $('register-password').value });
      invitation = ''; prepareInvite(); $('register-password').value = ''; $('register-confirm').value = '';
      await ctx.enterApp(session); ctx.notice('账号已开通，点击“选择电脑”添加你的第一台电脑');
    });
    $('open-admin').onclick = () => { $('account-dialog').close(); $('admin-dialog').showModal(); void loadAdmin(); };
    $('admin-create-mode').onchange = mode;
    $('admin-refresh').onclick = () => loadAdmin();
    $('admin-load-more').onclick = () => loadAdmin(true);
    form('admin-search-form', 'admin-error', () => loadAdmin());
    form('admin-create-form', 'admin-error', async () => {
      const seq = generation;
      const direct = $('admin-create-mode').value === 'account';
      const data = { serviceDays: Number($('admin-service-days').value), deviceLimit: Number($('admin-device-limit').value) };
      if (direct) Object.assign(data, { username: $('admin-username').value, password: $('admin-password').value });
      else data.validityDays = Number($('admin-invite-validity').value);
      const result = await ctx.api(direct ? '/api/admin/accounts' : '/api/admin/invitations', data);
      if (seq !== generation) return;
      $('admin-password').value = '';
      if (!direct) {
        const url = new URL('/', location.origin); url.hash = `invite=${result.code}`;
        $('admin-invite-link').value = url.href; $('admin-invite-result').hidden = false;
      } else ctx.notice(`账号 ${result.account.username} 已开通`);
      await loadAdmin();
    });
    $('admin-copy-invite').onclick = async () => { try { await navigator.clipboard.writeText($('admin-invite-link').value); ctx.notice('邀请链接已复制'); } catch { $('admin-invite-link').focus(); $('admin-invite-link').select(); ctx.notice('请长按复制邀请链接'); } };
    form('admin-renew-form', 'admin-edit-error', () => change({ extendDays: Number($('admin-renew-days').value) }));
    form('admin-limits-form', 'admin-edit-error', () => change({ expiresAt: new Date($('admin-edit-expiry').value).getTime(), deviceLimit: Number($('admin-edit-limit').value) }));
    $('admin-toggle-user').onclick = () => busy($('admin-toggle-user'), 'admin-edit-error', async () => {
      if (selected.status !== 'disabled' && !confirm(`停用 ${selected.username}？这会断开网页登录和电脑连接。`)) return;
      await change({ status: selected.status === 'disabled' ? 'active' : 'disabled' });
    });
    form('admin-reset-password-form', 'admin-edit-error', async () => {
      await ctx.api(`/api/admin/accounts/${selected.id}/password`, { password: $('admin-reset-password').value });
      $('admin-reset-password').value = ''; ctx.notice('密码已重置，用户需要重新登录');
    });
    form('admin-delete-form', 'admin-edit-error', async () => {
      if ($('admin-delete-name').value !== selected.username) throw new Error('请输入要删除的完整账号');
      if (!confirm(`永久删除 ${selected.username} 及其云端数据？此操作无法撤销。`)) return;
      await ctx.api(`/api/admin/accounts/${selected.id}/delete`, { confirmUsername: $('admin-delete-name').value });
      $('admin-edit-dialog').close(); selected = null; await loadAdmin(); ctx.notice('账号与云端数据已删除');
    });
    form('account-password-form', 'account-password-error', async () => {
      await ctx.api('/api/account/password', { currentPassword: $('account-current-password').value, newPassword: $('account-new-password').value });
      ctx.showLogin(); ctx.notice('密码已修改，请重新登录');
    });
    form('account-delete-form', 'account-delete-error', async () => {
      if (!confirm('永久删除你的账号与云端数据？此操作无法撤销。')) return;
      await ctx.api('/api/account/delete', { confirmUsername: $('account-delete-name').value, password: $('account-delete-password').value });
      ctx.showLogin(); ctx.notice('账号与云端数据已删除');
    });
    mode();
  }
  return { mount, update, refresh, clear, prepareInvite, show, active: () => !account || account.accessState === 'active' };
})();
