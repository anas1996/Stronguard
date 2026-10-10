// Applies the current settings to the browser: static rulesets for the level,
// dynamic rules (allowlist, custom filters, extra lists), content-script
// registrations, toolbar icon and badge.

import { api, getSettings } from './settings.js';

export const PRIORITY_ALLOWLIST = 2000;
export const PRIORITY_PROCEED = 3000;

let buildInfo = null;
let scriptletIndex = null;

export async function getBuildInfo() {
  if (!buildInfo) {
    const res = await fetch(api.runtime.getURL('data/build-info.json'));
    buildInfo = await res.json();
  }
  return buildInfo;
}

async function getScriptletIndex() {
  if (!scriptletIndex) {
    const res = await fetch(api.runtime.getURL('data/scriptlets.json'));
    scriptletIndex = await res.json();
  }
  return scriptletIndex;
}

async function setWarning(key, message) {
  const { warnings = {} } = await api.storage.local.get('warnings');
  if (message) warnings[key] = message;
  else delete warnings[key];
  await api.storage.local.set({ warnings });
}

// ---------------------------------------------------------------------------
// Static rulesets

async function applyRulesets(settings, info) {
  const dnr = api.declarativeNetRequest;
  const wanted = settings.enabled
    ? Object.entries(info.rulesets).filter(([, r]) => r.level <= settings.level).map(([id]) => id)
    : [];
  const current = await dnr.getEnabledRulesets();
  const disable = current.filter((id) => !wanted.includes(id));
  let enable = wanted.filter((id) => !current.includes(id));
  if (disable.length) await dnr.updateEnabledRulesets({ disableRulesetIds: disable });
  try {
    if (enable.length) await dnr.updateEnabledRulesets({ enableRulesetIds: enable });
    await setWarning('rulesets', null);
  } catch (err) {
    // Over the shared static-rule budget: enable level by level until it fails.
    const skipped = [];
    enable.sort((a, b) => info.rulesets[a].level - info.rulesets[b].level);
    for (const id of enable) {
      try {
        await dnr.updateEnabledRulesets({ enableRulesetIds: [id] });
      } catch {
        skipped.push(id);
      }
    }
    await setWarning('rulesets', skipped.length ? `Browser rule limit reached; not enabled: ${skipped.join(', ')}` : null);
  }
}

// ---------------------------------------------------------------------------
// Dynamic rules: allowlist + compiled user filters / extra lists

async function applyDynamicRules(settings) {
  const dnr = api.declarativeNetRequest;
  const rules = [];
  let id = 1;
  if (settings.allowlist.length) {
    rules.push({
      id: id++,
      priority: PRIORITY_ALLOWLIST,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: settings.allowlist, resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }
  if (settings.enabled) {
    const { userRules = [] } = await api.storage.local.get('userRules');
    for (const r of userRules) rules.push({ ...r, id: id++ });
  }
  const existing = await dnr.getDynamicRules();
  try {
    await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
    await setWarning('dynamic', null);
  } catch (err) {
    // Keep at least the allowlist working.
    await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules.slice(0, settings.allowlist.length ? 1 : 0) });
    await setWarning('dynamic', `Custom rules rejected by the browser: ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Content scripts

const hostPatterns = (hosts) => hosts.map((h) => `*://*.${h}/*`);

async function register(scripts) {
  try {
    await api.scripting.registerContentScripts(scripts);
  } catch (err) {
    // Older browsers lack matchOriginAsFallback; retry without it.
    if (!/matchOriginAsFallback|match_origin_as_fallback|Unexpected property/i.test(String(err && err.message))) throw err;
    await api.scripting.registerContentScripts(scripts.map(({ matchOriginAsFallback, ...rest }) => rest));
  }
}

async function applyRegistrations(settings, info) {
  const existing = await api.scripting.getRegisteredContentScripts();
  if (existing.length) await api.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!settings.enabled) return;
  const L = settings.level;
  const common = { allFrames: true, runAt: 'document_start', persistAcrossSessions: true, matchOriginAsFallback: true };
  if (settings.allowlist.length) common.excludeMatches = hostPatterns(settings.allowlist);
  const scripts = [
    { id: 'sg-isolated', js: [`content/isolated.L${L}.js`], matches: ['<all_urls>'], world: 'ISOLATED', ...common },
    { id: 'sg-guard', js: [`content/guard.L${L}.js`], matches: ['<all_urls>'], world: 'MAIN', ...common },
  ];
  for (const s of await getScriptletIndex()) {
    if (s.level > L || !s.matches.length) continue;
    scripts.push({ id: `sg-s-${s.id}`, js: [s.file], matches: s.matches, world: 'MAIN', ...common });
  }
  try {
    await register(scripts);
    await setWarning('scripts', null);
  } catch (err) {
    // Register the essentials even if a scriptlet bundle is rejected.
    await register(scripts.slice(0, 2)).catch(() => {});
    await setWarning('scripts', `Some page scripts could not be registered: ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Toolbar

async function applyToolbar(settings) {
  const state = settings.enabled ? 'on' : 'off';
  const path = Object.fromEntries([16, 32, 48, 128].map((s) => [s, `icons/${state}-${s}.png`]));
  await api.action.setIcon({ path }).catch(() => {});
  await api.action.setTitle({ title: settings.enabled ? `Stronguard: level ${settings.level}` : 'Stronguard: paused' }).catch(() => {});
  if (api.action.setBadgeBackgroundColor) await api.action.setBadgeBackgroundColor({ color: '#d7263d' }).catch(() => {});
  if (api.declarativeNetRequest.setExtensionActionOptions) {
    await api.declarativeNetRequest
      .setExtensionActionOptions({ displayActionCountAsBadgeText: settings.badge && settings.enabled })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------

let chain = Promise.resolve();

// Serialised so that quick slider moves cannot interleave browser API calls.
export function applyAll() {
  chain = chain.then(async () => {
    const settings = await getSettings();
    const info = await getBuildInfo();
    await applyRulesets(settings, info);
    await applyDynamicRules(settings);
    await applyRegistrations(settings, info);
    await applyToolbar(settings);
  }).catch((err) => console.error('Stronguard: apply failed', err));
  return chain;
}

export async function allowOnce(tabId, url) {
  const host = new URL(url).hostname;
  const existing = await api.declarativeNetRequest.getSessionRules();
  const id = existing.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  await api.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: PRIORITY_PROCEED,
      action: { type: 'allow' },
      condition: { requestDomains: [host], resourceTypes: ['main_frame'], tabIds: [tabId] },
    }],
  });
}
