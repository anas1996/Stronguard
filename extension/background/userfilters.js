// Runtime compilation of the user's own filters and extra filter-list URLs into
// dynamic DNR rules + cosmetic data, using the same engine as the build.

import { parseFilterList } from '../core/parser.js';
import { DnrCompiler } from '../core/dnr.js';
import { CosmeticCompiler } from '../core/cosmetic.js';
import { api } from './settings.js';

const CUSTOM_PRIORITY_BOOST = 800; // user rules beat list rules (but not the allowlist)

function compile(sources, { custom }) {
  const dnr = new DnrCompiler();
  const cos = new CosmeticCompiler({ knownScriptlets: [] });
  const parsed = [];
  for (const text of sources) {
    const list = [];
    parseFilterList(text, (f) => list.push(f));
    parsed.push(list);
    for (const f of list) dnr.noteBadfilter(f);
  }
  for (const list of parsed) {
    for (const f of list) {
      if (f.type === 'network') dnr.add(f, 1, custom ? 1 : null);
      else cos.add(f, 0);
    }
  }
  const out = dnr.finalize({ builtins: false });
  cos.addNetworkExceptions(out.cosmeticExceptions);
  const rules = Object.values(out.rulesets)
    .flat()
    .map(({ id, ...r }) => (custom ? { ...r, priority: r.priority + CUSTOM_PRIORITY_BOOST } : r));
  return { rules, cosmetics: cos.finalize(), stats: { network: out.stats, cosmetic: cos.stats } };
}

function mergeCosmetics(a, b) {
  const out = {
    generic: {
      simple: { ...a.generic.simple, ...b.generic.simple },
      keyed: { ...a.generic.keyed },
      unkeyed: [...a.generic.unkeyed, ...b.generic.unkeyed],
    },
    specific: { ...a.specific },
  };
  for (const [k, v] of Object.entries(b.generic.keyed)) out.generic.keyed[k] = [...(out.generic.keyed[k] || []), ...v];
  for (const [host, e] of Object.entries(b.specific)) {
    const cur = out.specific[host] || {};
    const merged = { ...cur };
    for (const key of ['hide', 'unhide', 'style', 'procedural']) if (e[key]) merged[key] = [...(cur[key] || []), ...e[key]];
    for (const key of ['generichide', 'specifichide']) if (e[key] !== undefined) merged[key] = e[key];
    out.specific[host] = merged;
  }
  return out;
}

function limits() {
  const dnr = api.declarativeNetRequest;
  return {
    total: (dnr.MAX_NUMBER_OF_DYNAMIC_RULES || dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || 5000) - 10,
    unsafe: (dnr.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES || 5000) - 10,
    regex: (dnr.MAX_NUMBER_OF_REGEX_RULES || 1000) - 50,
  };
}

export async function compileUserFilters(settings) {
  const { extraListCache = {} } = await api.storage.local.get('extraListCache');
  const custom = compile([settings.customFilters || ''], { custom: true });
  const extraTexts = settings.extraLists.map((u) => extraListCache[u] && extraListCache[u].text).filter(Boolean);
  const extra = compile(extraTexts, { custom: false });

  // Respect browser limits; custom filters first.
  const lim = limits();
  let total = 0;
  let unsafe = 0;
  let regex = 0;
  let dropped = 0;
  const rules = [];
  for (const r of [...custom.rules, ...extra.rules]) {
    const isUnsafe = r.action.type === 'redirect' || r.action.type === 'modifyHeaders';
    const isRegex = !!r.condition.regexFilter;
    if (total >= lim.total || (isUnsafe && unsafe >= lim.unsafe) || (isRegex && regex >= lim.regex)) {
      dropped++;
      continue;
    }
    rules.push(r);
    total++;
    if (isUnsafe) unsafe++;
    if (isRegex) regex++;
  }
  const userCosmetics = mergeCosmetics(custom.cosmetics, extra.cosmetics);
  delete userCosmetics.scriptlets;
  const userFilterStats = {
    rules: rules.length,
    dropped,
    customNetwork: custom.rules.length,
    extraNetwork: extra.rules.length,
    cosmetic: custom.stats.cosmetic.generic + custom.stats.cosmetic.specific + extra.stats.cosmetic.generic + extra.stats.cosmetic.specific,
    compiledAt: Date.now(),
  };
  await api.storage.local.set({ userRules: rules, userCosmetics, userFilterStats });
  return userFilterStats;
}

export async function refreshExtraLists(settings) {
  const { extraListCache = {} } = await api.storage.local.get('extraListCache');
  const next = {};
  for (const url of settings.extraLists) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      next[url] = { text, fetchedAt: Date.now(), ok: true, size: text.length };
    } catch (err) {
      next[url] = { ...(extraListCache[url] || {}), ok: false, error: String(err.message || err), triedAt: Date.now() };
    }
  }
  await api.storage.local.set({ extraListCache: next });
  return compileUserFilters(settings);
}

export async function extraListStatus() {
  const { extraListCache = {} } = await api.storage.local.get('extraListCache');
  return Object.fromEntries(
    Object.entries(extraListCache).map(([url, v]) => [url, { ok: v.ok, size: v.size || 0, fetchedAt: v.fetchedAt || 0, error: v.error || '' }]),
  );
}
