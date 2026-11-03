// ==UserScript==
// @name         OPA Optics
// @namespace    opa-optics
// @version      1.4.3
// @description  Grouped server list, team health checks, per-server access explanations, and per-user server access and enrolled clients, for Okta Privileged Access.
// @match        https://*.pam.okta.com/t/*
// @match        https://*.pam.oktapreview.com/t/*
// @homepageURL  https://github.com/JayToll/opa-optics
// @supportURL   https://github.com/JayToll/opa-optics/issues
// @updateURL    https://raw.githubusercontent.com/JayToll/opa-optics/main/opa-optics.user.js
// @downloadURL  https://raw.githubusercontent.com/JayToll/opa-optics/main/opa-optics.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * OPA Optics
 *
 * Unofficial: not made or supported by Okta.
 *
 * Three features for the Okta Privileged Access console:
 *   1. Home page (/t/{team}/home): a drawer listing servers grouped by project, server type, name prefix, label
 *      or (for admins) your access, with search. It opens automatically on the home page (switchable in the
 *      drawer) and can be reopened with the "Grouped servers" button. Clicking a server opens its Accounts page.
 *      For admins, a Health tab checks policies (inactive, matching no servers, nobody in their groups, servers no
 *      policy covers), server agents (not seen recently, behind the latest version) and admin roles, with CSV exports.
 *   2. Server pages (/t/{team}/servers/{id}/...): a panel showing which security policy rules cover the server,
 *      which of them grant you access, and why.
 *   3. User pages (/t/{team}/users/u/{user}): the servers that user can reach, split into standing access and access
 *      that needs an approved request, with the granting policy, rule and group, and a CSV export for access reviews.
 *      Also lists the devices (clients) the user has enrolled, flagging active clients on disabled or deleted users.
 *
 * Project page: https://github.com/JayToll/opa-optics
 *
 * How to run:
 *   - Install it in a userscript manager (Violentmonkey or Tampermonkey) so it runs automatically and updates itself, or
 *   - Use the bookmarklet from https://jaytoll.github.io/opa-optics/, or
 *   - Paste the whole file into the browser DevTools console on any /t/{team}/ page.
 *
 * Security and data handling:
 *   - Read-only. Makes GET requests to the same Okta Privileged Access host only.
 *   - Authenticates with the signed-in user's console session token, read from the cookie
 *     SFT_logged-in_store_{team} on every call. The token is never stored, logged or sent elsewhere.
 *   - Policy explanations need permission to read security policies (admin roles). Without it, the grouped list
 *     still works and the access features are hidden.
 *   - CSV exports contain usernames, server names and access details. Cells that start with =, +, - or @ are
 *     prefixed with an apostrophe so spreadsheet programs don't treat them as formulas.
 *   - Access results are reconstructed from policy data, not Okta's own evaluation. System labels are derived
 *     from server fields (system.os_type from os_type, system.hostname from hostname).
 *   - Saves the chosen grouping in this site's localStorage under "opa-optics.grouped".
 *   - Relies on an undocumented cookie name and console URL structure, which Okta may change without notice.
 */
(() => {
  // Only alert when run on the wrong site (a bookmarklet click). On console pages without a team in the path,
  // the page watcher waits quietly until one is opened.
  if (!/\.pam\.(okta|oktapreview)\.com$/.test(location.hostname)) {
    alert('OPA Optics: open your Okta Privileged Access console (https://{org}.pam.okta.com/t/{team}/...) and try again.');
    return;
  }
  if (window.opaOptics) { window.opaOptics.start(); return; }

  // ---------- Shared helpers ----------
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const team = () => decodeURIComponent((location.pathname.match(/^\/t\/([^\/]+)\//) || [])[1] || '');
  const base = () => `/v1/teams/${encodeURIComponent(team())}`;
  const onHome = () => /^\/t\/[^\/]+\/home\/?$/.test(location.pathname);
  const serverIdFromUrl = () => (location.pathname.match(new RegExp(`/servers/(${UUID})`)) || [])[1];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  function token() {
    const name = `SFT_logged-in_store_${team()}=`;
    const c = document.cookie.split('; ').find(c => c.startsWith(name));
    const m = c && decodeURIComponent(c.slice(name.length)).match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
    return m ? m[0] : null;
  }
  async function get(path) {
    const t = token();
    if (!t) throw new Error('No console session found for this team. Sign in again and reload.');
    const r = await fetch(new URL(path, location.origin), {credentials: 'omit', headers: {Accept: 'application/json', Authorization: `Bearer ${t}`}});
    if (r.status == 429) {
      const reset = Number(r.headers.get('X-RateLimit-Reset')) * 1000;
      await new Promise(res => setTimeout(res, Math.max(1000, reset - Date.now())));
      return get(path);
    }
    if (!r.ok) {
      const e = new Error(`${r.status} from ${path.replace(new RegExp(UUID, 'g'), '{id}').replace(/\?.*/, '')}`);
      e.status = r.status;
      throw e;
    }
    return {body: await r.json(), link: r.headers.get('Link')};
  }
  async function all(path) {
    let url = path, items = [];
    while (url) {
      const r = await get(url);
      items.push(...(r.body.list || []));
      const next = r.link && r.link.split(/,\s*/).map(l => l.match(/<(.*)>;\s*rel="(.*)"/)).find(m => m && m[2] == 'next');
      url = next ? next[1] : null;
    }
    return items;
  }

  // CSV download. Cells starting with =, +, - or @ get an apostrophe so spreadsheets don't run them as formulas.
  function downloadCsv(filename, header, rows) {
    const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const text = [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + text], {type: 'text/csv;charset=utf-8'}));
    const a = Object.assign(document.createElement('a'), {href: url, download: filename});
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- Team data, cached per team ----------
  let policyCache = null, serverCache = null;
  async function policyData() {
    if (policyCache && policyCache.team == team()) return policyCache;
    const b = base();
    const me = (await get(`${b}/current_user`)).body;
    let access = null;
    try {
      const [policies, rgs, myGroups] = await Promise.all([all(`${b}/security_policy`), all(`${b}/resource_groups`), all(`${b}/users/${encodeURIComponent(me.name)}/groups`)]);
      const projectToRg = {};
      for (const g of rgs) for (const p of await all(`${b}/resource_groups/${g.id}/projects`)) projectToRg[p.id] = g;
      access = {policies, projectToRg, myGroups};
    } catch (e) {
      if (e.status != 401 && e.status != 403) throw e; // no permission to read policies: access features are hidden
    }
    policyCache = {team: team(), me, access};
    return policyCache;
  }
  async function serverList() {
    if (serverCache && serverCache.team == team()) return serverCache.servers;
    const servers = (await all(`${base()}/servers?count=200`)).filter(s => !s.deleted_at || s.deleted_at.startsWith('0001'));
    serverCache = {team: team(), servers};
    return servers;
  }
  const clearCaches = () => { policyCache = null; serverCache = null; healthCache = null; };

  // ---------- Policy evaluation ----------
  const PRIVILEGE = {
    principal_account_rdp: 'RDP as your own account', principal_account_ssh: 'SSH as your own account',
    password_checkout_rdp: 'RDP with a checked-out password', password_checkout_ssh: 'SSH with a checked-out password',
    reveal_password: 'Reveal password', update_password: 'Update password', rotate_password: 'Rotate password'
  };
  const CONDITION = {access_request: 'Needs an approved access request', gateway: 'Connects through a gateway', mfa: 'Needs MFA'};

  // Returns one result per server-rule selector. status: grants_you | grants_others | no_match | other_rg | inactive | unknown
  function evaluateServer(server, access, groups = access.myGroups) {
    const rg = access.projectToRg[server.project_id];
    const stored = server.labels || {};
    const derived = {};
    if (server.os_type) derived['system.os_type'] = String(server.os_type).toLowerCase();
    if (server.hostname) derived['system.hostname'] = String(server.hostname).toLowerCase();
    const inMyGroups = g => groups.some(m => m.id == g.id || m.name == g.name);
    const results = [];
    for (const p of access.policies) {
      const rgOk = !p.resource_group || p.resource_group.id == rg?.id;
      const groups = p.principals?.user_groups || [];
      const mine = groups.filter(inMyGroups).map(g => g.name);
      for (const r of (p.rules || []).filter(r => r.resource_type == 'server_based_resource')) {
        for (const s of r.resource_selector?.selectors || []) {
          let match = false, how = '', derivedUsed = false, unknown = false;
          if (s.selector_type == 'server_label') {
            const parts = Object.entries(s.selector?.server_selector?.labels || {}).map(([k, v]) => {
              if (stored[k] === v) return {ok: true, text: `${k} = ${v}`};
              if (k in derived) return derived[k] == String(v).toLowerCase()
                ? (derivedUsed = true, {ok: true, text: `${k} = ${v} (from the server's details)`})
                : {ok: false, text: `${k} = ${v}`};
              if (k.startsWith('system.')) { unknown = true; return {ok: false, text: `${k} = ${v} (not checked)`}; }
              return {ok: false, text: `${k} = ${v}`};
            });
            match = parts.every(x => x.ok);
            how = parts.map(x => x.text).join(', ');
          } else if (['individual_server', 'individual_server_account'].includes(s.selector_type)) {
            match = s.selector?.server?.id == server.id;
            how = `Named server${s.selector?.username ? `, account ${s.selector.username}` : ''}`;
          } else { unknown = true; how = `Selector type ${s.selector_type} not checked`; }
          const status = !p.active ? 'inactive' : !rgOk ? 'other_rg' : unknown && !match ? 'unknown'
            : !match ? 'no_match' : mine.length ? 'grants_you' : 'grants_others';
          results.push({policyId: p.id, policy: p.name, rule: r.name, status, how, derivedUsed,
            needsRequest: (r.conditions || []).some(c => c.condition_type == 'access_request'),
            yourGroups: mine, allGroups: groups.map(g => g.name),
            privileges: (r.privileges || []).map(x => PRIVILEGE[x.privilege_type] || x.privilege_type),
            conditions: (r.conditions || []).map(c => CONDITION[c.condition_type] || c.condition_type)});
        }
      }
    }
    return {rg, results};
  }
  const accessSummary = (server, access) => {
    const yours = evaluateServer(server, access).results.filter(x => x.status == 'grants_you');
    return !yours.length ? 'none' : yours.some(x => !x.needsRequest) ? 'connect' : 'request';
  };

  // =====================================================================
  // Feature 1: access panel on server pages
  // =====================================================================
  const PANEL_CSS = `
    :host { all: initial; }
    .panel { position: fixed; top: 72px; right: 16px; width: 360px; max-height: calc(100vh - 96px); overflow: auto;
      font: 13px/1.45 ${FONT}; color: #1d2533; background: #fff; border: 1px solid #d5dbe4; border-radius: 6px;
      box-shadow: 0 6px 24px rgba(29,37,51,.14); z-index: 2147483000; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e6eaf0; position: sticky; top: 0; background: #fff; }
    header h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { font: inherit; color: #3a4558; background: none; border: 1px solid transparent; border-radius: 4px; padding: 2px 6px; cursor: pointer; }
    button:hover { background: #f1f4f8; } button:focus-visible { outline: 2px solid #2f6fd6; outline-offset: 1px; }
    .body { padding: 12px; } .collapsed .body, .collapsed footer { display: none; }
    .answer { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
    .answer.yes { color: #1f7a4d; } .answer.no { color: #8a3b12; }
    .context { color: #5b6576; margin: 0 0 12px; }
    .rule { border-left: 3px solid #c9d1dc; padding: 6px 0 6px 10px; margin: 0 0 10px; }
    .rule.grants_you { border-color: #1f7a4d; } .rule.grants_others { border-color: #6b85b8; } .rule.unknown { border-color: #b7791f; }
    .rule h3 { margin: 0; font-size: 13px; font-weight: 600; } .rule .r { font-weight: 400; color: #5b6576; }
    .rule p { margin: 2px 0 0; color: #3a4558; }
    .note { color: #8a5a00; }
    details { margin: 4px 0 10px; } summary { cursor: pointer; color: #3a4558; font-weight: 600; padding: 4px 0; }
    .muted { color: #5b6576; } .err { color: #8a3b12; }
    footer { padding: 8px 12px 12px; color: #5b6576; font-size: 12px; border-top: 1px solid #e6eaf0; }`;

  const panel = {host: null, root: null, lastServer: null, collapsed: false, dismissed: null, renderId: 0};

  function mountPanel() {
    if (panel.host && document.body.contains(panel.host)) return;
    panel.host = document.createElement('div');
    panel.host.id = 'opa-optics-panel';
    panel.root = panel.host.attachShadow({mode: 'open'});
    panel.root.innerHTML = `<style>${PANEL_CSS}</style><section class="panel${panel.collapsed ? ' collapsed' : ''}" role="complementary" aria-label="Access to this server">
      <header><h2>Access to this server</h2>
        <button data-act="refresh" title="Reload policies and groups">Refresh</button>
        <button data-act="collapse" aria-expanded="${!panel.collapsed}" title="Collapse">${panel.collapsed ? '+' : '–'}</button>
        <button data-act="close" title="Close">×</button></header>
      <div class="body"></div>
      <footer>Worked out from policy data, not Okta's own check.</footer></section>`;
    panel.root.addEventListener('click', e => {
      const btn = e.target.closest('button'), act = btn?.dataset.act;
      if (act == 'close') { panel.host.remove(); panel.lastServer = null; panel.dismissed = serverIdFromUrl(); }
      if (act == 'collapse') {
        panel.collapsed = !panel.collapsed;
        panel.root.querySelector('.panel').classList.toggle('collapsed', panel.collapsed);
        btn.textContent = panel.collapsed ? '+' : '–'; btn.setAttribute('aria-expanded', String(!panel.collapsed));
      }
      if (act == 'refresh') { clearCaches(); renderPanel(serverIdFromUrl(), true); }
    });
    document.body.appendChild(panel.host);
  }

  const ruleHtml = x => `<div class="rule ${x.status}">
      <h3>${esc(x.policy)} <span class="r">/ ${esc(x.rule)}</span></h3>
      <p>Matches on ${esc(x.how)}</p>
      ${x.status == 'grants_you' ? `<p>Through your group${x.yourGroups.length > 1 ? 's' : ''}: ${esc(x.yourGroups.join(', '))}</p>`
        : x.allGroups.length ? `<p>Groups: ${esc(x.allGroups.join(', '))}</p>` : ''}
      <p>${esc(x.privileges.join(', ') || 'No privileges listed')}</p>
      ${x.conditions.length ? `<p class="note">${esc(x.conditions.join('. '))}</p>` : ''}
      ${x.derivedUsed ? `<p class="muted">Matched using a system label derived from the server's details.</p>` : ''}</div>`;
  const REASON = {no_match: "Doesn't match this server", other_rg: 'Policy belongs to another resource group', inactive: 'Policy is inactive'};

  async function renderPanel(serverId, force) {
    if (!serverId || serverId === panel.dismissed) return;
    if (serverId === panel.lastServer && !force) return;
    panel.lastServer = serverId;
    mountPanel();
    const body = panel.root.querySelector('.body');
    const id = ++panel.renderId;
    body.innerHTML = `<p class="muted">Checking policies…</p>`;
    try {
      const d = await policyData();
      const server = (await get(`${base()}/servers/${serverId}`)).body;
      if (id !== panel.renderId) return; // moved to another server while loading
      panel.root.querySelector('h2').textContent = `Access to ${server.hostname}`;
      if (!d.access) {
        body.innerHTML = `<p class="muted">Your account can't read security policies, so access to this server can't be explained here.</p>`;
        return;
      }
      const {rg, results} = evaluateServer(server, d.access);
      const yours = results.filter(x => x.status == 'grants_you');
      const others = results.filter(x => x.status == 'grants_others');
      const unknown = results.filter(x => x.status == 'unknown');
      const out = results.filter(x => REASON[x.status]);
      const rules = n => `${n} ${n == 1 ? 'policy rule' : 'policy rules'}`;
      const answer = !yours.length ? `<p class="answer no">No policy gives you access to this server.</p>`
        : yours.some(x => !x.needsRequest) ? `<p class="answer yes">You can connect through ${rules(yours.length)}.</p>`
        : `<p class="answer yes">You can request access through ${rules(yours.length)}.</p>`;
      body.innerHTML = `${answer}
        <p class="context">Signed in as ${esc(d.me.name)}. ${esc(cap(server.os_type) || 'Unknown OS')} server in ${esc(rg?.name || 'an unknown resource group')}.</p>
        ${yours.map(ruleHtml).join('')}
        ${unknown.length ? `<details open><summary>Couldn't check (${unknown.length})</summary>${unknown.map(ruleHtml).join('')}</details>` : ''}
        ${others.length ? `<details><summary>Also covers this server, for other groups (${others.length})</summary>${others.map(ruleHtml).join('')}</details>` : ''}
        ${out.length ? `<details><summary>Ruled out (${out.length})</summary>${out.map(x =>
          `<div class="rule"><h3>${esc(x.policy)} <span class="r">/ ${esc(x.rule)}</span></h3><p>${REASON[x.status]}. ${esc(x.how)}</p></div>`).join('')}</details>` : ''}`;
    } catch (e) {
      if (id === panel.renderId) body.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }

  // =====================================================================
  // Feature 2: grouped server drawer on the home page
  // =====================================================================
  const STORE_KEY = 'opa-optics.grouped';
  const settings = Object.assign({by: 'project', segments: 2, label: '', mineOnly: false, autoOpen: true, staleDays: 7}, (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
  })());
  const saveSettings = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch {} };
  const ACCESS_GROUP = {connect: 'You can connect', request: 'You can request access', none: 'No policy access'};

  const DRAWER_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .launch { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; font: 600 13px/1 ${FONT};
      color: #fff; background: #1d2533; border: 0; border-radius: 20px; padding: 10px 16px; cursor: pointer; box-shadow: 0 4px 14px rgba(29,37,51,.25); }
    .launch:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid #2f6fd6; outline-offset: 2px; }
    .drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(520px, 100vw); z-index: 2147483001; display: flex; flex-direction: column;
      font: 13px/1.45 ${FONT}; color: #1d2533; background: #fff; border-left: 1px solid #d5dbe4; box-shadow: -8px 0 28px rgba(29,37,51,.16); }
    header { padding: 14px 16px 10px; border-bottom: 1px solid #e6eaf0; }
    .top { display: flex; align-items: center; gap: 8px; }
    h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
    .count { color: #5b6576; font-weight: 400; }
    button.x { font: inherit; color: #3a4558; background: none; border: 0; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
    button.x.close { font-size: 18px; line-height: 1; }
    button.x:hover { background: #f1f4f8; }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
    input[type=search] { flex: 1 1 100%; font: inherit; padding: 7px 10px; border: 1px solid #cfd6e0; border-radius: 4px; }
    label { color: #3a4558; display: flex; align-items: center; gap: 6px; }
    select { font: inherit; padding: 4px 6px; border: 1px solid #cfd6e0; border-radius: 4px; background: #fff; }
    .list { flex: 1; overflow: auto; padding: 4px 0 16px; }
    details { border-bottom: 1px solid #eef1f5; }
    summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 8px; padding: 10px 16px; font-weight: 600; position: sticky; top: 0; background: #fff; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: '▸'; color: #8792a3; width: 10px; } details[open] > summary::before { content: '▾'; }
    summary .n { color: #5b6576; font-weight: 400; }
    a.srv { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 7px 16px 7px 34px; color: inherit; text-decoration: none; }
    a.srv:hover { background: #f5f7fa; }
    .host { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { grid-column: 1; color: #5b6576; font-size: 12px; }
    .badge { grid-row: 1 / span 2; grid-column: 2; align-self: center; font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
    .badge.connect { color: #1f7a4d; background: #e7f4ec; } .badge.request { color: #8a5a00; background: #fbf1dc; } .badge.none { color: #5b6576; background: #eef1f5; }
    .empty, .msg { padding: 24px 16px; color: #5b6576; } .err { color: #8a3b12; }
    footer { padding: 8px 16px 12px; color: #5b6576; font-size: 12px; border-top: 1px solid #e6eaf0; }
    .tabs { display: flex; gap: 4px; margin-top: 10px; border-bottom: 1px solid #e6eaf0; }
    .tab { font: inherit; font-weight: 600; color: #5b6576; background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px; cursor: pointer; }
    .tab[aria-selected=true] { color: #1d2533; border-bottom-color: #1d2533; }
    .hhead { display: flex; align-items: center; gap: 8px; padding: 16px 16px 4px; }
    .hhead h3 { flex: 1; margin: 0; font-size: 14px; }
    .hhead .n { color: #5b6576; font-weight: 400; }
    button.mini { font: inherit; font-size: 12px; font-weight: 600; color: #3a4558; background: #fff; border: 1px solid #cfd6e0; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
    .item { display: block; padding: 4px 16px 4px 34px; color: inherit; text-decoration: none; }
    a.item:hover { background: #f5f7fa; }
    .item .sub { display: block; color: #5b6576; font-size: 12px; }
    .item.flag { box-shadow: inset 3px 0 0 #b7791f; }
    .fine { padding: 4px 16px 4px 34px; color: #1f7a4d; }
    .hnote { padding: 2px 16px 0; color: #5b6576; font-size: 12px; }
    @media (prefers-reduced-motion: no-preference) { .drawer { animation: in .16s ease-out; } @keyframes in { from { transform: translateX(16px); opacity: 0; } } }`;

  const drawer = {host: null, root: null, open: false, query: '', data: null, wasHome: false, tab: 'servers'};

  function mountDrawer() {
    if (drawer.host && document.body.contains(drawer.host)) return;
    drawer.host = document.createElement('div');
    drawer.host.id = 'opa-optics-grouped';
    drawer.root = drawer.host.attachShadow({mode: 'open'});
    drawer.root.innerHTML = `<style>${DRAWER_CSS}</style><button class="launch" aria-haspopup="dialog" aria-expanded="false">Grouped servers</button><div class="slot"></div>`;
    drawer.root.querySelector('.launch').addEventListener('click', () => { drawer.open = !drawer.open; drawDrawer(); });
    drawer.root.addEventListener('keydown', e => {
      if (e.key == 'Escape' && drawer.open) { drawer.open = false; drawDrawer(); drawer.root.querySelector('.launch').focus(); }
    });
    document.body.appendChild(drawer.host);
  }

  async function loadDrawerData() {
    const [servers, d] = await Promise.all([serverList(), policyData()]);
    if (d.access) servers.forEach(s => s._access = accessSummary(s, d.access));
    drawer.data = {team: team(), servers, hasAccess: !!d.access};
  }

  const groupKey = s => {
    switch (settings.by) {
      case 'os': return cap(s.os_type) || 'Unknown type';
      case 'prefix': {
        const parts = String(s.hostname || '').toLowerCase().split(/[-_.]/);
        return parts.length > settings.segments ? parts.slice(0, settings.segments).join('-') : 'Other names';
      }
      case 'label': return (s.labels || {})[settings.label] ?? `No ${settings.label} label`;
      case 'access': return ACCESS_GROUP[s._access] || 'Unknown';
      default: return s.project_name || 'No project';
    }
  };

  function serverRow(s) {
    const badge = s._access ? `<span class="badge ${s._access}">${{connect: 'Connect', request: 'Request', none: 'No access'}[s._access]}</span>` : '';
    const seen = s.last_seen && !s.last_seen.startsWith('0001') ? `seen ${new Date(s.last_seen).toLocaleDateString()}` : '';
    const meta = [s.os || cap(s.os_type), settings.by != 'project' ? s.project_name : '', s.state ? String(s.state).toLowerCase() : '', seen].filter(Boolean).join(', ');
    return `<a class="srv" href="/t/${encodeURIComponent(drawer.data.team)}/servers/${encodeURIComponent(s.id)}/accounts">
      <span class="host">${esc(s.hostname)}</span>${badge}<span class="meta">${esc(meta)}</span></a>`;
  }

  function listHtml() {
    const {servers: allServers, hasAccess} = drawer.data;
    const q = drawer.query.trim().toLowerCase();
    let servers = allServers.filter(s => !q || [s.hostname, s.project_name, s.os, s.os_type, ...Object.values(s.labels || {})]
      .some(v => String(v || '').toLowerCase().includes(q)));
    if (settings.mineOnly && hasAccess) servers = servers.filter(s => s._access != 'none');
    if (!servers.length) return `<p class="empty">No servers match. Clear the search${settings.mineOnly ? ' or the access filter' : ''} to see all ${allServers.length}.</p>`;
    const groups = {};
    for (const s of servers) (groups[groupKey(s)] ||= []).push(s);
    const order = settings.by == 'access' ? Object.values(ACCESS_GROUP) : null;
    const names = Object.keys(groups).sort((a, b) => order ? order.indexOf(a) - order.indexOf(b) : a.localeCompare(b, undefined, {numeric: true}));
    const openAll = names.length <= 6 || !!q;
    return names.map(n => `<details ${openAll ? 'open' : ''}><summary>${esc(n)} <span class="n">${groups[n].length}</span></summary>
      ${groups[n].sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, {numeric: true})).map(serverRow).join('')}</details>`).join('');
  }

  function drawDrawer() {
    const slot = drawer.root.querySelector('.slot');
    drawer.root.querySelector('.launch').setAttribute('aria-expanded', String(drawer.open));
    if (!drawer.open) { slot.innerHTML = ''; return; }
    const shell = inner => `<section class="drawer" role="region" aria-label="Grouped servers">${inner}</section>`;
    if (!drawer.data || drawer.data.team != team()) {
      slot.innerHTML = shell(`<p class="msg">Loading servers…</p>`);
      loadDrawerData().then(drawDrawer).catch(e => { slot.innerHTML = shell(`<p class="msg err">${esc(e.message)}</p>`); });
      return;
    }
    const {servers, hasAccess} = drawer.data;
    const tabs = hasAccess ? `<div class="tabs" role="tablist">
        <button class="tab" role="tab" data-tab="servers" aria-selected="${drawer.tab != 'health'}">Servers</button>
        <button class="tab" role="tab" data-tab="health" aria-selected="${drawer.tab == 'health'}">Health</button></div>` : '';
    const wireCommon = () => {
      slot.querySelector('[data-act=close]').addEventListener('click', () => { drawer.open = false; drawDrawer(); });
      slot.querySelector('[data-act=refresh]').addEventListener('click', () => { clearCaches(); drawer.data = null; drawDrawer(); });
      slot.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => { drawer.tab = t.dataset.tab; drawDrawer(); }));
      slot.querySelectorAll('[data-set]').forEach(el => el.addEventListener('change', () => {
        const k = el.dataset.set;
        settings[k] = el.type == 'checkbox' ? el.checked : ['segments', 'staleDays'].includes(k) ? Number(el.value) : el.value;
        saveSettings(); drawDrawer();
      }));
    };
    if (drawer.tab == 'health' && hasAccess) {
      const ready = healthCache && healthCache.team == team();
      slot.innerHTML = shell(`
        <header><div class="top"><h2>Team health</h2>
          <button class="x" data-act="refresh" title="Reload servers, policies and roles">Refresh</button>
          <button class="x close" data-act="close" aria-label="Close">×</button></div>${tabs}</header>
        <div class="list">${ready ? healthHtml(healthCache) : '<p class="msg">Checking policies, servers and roles…</p>'}</div>
        <footer>Server rules only. Coverage ignores who is in each policy's groups. Worked out from policy data, not Okta's own check.</footer>`);
      wireCommon();
      slot.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => exportHealth(b.dataset.export)));
      if (!ready) loadHealth().then(() => { if (drawer.open && drawer.tab == 'health') drawDrawer(); })
        .catch(e => { const l = slot.querySelector('.list'); if (l) l.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; });
      return;
    }
    const keys = [...new Set(servers.flatMap(s => Object.keys(s.labels || {})))].sort();
    if (settings.by == 'label' && !keys.includes(settings.label)) settings.label = keys[0] || '';
    if ((settings.by == 'label' && !keys.length) || (settings.by == 'access' && !hasAccess)) settings.by = 'project';
    slot.innerHTML = shell(`
      <header><div class="top"><h2>Servers <span class="count">${servers.length}</span></h2>
        <button class="x" data-act="refresh" title="Reload servers and policies">Refresh</button>
        <button class="x close" data-act="close" aria-label="Close">×</button></div>${tabs}
        <div class="controls">
          <input type="search" placeholder="Search by name, project, OS or label" value="${esc(drawer.query)}" aria-label="Search servers">
          <label>Group by <select data-set="by">
            <option value="project">Project</option><option value="os">Server type</option><option value="prefix">Name prefix</option>
            ${keys.length ? '<option value="label">Label</option>' : ''}${hasAccess ? '<option value="access">Your access</option>' : ''}</select></label>
          ${settings.by == 'prefix' ? `<label>Segments <select data-set="segments">${[1, 2, 3].map(n => `<option ${n == settings.segments ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
          ${settings.by == 'label' ? `<label>Label <select data-set="label">${keys.map(k => `<option ${k == settings.label ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>` : ''}
          ${hasAccess ? `<label><input type="checkbox" data-set="mineOnly" ${settings.mineOnly ? 'checked' : ''}> Only servers I can reach</label>` : ''}
          <label><input type="checkbox" data-set="autoOpen" ${settings.autoOpen ? 'checked' : ''}> Open automatically</label>
        </div></header>
      <div class="list">${listHtml()}</div>
      <footer>${hasAccess ? "Access badges are worked out from policy data, not Okta's own check." : 'Showing the servers your account can list.'}</footer>`);
    slot.querySelector('select[data-set=by]').value = settings.by;
    wireCommon();
    const search = slot.querySelector('input[type=search]');
    search.addEventListener('input', () => { drawer.query = search.value; slot.querySelector('.list').innerHTML = listHtml(); });
  }



  // =====================================================================
  // Feature 4: team health (policies, server agents, admin roles), shown in the drawer's Health tab
  // =====================================================================
  let healthCache = null;
  const parseVer = v => String(v || '').split(/[.\-+]/).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
  const cmpVer = (a, b) => { const x = parseVer(a), y = parseVer(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  const daysSince = t => !t || String(t).startsWith('0001') ? null : Math.floor((Date.now() - new Date(t)) / 864e5);
  const isActiveStatus = st => String(st || '').toUpperCase() == 'ACTIVE';
  // role_grants shape is not documented; show whatever it holds as readable text.
  const grantText = g => Array.isArray(g) ? g.map(x => typeof x == 'string' ? x : (x?.role || x?.name || x?.role_name || JSON.stringify(x))).join(', ')
    : g && typeof g == 'object' ? Object.keys(g).filter(k => g[k]).join(', ') : String(g ?? '');

  async function loadHealth() {
    if (healthCache && healthCache.team == team()) return healthCache;
    const d = await policyData();
    const b = base();
    const [servers, groups, serviceUsers] = await Promise.all([serverList(), all(`${b}/groups`),
      all(`${b}/service_users`).catch(e => (e.status == 401 || e.status == 403) ? null : Promise.reject(e))]);
    const activePolicies = d.access.policies.filter(p => p.active);

    // Members of the groups that matter: groups used by active policies, and groups holding admin roles.
    const needed = new Set();
    for (const p of activePolicies) for (const g of p.principals?.user_groups || []) needed.add(g.name);
    for (const g of groups) if ((g.roles || []).length) needed.add(g.name);
    const members = {};
    for (const name of needed) members[name] = await all(`${b}/groups/${encodeURIComponent(name)}/users`);

    // Which servers each active server rule matches, ignoring group membership.
    const key = (pid, rule) => `${pid}::${rule}`;
    const rules = new Map();
    for (const p of activePolicies) for (const r of (p.rules || []).filter(r => r.resource_type == 'server_based_resource'))
      rules.set(key(p.id, r.name), {policy: p.name, rule: r.name, matched: 0, unknown: 0});
    const uncovered = [];
    for (const s of servers) {
      let covered = false;
      for (const x of evaluateServer(s, d.access, []).results) {
        const k = rules.get(key(x.policyId, x.rule));
        if (!k) continue;
        if (x.status == 'grants_others') { k.matched++; covered = true; } else if (x.status == 'unknown') k.unknown++;
      }
      if (!covered) uncovered.push(s);
    }
    healthCache = {team: team(), servers, groups, serviceUsers, members, policies: d.access.policies, activePolicies,
      rules: [...rules.values()], uncovered, at: new Date()};
    return healthCache;
  }

  function healthFindings(h) {
    const inactive = h.policies.filter(p => !p.active);
    const noMatch = h.rules.filter(r => !r.matched && !r.unknown);
    const unchecked = h.rules.filter(r => !r.matched && r.unknown);
    const emptyGroups = new Map();
    const nobody = [];
    for (const p of h.activePolicies) {
      const gs = p.principals?.user_groups || [];
      let people = 0;
      for (const g of gs) {
        const n = (h.members[g.name] || []).filter(u => isActiveStatus(u.status)).length;
        people += n;
        if (!n) (emptyGroups.get(g.name) || emptyGroups.set(g.name, []).get(g.name)).push(p.name);
      }
      if (!people && !(p.principals?.workload_roles || []).length) nobody.push(p);
    }
    const stale = h.servers.map(s => ({s, days: daysSince(s.last_seen)}))
      .filter(x => x.days === null || x.days >= settings.staleDays).sort((a, b) => (b.days ?? 1e9) - (a.days ?? 1e9));
    const versions = {};
    for (const s of h.servers) (versions[s.sftd_version || 'Unknown'] ||= []).push(s);
    const latest = Object.keys(versions).filter(v => v != 'Unknown').sort(cmpVer).pop();
    const behind = latest ? h.servers.filter(s => s.sftd_version && cmpVer(s.sftd_version, latest) < 0) : [];
    const states = {};
    for (const s of h.servers) states[String(s.state || 'unknown').toLowerCase()] = (states[String(s.state || 'unknown').toLowerCase()] || 0) + 1;
    const adminGroups = h.groups.filter(g => (g.roles || []).length).map(g => ({g, people: h.members[g.name] || []}));
    const serviceAdmins = (h.serviceUsers || []).filter(u => grantText(u.role_grants));
    return {inactive, noMatch, unchecked, emptyGroups, nobody, stale, versions, latest, behind, states, adminGroups, serviceAdmins};
  }

  function healthHtml(h) {
    const f = healthFindings(h);
    const t = encodeURIComponent(team());
    const srvLink = (s, sub) => `<a class="item" href="/t/${t}/servers/${encodeURIComponent(s.id)}/accounts">${esc(s.hostname)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</a>`;
    const fine = text => `<p class="fine">${esc(text)}</p>`;
    const sec = (title, count, body, open) => `<details ${open ? 'open' : ''}><summary>${esc(title)} <span class="n">${count}</span></summary>${body}</details>`;
    const policyIssues = f.inactive.length + f.noMatch.length + f.nobody.length + f.emptyGroups.size + h.uncovered.length;

    const policySection = `
      <div class="hhead"><h3>Policies <span class="n">${policyIssues ? `${policyIssues} to review` : 'no issues found'}</span></h3><button class="mini" data-export="policies">Export CSV</button></div>
      ${sec('Inactive policies', f.inactive.length, f.inactive.length ? f.inactive.map(p => `<span class="item">${esc(p.name)}</span>`).join('') : fine('None.'), false)}
      ${sec('Server rules that match no servers', f.noMatch.length, f.noMatch.length
        ? f.noMatch.map(r => `<span class="item flag">${esc(r.policy)} / ${esc(r.rule)}<span class="sub">Check the rule's labels or named servers, and the policy's resource group.</span></span>`).join('')
        : fine('Every active server rule matches at least one server.'), f.noMatch.length > 0)}
      ${f.unchecked.length ? sec("Server rules that couldn't be checked", f.unchecked.length,
        f.unchecked.map(r => `<span class="item">${esc(r.policy)} / ${esc(r.rule)}<span class="sub">Uses a label or selector this tool doesn't evaluate.</span></span>`).join(''), false) : ''}
      ${sec('Active policies nobody can use', f.nobody.length, f.nobody.length
        ? f.nobody.map(p => `<span class="item flag">${esc(p.name)}<span class="sub">None of its groups has an active member. Check the groups are assigned to the Okta Privileged Access app in Okta.</span></span>`).join('')
        : fine('Every active policy has at least one active member.'), f.nobody.length > 0)}
      ${sec('Groups in active policies with no active members', f.emptyGroups.size, f.emptyGroups.size
        ? [...f.emptyGroups].map(([g, ps]) => `<span class="item">${esc(g)}<span class="sub">Used by ${esc(ps.join(', '))}</span></span>`).join('')
        : fine('None.'), false)}
      ${sec('Servers no active policy covers', h.uncovered.length, h.uncovered.length
        ? h.uncovered.map(s => srvLink(s, [s.project_name, cap(s.os_type)].filter(Boolean).join(', '))).join('')
        : fine('Every server is covered by at least one active server rule.'), false)}`;

    const verRows = Object.entries(f.versions).sort((a, b) => cmpVer(b[0], a[0]))
      .map(([v, list]) => `<span class="item">${esc(v)}${v == f.latest ? ' (latest in use)' : ''}<span class="sub">${list.length} server${list.length == 1 ? '' : 's'}</span></span>`).join('');
    const serverSection = `
      <div class="hhead"><h3>Server agents <span class="n">${h.servers.length} servers</span></h3><button class="mini" data-export="servers">Export CSV</button></div>
      <p class="hnote"><label>Flag servers not seen for <select data-set="staleDays">${[1, 7, 14, 30, 90].map(n => `<option value="${n}" ${n == settings.staleDays ? 'selected' : ''}>${n} day${n == 1 ? '' : 's'}</option>`).join('')}</select></label></p>
      ${sec(`Not seen for ${settings.staleDays}+ days`, f.stale.length, f.stale.length
        ? f.stale.map(x => srvLink(x.s, x.days === null ? 'Never seen' : `Last seen ${x.days} day${x.days == 1 ? '' : 's'} ago`)).join('')
        : fine('All servers checked in recently.'), f.stale.length > 0 && f.stale.length <= 20)}
      ${sec('Behind the latest agent version in use', f.behind.length, f.behind.length
        ? f.behind.map(s => srvLink(s, `Agent ${s.sftd_version}, latest in use is ${f.latest}`)).join('')
        : fine(f.latest ? `All servers run ${f.latest}.` : 'No agent versions reported.'), false)}
      ${sec('Agent versions', Object.keys(f.versions).length, verRows, false)}
      ${sec('Server states', Object.keys(f.states).length, Object.entries(f.states).map(([st, n]) => `<span class="item">${esc(cap(st))}<span class="sub">${n} server${n == 1 ? '' : 's'}</span></span>`).join(''), false)}`;

    const adminSection = `
      <div class="hhead"><h3>Admin roles <span class="n">${f.adminGroups.length} group${f.adminGroups.length == 1 ? '' : 's'}${h.serviceUsers ? `, ${f.serviceAdmins.length} service user${f.serviceAdmins.length == 1 ? '' : 's'}` : ''}</span></h3><button class="mini" data-export="admins">Export CSV</button></div>
      ${f.adminGroups.map(({g, people}) => {
        const inactive = people.filter(u => !isActiveStatus(u.status));
        return sec(`${g.name}: ${(g.roles || []).join(', ')}`, people.length,
          (g.federated_from_team ? `<p class="hnote">Federated from team ${esc(g.federated_from_team)}.</p>` : '') +
          (people.length ? people.map(u => `<span class="item${isActiveStatus(u.status) ? '' : ' flag'}">${esc(u.name)}<span class="sub">${esc(cap(String(u.status || '').toLowerCase()))}${u.user_type && u.user_type != 'human' ? `, ${esc(u.user_type)}` : ''}${isActiveStatus(u.status) ? '' : '. Still in an admin group.'}</span></span>`).join('') : fine('No members.')),
          inactive.length > 0);
      }).join('')}
      ${h.serviceUsers === null ? '<p class="hnote">Your account can\'t list service users.</p>'
        : sec('Service users with role grants', f.serviceAdmins.length, f.serviceAdmins.length
          ? f.serviceAdmins.map(u => `<span class="item">${esc(u.name)}<span class="sub">${esc(grantText(u.role_grants))}. ${esc(cap(String(u.status || '').toLowerCase()))}</span></span>`).join('')
          : fine('None.'), false)}`;

    return `<p class="hnote">Checked ${esc(h.at.toLocaleString())}.</p>${policySection}${serverSection}${adminSection}`;
  }

  function exportHealth(kind) {
    const h = healthCache;
    if (!h) return;
    const f = healthFindings(h), at = h.at.toISOString(), day = at.slice(0, 10);
    if (kind == 'policies') {
      const rows = [
        ...f.inactive.map(p => ['inactive_policy', p.name, '', '']),
        ...f.noMatch.map(r => ['rule_matches_no_servers', r.policy, r.rule, '']),
        ...f.unchecked.map(r => ['rule_not_checked', r.policy, r.rule, 'uses a label or selector not evaluated']),
        ...f.nobody.map(p => ['policy_no_active_members', p.name, '', '']),
        ...[...f.emptyGroups].map(([g, ps]) => ['group_no_active_members', ps.join('; '), '', g]),
        ...h.uncovered.map(s => ['server_not_covered', '', '', s.hostname])
      ].map(r => [...r, at]);
      downloadCsv(`OPA policy health - ${team()} - ${day}.csv`, ['finding', 'policy', 'rule', 'subject', 'checked_at'], rows);
    }
    if (kind == 'servers') {
      const uncovered = new Set(h.uncovered.map(s => s.id));
      downloadCsv(`OPA server health - ${team()} - ${day}.csv`,
        ['server', 'server_id', 'project', 'os', 'state', 'last_seen', 'days_since_seen', 'agent_version', 'behind_latest', 'covered_by_active_policy', 'checked_at'],
        h.servers.map(s => { const d = daysSince(s.last_seen); return [s.hostname, s.id, s.project_name, s.os || s.os_type, s.state,
          d === null ? '' : s.last_seen, d === null ? 'never' : d, s.sftd_version, f.latest && s.sftd_version && cmpVer(s.sftd_version, f.latest) < 0 ? 'yes' : 'no',
          uncovered.has(s.id) ? 'no' : 'yes', at]; }));
    }
    if (kind == 'admins') {
      const rows = [];
      for (const {g, people} of f.adminGroups) {
        if (!people.length) rows.push(['group', g.name, (g.roles || []).join('; '), '', '', '', g.federated_from_team || '', at]);
        for (const u of people) rows.push(['group_member', g.name, (g.roles || []).join('; '), u.name, u.status, u.user_type, g.federated_from_team || '', at]);
      }
      for (const u of f.serviceAdmins) rows.push(['service_user', '', grantText(u.role_grants), u.name, u.status, u.user_type, '', at]);
      downloadCsv(`OPA admin roles - ${team()} - ${day}.csv`, ['type', 'group', 'roles', 'name', 'status', 'user_type', 'federated_from_team', 'checked_at'], rows);
    }
  }

  // =====================================================================
  // Feature 3: a user's server access on user pages
  // =====================================================================
  const userKeyFromUrl = () => { const m = location.pathname.match(/^\/t\/[^\/]+\/users\/u\/([^\/?#]+)/); return m ? decodeURIComponent(m[1]) : null; };
  const USER_CSS = PANEL_CSS + `
    .panel { width: 400px; }
    .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 12px; }
    select { font: inherit; padding: 3px 6px; border: 1px solid #cfd6e0; border-radius: 4px; background: #fff; color: #1d2533; }
    button.export { font-weight: 600; border: 1px solid #cfd6e0; padding: 4px 10px; }
    .grp { margin: 10px 0 2px; font-weight: 600; color: #3a4558; }
    a.srv { display: block; color: inherit; text-decoration: none; padding: 5px 0 5px 10px; border-left: 3px solid #c9d1dc; margin: 4px 0; }
    a.srv.standing { border-color: #1f7a4d; } a.srv.request { border-color: #b7791f; }
    a.srv:hover { background: #f5f7fa; } a.srv:focus-visible { outline: 2px solid #2f6fd6; outline-offset: 1px; }
    .host { font-weight: 500; } .via { color: #5b6576; font-size: 12px; display: block; }
    .warn { background: #fbf1dc; color: #6b4500; padding: 8px 10px; border-radius: 4px; margin: 0 0 12px; }
    details > summary { font-size: 13px; }
    .client { padding: 5px 0 5px 10px; border-left: 3px solid #c9d1dc; margin: 4px 0; }
    .client.ACTIVE { border-color: #1f7a4d; } .client.PENDING { border-color: #b7791f; }`;

  const userView = {host: null, root: null, lastUser: null, dismissed: null, renderId: 0, collapsed: false, by: 'project', result: null};

  async function userAccess(userKey) {
    const d = await policyData();
    if (!d.access) return {noPolicyAccess: true};
    const byId = new RegExp(`^${UUID}$`).test(userKey);
    const user = (await get(byId ? `${base()}/users_by_id/${encodeURIComponent(userKey)}` : `${base()}/users/${encodeURIComponent(userKey)}`)).body;
    const [groups, servers, clientsResult] = await Promise.all([
      all(`${base()}/users/${encodeURIComponent(user.name)}/groups`), serverList(),
      // all=true lets admins list another user's clients; filter on user_name as well in case the API ignores username
      all(`${base()}/clients?all=true&username=${encodeURIComponent(user.name)}&count=200`)
        .then(list => ({list: list.filter(c => c.user_name == user.name)}))
        .catch(e => ({error: e.status == 403 || e.status == 401 ? "Your account can't list this user's clients." : e.message}))
    ]);
    const rows = [];
    for (const s of servers) {
      const grants = evaluateServer(s, d.access, groups).results.filter(x => x.status == 'grants_you');
      if (grants.length) rows.push({server: s, kind: grants.some(g => !g.needsRequest) ? 'standing' : 'request', grants});
    }
    rows.sort((a, b) => a.server.hostname.localeCompare(b.server.hostname, undefined, {numeric: true}));
    return {user, groups, rows, total: servers.length, clients: clientsResult, evaluatedAt: new Date()};
  }

  const userGroupKey = s => userView.by == 'os' ? (cap(s.os_type) || 'Unknown type')
    : userView.by == 'prefix' ? (() => { const p = String(s.hostname || '').toLowerCase().split(/[-_.]/); return p.length > 2 ? p.slice(0, 2).join('-') : 'Other names'; })()
    : (s.project_name || 'No project');

  function userRowHtml(r) {
    const via = r.grants.map(g => `${g.policy} / ${g.rule}, via ${g.yourGroups.join(', ')}${g.conditions.length ? `. ${g.conditions.join('. ')}` : ''}`);
    return `<a class="srv ${r.kind}" href="/t/${encodeURIComponent(team())}/servers/${encodeURIComponent(r.server.id)}/accounts">
      <span class="host">${esc(r.server.hostname)}</span>${via.map(v => `<span class="via">${esc(v)}</span>`).join('')}</a>`;
  }
  function userSectionHtml(title, rows, open) {
    if (!rows.length) return '';
    const groups = {};
    for (const r of rows) (groups[userGroupKey(r.server)] ||= []).push(r);
    const names = Object.keys(groups).sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    return `<details ${open ? 'open' : ''}><summary>${esc(title)} (${rows.length})</summary>
      ${names.map(n => `<p class="grp">${esc(n)} <span class="muted">${groups[n].length}</span></p>${groups[n].map(userRowHtml).join('')}`).join('')}</details>`;
  }

  function clientsHtml(r) {
    const c = r.clients;
    if (c.error) return `<details><summary>Enrolled clients</summary><p class="muted">${esc(c.error)}</p></details>`;
    const live = c.list.filter(x => x.state != 'DELETED'), removed = c.list.length - live.length;
    const order = {ACTIVE: 0, PENDING: 1};
    live.sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2) || String(a.hostname).localeCompare(String(b.hostname)));
    const status = String(r.user.status || '').toUpperCase();
    const activeCount = live.filter(x => x.state == 'ACTIVE').length;
    const warn = status && status != 'ACTIVE' && activeCount
      ? `<p class="warn">${activeCount} client${activeCount == 1 ? ' is' : 's are'} still active for this ${esc(status.toLowerCase())} user. Consider revoking ${activeCount == 1 ? 'it' : 'them'} in the console.</p>` : '';
    const label = {ACTIVE: 'Active', PENDING: 'Waiting for approval'};
    return `<details ${live.length && live.length <= 10 ? 'open' : ''}><summary>Enrolled clients (${live.length})</summary>${warn}
      ${live.length ? live.map(x => `<div class="client ${esc(x.state)}"><span class="host">${esc(x.hostname || 'Unnamed device')}</span>
        <span class="via">${esc([x.os, label[x.state] || cap(String(x.state || 'unknown state').toLowerCase()), x.encrypted ? 'encrypted' : 'not encrypted', x.description].filter(Boolean).join(', '))}</span></div>`).join('')
        : `<p class="muted">No enrolled clients.</p>`}
      ${removed ? `<p class="muted">${removed} removed client${removed == 1 ? '' : 's'} not shown.</p>` : ''}</details>`;
  }

  function exportUserCsv(r) {
    const at = r.evaluatedAt.toISOString();
    const rows = [];
    for (const row of r.rows) for (const g of row.grants)
      rows.push([r.user.name, r.user.status, row.server.hostname, row.server.id, row.server.project_name, row.server.os_type,
        g.needsRequest ? 'on request' : 'standing', g.policy, g.rule, g.yourGroups.join('; '), g.privileges.join('; '), g.conditions.join('; '), at]);
    downloadCsv(`OPA access - ${r.user.name} - ${at.slice(0, 10)}.csv`,
      ['user', 'user_status', 'server', 'server_id', 'project', 'os_type', 'access', 'policy', 'rule', 'via_groups', 'privileges', 'conditions', 'evaluated_at'], rows);
  }

  function mountUserPanel() {
    if (userView.host && document.body.contains(userView.host)) return;
    userView.host = document.createElement('div');
    userView.host.id = 'opa-optics-user';
    userView.root = userView.host.attachShadow({mode: 'open'});
    userView.root.innerHTML = `<style>${USER_CSS}</style><section class="panel${userView.collapsed ? ' collapsed' : ''}" role="complementary" aria-label="Server access for this user">
      <header><h2>Server access</h2>
        <button data-act="refresh" title="Reload policies, groups and servers">Refresh</button>
        <button data-act="collapse" aria-expanded="${!userView.collapsed}" title="Collapse">${userView.collapsed ? '+' : '–'}</button>
        <button data-act="close" title="Close">×</button></header>
      <div class="body"></div>
      <footer>Server access is worked out from policy data, not Okta's own check. Server rules only; secret folders and directory accounts aren't included.</footer></section>`;
    userView.root.addEventListener('click', e => {
      const btn = e.target.closest('button'), act = btn?.dataset.act;
      if (act == 'close') { userView.host.remove(); userView.lastUser = null; userView.dismissed = userKeyFromUrl(); }
      if (act == 'collapse') {
        userView.collapsed = !userView.collapsed;
        userView.root.querySelector('.panel').classList.toggle('collapsed', userView.collapsed);
        btn.textContent = userView.collapsed ? '+' : '–'; btn.setAttribute('aria-expanded', String(!userView.collapsed));
      }
      if (act == 'refresh') { clearCaches(); renderUser(userKeyFromUrl(), true); }
      if (act == 'export' && userView.result) exportUserCsv(userView.result);
    });
    userView.root.addEventListener('change', e => {
      if (e.target.dataset.set == 'by') { userView.by = e.target.value; drawUser(); }
    });
    document.body.appendChild(userView.host);
  }

  function drawUser() {
    const r = userView.result, body = userView.root.querySelector('.body');
    const standing = r.rows.filter(x => x.kind == 'standing'), request = r.rows.filter(x => x.kind == 'request');
    const status = String(r.user.status || '').toUpperCase();
    userView.root.querySelector('h2').textContent = `Server access for ${r.user.name}`;
    const summary = !r.rows.length ? `<p class="answer no">No policy gives ${esc(r.user.name)} access to any of the ${r.total} servers.</p>`
      : !standing.length ? `<p class="answer yes">Can request access to ${request.length} of ${r.total} servers, with no standing access.</p>`
      : `<p class="answer yes">Can connect to ${standing.length} of ${r.total} servers${request.length ? `, and can request access to ${request.length} more` : ''}.</p>`;
    body.innerHTML = `${summary}
      <p class="context">In ${r.groups.length} group${r.groups.length == 1 ? '' : 's'}: ${esc(r.groups.map(g => g.name).join(', ') || 'none')}.</p>
      ${status && status != 'ACTIVE' ? `<p class="warn">This user is ${esc(status.toLowerCase())}. Okta blocks their sign-in, so this access can't be used, but their groups still grant it on paper.</p>` : ''}
      ${r.rows.length ? `<div class="controls"><label class="muted">Group by <select data-set="by">
          <option value="project">Project</option><option value="os">Server type</option><option value="prefix">Name prefix</option></select></label>
        <button class="export" data-act="export" title="Download every grant as a CSV file">Export CSV</button></div>` : ''}
      ${userSectionHtml('Standing access', standing, true)}
      ${userSectionHtml('Needs an approved request', request, standing.length < 15)}
      ${clientsHtml(r)}`;
    const sel = body.querySelector('select[data-set=by]');
    if (sel) sel.value = userView.by;
  }

  async function renderUser(userKey, force) {
    if (!userKey || userKey === userView.dismissed) return;
    if (userKey === userView.lastUser && !force) return;
    userView.lastUser = userKey;
    mountUserPanel();
    const body = userView.root.querySelector('.body');
    const id = ++userView.renderId;
    body.innerHTML = `<p class="muted">Checking this user's access…</p>`;
    try {
      const r = await userAccess(userKey);
      if (id !== userView.renderId) return;
      if (r.noPolicyAccess) {
        userView.result = null;
        body.innerHTML = `<p class="muted">Your account can't read security policies, so this user's access can't be listed here.</p>`;
        return;
      }
      userView.result = r;
      drawUser();
    } catch (e) {
      if (id === userView.renderId) body.innerHTML = `<p class="err">${esc(e.status == 404 ? 'User not found. The page may use an identifier this tool does not recognise.' : e.message)}</p>`;
    }
  }

  // =====================================================================
  // Page watcher: the console changes pages without reloading
  // =====================================================================
  let timer = null;
  function tick() {
    if (!team()) return;
    const id = serverIdFromUrl();
    if (panel.dismissed && id !== panel.dismissed) panel.dismissed = null; // closing hides the panel until you move to another server
    if (id) renderPanel(id);
    else if (panel.host) { panel.host.remove(); panel.lastServer = null; }
    if (onHome()) {
      const arriving = !drawer.wasHome || !drawer.host || !document.body.contains(drawer.host);
      mountDrawer();
      drawer.wasHome = true;
      if (arriving && settings.autoOpen && !drawer.open) { drawer.open = true; drawDrawer(); }
    } else {
      drawer.wasHome = false;
      if (drawer.host) { drawer.host.remove(); drawer.open = false; }
    }
    const userKey = userKeyFromUrl();
    if (userView.dismissed && userKey !== userView.dismissed) userView.dismissed = null;
    if (userKey) renderUser(userKey);
    else if (userView.host) { userView.host.remove(); userView.lastUser = null; }
  }
  window.opaOptics = {
    start() { if (!timer) timer = setInterval(tick, 1000); tick(); },
    stop() { clearInterval(timer); timer = null; panel.host?.remove(); drawer.host?.remove(); userView.host?.remove(); panel.lastServer = null; userView.lastUser = null; drawer.open = false; },
    refresh() { clearCaches(); drawer.data = null; panel.lastServer = null; userView.lastUser = null; tick(); }
  };
  window.opaOptics.start();
})();
