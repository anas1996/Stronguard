// Hostname matching shared by the DNS sinkhole, the proxy and the extension.

import { isValidHostname, normalizeHostname } from './parser.js';

// Common TLDs used to expand uBO "entity" filters (example.*) into concrete
// hostnames where wildcards are not supported (DNR rules, match patterns).
export const ENTITY_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'to', 'tv', 'cc', 'me', 'ws', 'ru', 'info', 'xyz', 'top',
  'site', 'online', 'live', 'sx', 'is', 'ag', 'li', 'la', 'gg', 'se', 'nl', 'pl', 'de', 'fr',
  'es', 'it', 'pro', 'biz', 'club', 'cam', 'lol', 'mx', 'in', 'pw', 'vip', 'one', 'cx', 'su',
  'ac', 'nu', 'bz', 'tw', 'icu', 'fun', 'cfd', 'skin', 'stream', 'watch', 'movie', 'link',
  'co.uk', 'com.br', 'com.mx', 'com.tr', 'com.au', 'co.in', 'net.in',
];

export function expandEntity(domain) {
  if (!domain.endsWith('.*')) return [domain];
  const base = domain.slice(0, -2);
  return ENTITY_TLDS.map((t) => `${base}.${t}`);
}

// Candidate keys to look up for a hostname: itself, every parent domain, and the
// entity forms (label.* ) used by cosmetic and scriptlet filters.
export function hostnameKeys(hostname, { entities = true } = {}) {
  const keys = [];
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length; i++) keys.push(labels.slice(i).join('.'));
  if (entities && labels.length >= 2) {
    // strip 1 or 2 trailing labels (example.com -> example.*, example.co.uk -> example.*)
    for (let cut = 1; cut <= 2 && cut < labels.length; cut++) {
      const head = labels.slice(0, labels.length - cut);
      for (let i = 0; i < head.length; i++) keys.push(`${head.slice(i).join('.')}.*`);
    }
  }
  return keys;
}

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'ne', 'or', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc']);

// Approximate registrable domain (eTLD+1) without shipping the public suffix list.
export function registrableDomain(hostname) {
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

export function isThirdParty(requestHost, initiatorHost) {
  if (!initiatorHost) return false;
  return registrableDomain(requestHost) !== registrableDomain(initiatorHost);
}

// Converts a hostname wildcard pattern (ad*.example.com, *.ads.*) into a RegExp.
export function hostWildcardToRegExp(pattern) {
  const body = pattern
    .replace(/^\*\./, '')
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[a-z0-9_.-]*');
  return new RegExp(`(?:^|\\.)${body}$`);
}

// Domain matcher: suffix matching against block/allow sets, plus wildcard and
// regex rules. Allow beats block unless the block rule is $important.
export class DomainMatcher {
  constructor() {
    this.block = new Map(); // hostname -> source id
    this.allow = new Map();
    this.important = new Map();
    this.regexBlock = [];
    this.regexAllow = [];
  }

  get size() {
    return this.block.size + this.important.size + this.regexBlock.length;
  }

  addBlock(hostname, source = '', important = false) {
    const h = normalizeHostname(hostname);
    if (!isValidHostname(h)) return false;
    const map = important ? this.important : this.block;
    if (!map.has(h)) map.set(h, source);
    return true;
  }

  addAllow(hostname, source = '') {
    const h = normalizeHostname(hostname);
    if (!isValidHostname(h)) return false;
    if (!this.allow.has(h)) this.allow.set(h, source);
    return true;
  }

  removeBlock(hostname) {
    const h = normalizeHostname(hostname);
    this.block.delete(h);
    this.important.delete(h);
  }

  addRegex(re, source = '', allow = false) {
    try {
      const r = re instanceof RegExp ? re : new RegExp(re, 'i');
      (allow ? this.regexAllow : this.regexBlock).push({ re: r, source });
      return true;
    } catch {
      return false;
    }
  }

  addWildcard(pattern, source = '', allow = false) {
    return this.addRegex(hostWildcardToRegExp(pattern.toLowerCase()), source, allow);
  }

  static lookup(map, hostname) {
    let h = hostname;
    for (;;) {
      const v = map.get(h);
      if (v !== undefined) return { rule: h, source: v };
      const dot = h.indexOf('.');
      if (dot === -1) return null;
      h = h.slice(dot + 1);
    }
  }

  static lookupRegex(list, hostname) {
    for (const { re, source } of list) {
      if (re.test(hostname)) return { rule: re.source, source };
    }
    return null;
  }

  // Returns { blocked, rule, source, allowed? }
  match(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return { blocked: false };
    const imp = DomainMatcher.lookup(this.important, h);
    if (imp) return { blocked: true, important: true, ...imp };
    const allow = DomainMatcher.lookup(this.allow, h) || DomainMatcher.lookupRegex(this.regexAllow, h);
    if (allow) return { blocked: false, allowed: true, ...allow };
    const block = DomainMatcher.lookup(this.block, h) || DomainMatcher.lookupRegex(this.regexBlock, h);
    if (block) return { blocked: true, ...block };
    return { blocked: false };
  }
}

// Builds a DomainMatcher from parsed filters (as produced by parseFilterList).
// Only filters that make sense at DNS level are used: pure hostname rules with no
// options, or with options that do not depend on the browser context.
export function isDnsUsable(filter, { includeThirdParty = false } = {}) {
  if (filter.type !== 'network') return false;
  if (!['hostname', 'hostwildcard', 'regex'].includes(filter.kind)) return false;
  const o = filter.options;
  if (o.initiatorDomains || o.excludedInitiatorDomains || o.requestDomains || o.excludedRequestDomains) return false;
  if (o.methods || o.redirect || o.removeparam !== undefined || o.csp !== undefined) return false;
  if (o.elemhide || o.generichide || o.specifichide || o.matchCase) return false;
  if (o.thirdParty === false) return false;
  if (o.thirdParty === true && !includeThirdParty) return false;
  // Type-restricted rules (e.g. $script) only make sense in a browser, except $all.
  if (o.types && !(o.document && o.popup)) return false;
  if (o.notTypes) return false;
  return true;
}

export function addFilterToMatcher(matcher, f, source) {
  if (f.kind === 'hostname') {
    if (f.exception) matcher.addAllow(f.hostname, source);
    else matcher.addBlock(f.hostname, source, f.options.important);
  } else if (f.kind === 'hostwildcard') {
    matcher.addWildcard(f.pattern, source, f.exception);
  } else if (f.kind === 'regex') {
    // Only regexes clearly written for hostnames (AdGuard DNS / HaGeZi style)
    if (/^\^?[\\a-z0-9([.]/i.test(f.regex) && !f.regex.includes('/')) matcher.addRegex(f.regex, source, f.exception);
  }
}
