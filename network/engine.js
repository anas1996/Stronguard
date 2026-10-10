// Network-level filter engine: builds the hostname matcher for the active level
// from the DNS lists in the catalog plus the user's own rules.

import path from 'node:path';
import crypto from 'node:crypto';
import { listsFor } from '../core/catalog.js';
import { parseFilter, parseFilterList, badfilterTarget, normalizeHostname } from '../core/parser.js';
import { DomainMatcher, isDnsUsable, addFilterToMatcher } from '../core/domains.js';
import { featuresFor } from '../core/levels.js';
import { loadList } from './lists.js';

// Never blocked: OS connectivity checks and captive-portal detection, which
// would otherwise make Windows/browsers report "No internet".
export const ALWAYS_ALLOW = [
  'msftconnecttest.com', 'msftncsi.com', 'connectivitycheck.gstatic.com', 'clients3.google.com',
  'captive.apple.com', 'detectportal.firefox.com', 'nmcheck.gnome.org', 'network-test.debian.org',
  'windowsupdate.com', 'update.microsoft.com', 'ocsp.digicert.com', 'crl.microsoft.com',
];

// Canary domains: answering NXDOMAIN tells browsers/OSes to stop bypassing the
// local resolver (Firefox DoH, iCloud Private Relay).
export const BYPASS_CANARIES = ['use-application-dns.net', 'mask.icloud.com', 'mask-h2.icloud.com'];

// Public DNS-over-HTTPS endpoints browsers and apps use to bypass local DNS.
export const DOH_HOSTNAMES = [
  'dns.google', 'dns.google.com', 'dns64.dns.google', 'cloudflare-dns.com', 'chrome.cloudflare-dns.com',
  'mozilla.cloudflare-dns.com', 'one.one.one.one', '1dot1dot1dot1.cloudflare-dns.com', 'security.cloudflare-dns.com',
  'family.cloudflare-dns.com', 'dns.quad9.net', 'dns9.quad9.net', 'dns10.quad9.net', 'dns11.quad9.net',
  'doh.opendns.com', 'doh.familyshield.opendns.com', 'dns.nextdns.io', 'dns.adguard-dns.com', 'dns.adguard.com',
  'unfiltered.adguard-dns.com', 'family.adguard-dns.com', 'doh.cleanbrowsing.org', 'dns.mullvad.net',
  'adblock.dns.mullvad.net', 'doh.mullvad.net', 'dns.controld.com', 'freedns.controld.com', 'doh.dns.sb',
  'dns.alidns.com', 'doh.pub', 'doh.360.cn', 'dns.twnic.tw', 'doh.libredns.gr', 'dns.decloudus.com',
  'doh.xfinity.com', 'dohtrial.att.net', 'dns.brahma.world', 'dns0.eu', 'zero.dns0.eu', 'kids.dns0.eu',
  'dns.switch.ch', 'dns.digitale-gesellschaft.ch', 'odvr.nic.cz', 'doh.ffmuc.net', 'dns.njal.la',
];

function hashId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

export class FilterEngine {
  constructor({ root, dataDir, log = () => {} }) {
    this.root = root;
    this.cacheDir = path.join(dataDir, 'lists');
    this.log = log;
    this.matcher = new DomainMatcher();
    this.sources = []; // index -> list id
    this.lists = [];
    this.level = null;
    this.userAllow = new DomainMatcher();
    this.userBlock = new DomainMatcher();
    this.canaries = new Set();
    this.loading = null;
    this.loadedAt = 0;
  }

  // Loads (or reloads) everything for `config.level`. refresh=true forces re-downloads.
  async load(config, { refresh = false, offline = false } = {}) {
    if (this.loading) await this.loading.catch(() => {});
    this.loading = this._load(config, { refresh, offline });
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async _load(config, { refresh, offline }) {
    const level = config.level;
    const F = featuresFor(level);
    const started = Date.now();
    const matcher = new DomainMatcher();
    const sources = ['always-allow', 'stronguard-bypass', 'user'];
    for (const d of ALWAYS_ALLOW) matcher.addAllow(d, 0);

    const entries = listsFor('dns', level).map((e) => ({ ...e }));
    for (const url of config.extraLists || []) {
      entries.push({ id: `extra-${hashId(url)}`, title: url, level: 1, category: 'extra', targets: ['dns'], urls: [url] });
    }

    // Download/read everything first, then stream-parse each list straight into the
    // matcher (keeping parsed filter objects around would multiply peak memory).
    const loaded = [];
    for (const e of entries) {
      const r = await loadList(e, {
        root: this.root,
        cacheDir: this.cacheDir,
        offline,
        maxAgeHours: refresh ? 0 : config.updateIntervalHours || 24,
        log: this.log,
      });
      loaded.push({ e, r });
    }
    const badfilters = new Set();
    for (const { r } of loaded) {
      if (!r.ok || !r.text.includes('badfilter')) continue;
      for (const line of r.text.split('\n')) {
        if (!line.includes('badfilter')) continue;
        const f = parseFilter(line);
        if (f.type === 'network' && f.options.badfilter) badfilters.add(badfilterTarget(f.raw));
      }
    }
    const lists = [];
    for (const item of loaded) {
      const { e, r } = item;
      const idx = sources.push(e.id) - 1;
      let rules = 0;
      if (r.ok) {
        parseFilterList(r.text, (f) => {
          if (f.type !== 'network' || f.options.badfilter) return;
          if (!isDnsUsable(f, { includeThirdParty: F.dnsIncludeThirdPartyRules })) return;
          if (badfilters.size && badfilters.has(f.raw)) return;
          addFilterToMatcher(matcher, f, idx);
          rules++;
        });
      }
      lists.push({ id: e.id, title: e.title, level: e.level, ok: r.ok, source: r.source, rules, fetchedAt: r.fetchedAt || 0 });
      item.r = null;
    }

    if (F.dnsBlockDoH) for (const d of DOH_HOSTNAMES) matcher.addBlock(d, 1, true);
    const canaries = new Set(F.dnsBlockBypassCanaries ? BYPASS_CANARIES : []);

    // Custom rules in filter syntax (||ads.example^, @@||good.example^, hosts lines...)
    if (config.customRules && config.customRules.length) {
      parseFilterList(config.customRules.join('\n'), (f) => {
        if (f.type === 'network' && isDnsUsable(f, { includeThirdParty: true })) addFilterToMatcher(matcher, f, 2);
      });
    }

    const userAllow = new DomainMatcher();
    const userBlock = new DomainMatcher();
    for (const d of config.allowlist || []) userAllow.addAllow(d, 2);
    for (const d of config.blocklist || []) userBlock.addBlock(d, 2);

    // Swap atomically
    this.matcher = matcher;
    this.sources = sources;
    this.lists = lists;
    this.level = level;
    this.canaries = canaries;
    this.userAllow = userAllow;
    this.userBlock = userBlock;
    this.loadedAt = Date.now();
    const total = matcher.block.size + matcher.important.size;
    this.log(`Filter engine: level ${level}, ${total.toLocaleString()} blocked domains, ${matcher.regexBlock.length} patterns from ${lists.filter((l) => l.ok).length}/${lists.length} lists in ${Date.now() - started} ms`);
    return { level, domains: total, lists };
  }

  // Applies only user allow/block changes without reloading lists.
  setUserLists(config) {
    const userAllow = new DomainMatcher();
    const userBlock = new DomainMatcher();
    for (const d of config.allowlist || []) userAllow.addAllow(d, 2);
    for (const d of config.blocklist || []) userBlock.addBlock(d, 2);
    this.userAllow = userAllow;
    this.userBlock = userBlock;
  }

  // Returns { blocked, reason, rule, list }
  match(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return { blocked: false };
    const ua = DomainMatcher.lookup(this.userAllow.allow, h);
    if (ua) return { blocked: false, reason: 'user-allow', rule: ua.rule, list: 'user' };
    const ub = DomainMatcher.lookup(this.userBlock.block, h);
    if (ub) return { blocked: true, reason: 'user-block', rule: ub.rule, list: 'user' };
    if (this.canaries.has(h)) return { blocked: true, reason: 'bypass-canary', rule: h, list: 'stronguard-bypass', nxdomain: true };
    const m = this.matcher.match(h);
    if (m.blocked) return { blocked: true, reason: 'list', rule: m.rule, list: this.sources[m.source] || '?' };
    if (m.allowed) return { blocked: false, reason: 'allow', rule: m.rule, list: this.sources[m.source] || '?' };
    return { blocked: false };
  }

  summary() {
    return {
      level: this.level,
      domains: this.matcher.block.size + this.matcher.important.size,
      patterns: this.matcher.regexBlock.length,
      allows: this.matcher.allow.size,
      loadedAt: this.loadedAt,
      lists: this.lists,
    };
  }
}
