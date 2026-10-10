// Stronguard background service worker (Chrome/Edge) / event page (Firefox).

import { LEVELS, featuresFor, levelInfo } from '../core/levels.js';
import { api, getSettings, updateSettings, addStats, getStats, resetStats, isAllowlisted } from './settings.js';
import { applyAll, allowOnce, getBuildInfo } from './engine.js';
import { handleHello, handleTokens, injectSelector, invalidateCosmetics, frameHostname } from './cosmetics.js';
import { initPopups, blockedInfo } from './popups.js';
import { compileUserFilters, refreshExtraLists, extraListStatus } from './userfilters.js';

const LIST_ALARM = 'stronguard-extra-lists';

// ---------------------------------------------------------------------------
// Lifecycle

api.runtime.onInstalled.addListener(async (details) => {
  await setupMenus();
  if (details.reason === 'install' || details.reason === 'update') {
    const settings = await getSettings();
    await compileUserFilters(settings).catch(() => {});
  }
  await applyAll();
  api.alarms.create(LIST_ALARM, { periodInMinutes: 24 * 60 });
});

api.runtime.onStartup.addListener(() => applyAll());

api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== LIST_ALARM) return;
  const settings = await getSettings();
  if (settings.extraLists.length) {
    await refreshExtraLists(settings);
    invalidateCosmetics();
    await applyAll();
  }
});

initPopups();

// Count blocked requests where the browser exposes matches (unpacked installs).
if (api.declarativeNetRequest.onRuleMatchedDebug) {
  let pending = 0;
  let timer = 0;
  api.declarativeNetRequest.onRuleMatchedDebug.addListener(() => {
    pending++;
    if (!timer) {
      timer = setTimeout(() => {
        addStats({ requests: pending });
        pending = 0;
        timer = 0;
      }, 2000);
    }
  });
}

// ---------------------------------------------------------------------------
// Element picker: toolbar popup, context menu and keyboard shortcut

async function setupMenus() {
  if (!api.contextMenus) return;
  await api.contextMenus.removeAll();
  api.contextMenus.create({ id: 'sg-pick', title: 'Block an element…', contexts: ['all'] });
  api.contextMenus.create({ id: 'sg-allow', title: 'Disable Stronguard on this site', contexts: ['all'] });
}

async function startPicker(tabId) {
  await api.scripting.executeScript({ target: { tabId }, files: ['content/picker.js'] });
}

if (api.contextMenus) {
  api.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab) return;
    if (info.menuItemId === 'sg-pick') await startPicker(tab.id).catch(() => {});
    if (info.menuItemId === 'sg-allow') {
      const host = frameHostname({ url: tab.url }, {});
      if (!host) return;
      const s = await getSettings();
      await updateSettings({ allowlist: [...s.allowlist, host] });
      invalidateCosmetics();
      await applyAll();
      await api.tabs.reload(tab.id);
    }
  });
}

if (api.commands) {
  api.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'pick-element') return;
    const t = tab || (await api.tabs.query({ active: true, currentWindow: true }))[0];
    if (t) await startPicker(t.id).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Network shield (local DNS/proxy service) integration

async function shieldStatus(settings) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${settings.shieldUrl.replace(/\/$/, '')}/api/status`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return { online: false };
    return { online: true, ...(await res.json()) };
  } catch {
    return { online: false };
  }
}

async function shieldSetLevel(settings) {
  if (!settings.shieldSync) return;
  try {
    await fetch(`${settings.shieldUrl.replace(/\/$/, '')}/api/level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: settings.level }),
    });
  } catch {
    /* service not running */
  }
}

// ---------------------------------------------------------------------------
// Messages

const handlers = {
  async hello(msg, sender) {
    return handleHello(msg, sender, await getSettings());
  },

  async tokens(msg, sender) {
    await handleTokens(msg, sender, await getSettings());
  },

  async stats(msg, sender) {
    const clean = {};
    for (const [k, v] of Object.entries(msg.stats || {})) if (/^[a-z]+$/i.test(k) && Number.isFinite(v)) clean[k] = v;
    await addStats(clean, sender.tab ? sender.tab.id : undefined);
  },

  async 'picker:save'(msg, sender) {
    const host = String(msg.hostname || '').toLowerCase();
    const selector = String(msg.selector || '').trim();
    if (!host || !selector || /[\r\n]/.test(selector)) return { ok: false };
    const s = await getSettings();
    const line = `${host}##${selector}`;
    const customFilters = s.customFilters.includes(line) ? s.customFilters : `${s.customFilters.replace(/\s*$/, '')}\n${line}\n`.replace(/^\n/, '');
    const next = await updateSettings({ customFilters });
    await compileUserFilters(next);
    invalidateCosmetics();
    await injectSelector(sender, selector);
    await addStats({ picked: 1 }, sender.tab ? sender.tab.id : undefined);
    return { ok: true };
  },

  async 'ui:state'(msg) {
    const settings = await getSettings();
    const hostname = frameHostname({ url: msg.url || '' }, {});
    const stats = await getStats(msg.tabId);
    let matched = null;
    try {
      const r = await api.declarativeNetRequest.getMatchedRules({ tabId: msg.tabId });
      matched = r.rulesMatchedInfo.length;
    } catch {
      matched = null;
    }
    const { warnings = {} } = await api.storage.local.get('warnings');
    return {
      enabled: settings.enabled,
      level: settings.level,
      levels: LEVELS,
      info: levelInfo(settings.level),
      features: featuresFor(settings.level),
      hostname,
      siteAllowed: hostname ? isAllowlisted(hostname, settings.allowlist) : false,
      stats,
      matched,
      warnings,
    };
  },

  async 'ui:setLevel'(msg) {
    const s = await updateSettings({ level: msg.level });
    invalidateCosmetics();
    await applyAll();
    shieldSetLevel(s);
    return { level: s.level };
  },

  async 'ui:setEnabled'(msg) {
    const s = await updateSettings({ enabled: !!msg.enabled });
    invalidateCosmetics();
    await applyAll();
    return { enabled: s.enabled };
  },

  async 'ui:toggleSite'(msg) {
    const host = String(msg.hostname || '').toLowerCase();
    if (!host) return {};
    const s = await getSettings();
    const allowlist = msg.allowed ? [...s.allowlist, host] : s.allowlist.filter((d) => d !== host && !host.endsWith(`.${d}`));
    await updateSettings({ allowlist });
    invalidateCosmetics();
    await applyAll();
    return { ok: true };
  },

  async 'ui:pick'(msg) {
    await startPicker(msg.tabId);
    return { ok: true };
  },

  async 'shield:status'() {
    return shieldStatus(await getSettings());
  },

  async 'opt:get'() {
    const settings = await getSettings();
    const info = await getBuildInfo();
    const { warnings = {}, userFilterStats = null } = await api.storage.local.get(['warnings', 'userFilterStats']);
    return { settings, levels: LEVELS, build: info, warnings, userFilterStats, extraLists: await extraListStatus(), stats: await getStats() };
  },

  async 'opt:save'(msg) {
    const prev = await getSettings();
    const patch = msg.patch || {};
    const next = await updateSettings(patch);
    const listsChanged = JSON.stringify(prev.extraLists) !== JSON.stringify(next.extraLists);
    if (listsChanged) await refreshExtraLists(next);
    else if (prev.customFilters !== next.customFilters) await compileUserFilters(next);
    invalidateCosmetics();
    await applyAll();
    if (prev.level !== next.level) shieldSetLevel(next);
    const { userFilterStats = null } = await api.storage.local.get('userFilterStats');
    return { settings: next, userFilterStats };
  },

  async 'opt:updateLists'() {
    const s = await getSettings();
    const r = await refreshExtraLists(s);
    invalidateCosmetics();
    await applyAll();
    return { userFilterStats: r, extraLists: await extraListStatus() };
  },

  async 'opt:resetStats'() {
    await resetStats();
    return { ok: true };
  },

  async 'blocked:info'(msg, sender) {
    return blockedInfo(sender.tab ? sender.tab.id : -1);
  },

  async 'blocked:proceed'(msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    let url;
    try {
      url = new URL(msg.url);
    } catch {
      return { ok: false };
    }
    if (!/^https?:$/.test(url.protocol) || tabId === undefined) return { ok: false };
    if (msg.mode === 'always') {
      const s = await getSettings();
      await updateSettings({ allowlist: [...s.allowlist, url.hostname] });
      invalidateCosmetics();
      await applyAll();
    } else {
      await allowOnce(tabId, url.href);
    }
    await api.tabs.update(tabId, { url: url.href });
    return { ok: true };
  },
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.t];
  if (!handler) return false;
  // Only our own extension pages may call ui/opt/blocked handlers.
  const internal = sender.url && sender.url.startsWith(api.runtime.getURL(''));
  if (/^(ui|opt|blocked|shield):/.test(msg.t) && !internal) return false;
  Promise.resolve(handler(msg, sender)).then(
    (r) => sendResponse(r === undefined ? null : r),
    (err) => sendResponse({ error: String((err && err.message) || err) }),
  );
  return true;
});
