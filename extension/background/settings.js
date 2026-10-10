// Persistent settings and statistics.

import { DEFAULT_LEVEL, clampLevel } from '../core/levels.js';

export const api = globalThis.browser || globalThis.chrome;

export const DEFAULT_SETTINGS = {
  enabled: true,
  level: DEFAULT_LEVEL,
  allowlist: [],
  customFilters: '',
  extraLists: [],
  shieldUrl: 'http://127.0.0.1:8080',
  shieldSync: true,
  badge: true,
};

let cache = null;

export async function getSettings() {
  if (cache) return cache;
  const { settings } = await api.storage.local.get('settings');
  cache = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  cache.level = clampLevel(cache.level);
  return cache;
}

export function normalizeHostList(list) {
  const out = new Set();
  for (const raw of list || []) {
    let h = String(raw).trim().toLowerCase();
    if (!h) continue;
    try {
      if (h.includes('/')) h = new URL(h.includes('://') ? h : `https://${h}`).hostname;
    } catch {
      continue;
    }
    h = h.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    if (/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(h) || h === 'localhost') out.add(h);
  }
  return [...out].sort();
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  next.level = clampLevel(next.level);
  next.allowlist = normalizeHostList(next.allowlist);
  next.extraLists = [...new Set((next.extraLists || []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//.test(u)))];
  cache = next;
  await api.storage.local.set({ settings: next });
  return next;
}

export function isAllowlisted(hostname, allowlist) {
  const h = String(hostname || '').toLowerCase();
  return allowlist.some((d) => h === d || h.endsWith(`.${d}`));
}

// ---------------------------------------------------------------------------
// Statistics. Writes are serialised so concurrent messages do not lose counts.

let statsQueue = Promise.resolve();

export function addStats(delta, tabId) {
  statsQueue = statsQueue.then(async () => {
    const { stats = { since: Date.now() } } = await api.storage.local.get('stats');
    for (const [k, v] of Object.entries(delta)) stats[k] = (stats[k] || 0) + v;
    await api.storage.local.set({ stats });
    if (tabId !== undefined && tabId >= 0 && api.storage.session) {
      const key = `tab:${tabId}`;
      const cur = (await api.storage.session.get(key))[key] || {};
      for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + v;
      await api.storage.session.set({ [key]: cur });
    }
  }).catch(() => {});
  return statsQueue;
}

export async function getStats(tabId) {
  const { stats = {} } = await api.storage.local.get('stats');
  let tab = {};
  if (tabId !== undefined && api.storage.session) tab = (await api.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || {};
  return { total: stats, tab };
}

export async function resetTabStats(tabId) {
  if (api.storage.session) await api.storage.session.remove(`tab:${tabId}`);
}

export async function resetStats() {
  await api.storage.local.set({ stats: { since: Date.now() } });
}
