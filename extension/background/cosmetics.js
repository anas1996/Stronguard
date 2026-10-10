// Cosmetic filtering in the background: looks up site-specific rules from the
// sharded database, matches generic rules against DOM tokens reported by the
// content script, and injects the CSS with origin USER (beats page !important).

import { hostnameKeys } from '../core/domains.js';
import { shardFor } from '../core/cosmetic.js';
import { EMBED_ALLOWLIST } from '../core/dnr.js';
import { api, isAllowlisted } from './settings.js';

const fetchJSON = (path) => fetch(api.runtime.getURL(path)).then((r) => r.json());

let generic = null;
const shards = new Map();
let user = null;
const contexts = new Map(); // `${hostname}|${level}` -> context
const unkeyedCache = new Map(); // level -> css

const EMPTY_USER = { generic: { simple: {}, keyed: {}, unkeyed: [] }, specific: {} };

export function invalidateCosmetics() {
  user = null;
  contexts.clear();
  unkeyedCache.clear();
}

const getGeneric = () => (generic ||= fetchJSON('data/generic.json'));

const getShard = (i) => {
  if (!shards.has(i)) shards.set(i, fetchJSON(`data/specific/${i}.json`).catch(() => ({})));
  return shards.get(i);
};

async function getUser() {
  if (!user) {
    const { userCosmetics } = await api.storage.local.get('userCosmetics');
    user = userCosmetics || EMPTY_USER;
  }
  return user;
}

const withImportant = (style) =>
  style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (/!important\s*$/i.test(d) ? d : `${d} !important`))
    .join(';');

const hideRule = (sel) => `${sel}{display:none!important}`;

// Builds (and caches) everything the page needs for one hostname at one level.
async function contextFor(hostname, level) {
  const key = `${hostname}|${level}`;
  if (contexts.has(key)) return contexts.get(key);
  const keys = hostnameKeys(hostname);
  const entries = [];
  await Promise.all(
    keys.map(async (k) => {
      const shard = await getShard(shardFor(k));
      if (shard[k]) entries.push({ e: shard[k], user: false });
    }),
  );
  const u = await getUser();
  for (const k of keys) if (u.specific[k]) entries.push({ e: u.specific[k], user: true });

  const active = (lvl, isUser) => isUser || lvl <= level;
  const unhide = new Set();
  let generichide = false;
  let specifichide = false;
  for (const { e, user: isUser } of entries) {
    for (const s of e.unhide || []) unhide.add(s);
    if (e.generichide !== undefined && active(e.generichide, isUser)) generichide = true;
    if (e.specifichide !== undefined && active(e.specifichide, isUser)) specifichide = true;
  }
  const css = [];
  const procedural = [];
  for (const { e, user: isUser } of entries) {
    if (!specifichide || isUser) {
      for (const [sel, lvl] of e.hide || []) if (active(lvl, isUser) && !unhide.has(sel)) css.push(hideRule(sel));
    }
    for (const [sel, style, lvl] of e.style || []) if (active(lvl, isUser)) css.push(`${sel}{${withImportant(style)}}`);
    for (const [rule, lvl] of e.procedural || []) if (active(lvl, isUser)) procedural.push(rule);
  }
  const ctx = { unhide, generichide, specifichide, css: css.join('\n'), procedural };
  if (contexts.size > 300) contexts.delete(contexts.keys().next().value);
  contexts.set(key, ctx);
  return ctx;
}

async function unkeyedCss(level, unhide) {
  const g = await getGeneric();
  const u = await getUser();
  if (!unhide.size && unkeyedCache.has(level)) return unkeyedCache.get(level);
  const out = [];
  for (const [sel, lvl] of g.unkeyed) if (lvl <= level && !unhide.has(sel)) out.push(hideRule(sel));
  for (const [sel] of u.generic.unkeyed || []) if (!unhide.has(sel)) out.push(hideRule(sel));
  const css = out.join('\n');
  if (!unhide.size) unkeyedCache.set(level, css);
  return css;
}

async function insertCss(sender, css) {
  if (!css || !sender.tab) return;
  try {
    await api.scripting.insertCSS({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
      css,
      origin: 'USER',
    });
  } catch {
    /* frame gone or restricted page */
  }
}

export function frameHostname(msg, sender) {
  for (const candidate of [msg.url, sender.url, sender.origin, sender.tab && sender.tab.url]) {
    try {
      const u = new URL(candidate);
      if (/^https?:$/.test(u.protocol) && u.hostname) return u.hostname;
    } catch {
      /* next */
    }
  }
  return '';
}

export async function handleHello(msg, sender, settings) {
  const hostname = frameHostname(msg, sender);
  if (!settings.enabled || !hostname) return { enabled: false };
  const pageHost = sender.tab && sender.tab.url ? frameHostname({ url: sender.tab.url }, {}) : hostname;
  if (isAllowlisted(hostname, settings.allowlist) || isAllowlisted(pageHost, settings.allowlist)) return { enabled: false };
  const ctx = await contextFor(hostname, settings.level);
  const parts = [ctx.css];
  if (!ctx.generichide) parts.push(await unkeyedCss(settings.level, ctx.unhide));
  await insertCss(sender, parts.filter(Boolean).join('\n'));
  return {
    enabled: true,
    level: settings.level,
    generichide: ctx.generichide,
    procedural: ctx.procedural,
    embedAllowlist: EMBED_ALLOWLIST,
  };
}

export async function handleTokens(msg, sender, settings) {
  const hostname = frameHostname(msg, sender);
  if (!settings.enabled || !hostname || !Array.isArray(msg.tokens)) return;
  const ctx = await contextFor(hostname, settings.level);
  if (ctx.generichide) return;
  const g = await getGeneric();
  const u = await getUser();
  const L = settings.level;
  const css = [];
  for (const tok of msg.tokens) {
    if (typeof tok !== 'string') continue;
    const lvl = g.simple[tok];
    if (lvl !== undefined && lvl <= L && !ctx.unhide.has(tok)) css.push(hideRule(tok));
    for (const [sel, l] of g.keyed[tok] || []) if (l <= L && !ctx.unhide.has(sel)) css.push(hideRule(sel));
    if (u.generic.simple[tok] !== undefined && !ctx.unhide.has(tok)) css.push(hideRule(tok));
    for (const [sel] of u.generic.keyed[tok] || []) if (!ctx.unhide.has(sel)) css.push(hideRule(sel));
  }
  if (css.length) await insertCss(sender, css.join('\n'));
}

export async function injectSelector(sender, selector) {
  await insertCss(sender, hideRule(selector));
}
