// Compiles parsed network filters into declarativeNetRequest (DNR) rulesets.
//
// Rulesets are split by protection level so the extension can switch levels by
// enabling/disabling static rulesets:
//   net_l{N}    subresource block/allow/redirect/removeparam/csp rules
//   doc_l{N}    top-level page blocking (popups, malvertising, ad/tracker domains)
//   ping_l4     third-party pings/beacons
//   frames_l5   third-party iframes (except an embed allowlist)
//
// Hostname rules sharing the same options are merged into a single DNR rule with
// a large requestDomains array, which keeps hundreds of thousands of domains
// within the browser's static rule budget.

import { ALL_SUBRESOURCE_TYPES, badfilterTarget } from './parser.js';
import { expandEntity } from './domains.js';

export const PRIORITY = {
  removeparam: 10,
  csp: 20,
  block: 100,
  redirect: 110,
  allow: 200,
  allowAllRequests: 210,
  important: 300,
  userBlock: 900,
  userAllow: 1000,
};

export const BLOCKED_PAGE = '/ui/blocked.html';

// Neutered replacement resources shipped in extension/resources.
const REDIRECTS = new Map();
function addRedirect(file, ...names) {
  for (const n of names) REDIRECTS.set(n, file);
}
addRedirect('noop.js', 'noopjs', 'noop.js', 'blank-js', 'noop-js');
addRedirect('noop.txt', 'nooptext', 'noop.txt', 'blank-text');
addRedirect('noop.html', 'noopframe', 'noop.html', 'blank-html');
addRedirect('noop.json', 'noopjson', 'noop.json');
addRedirect('noop.css', 'noopcss', 'noop.css', 'blank-css');
addRedirect('1x1.gif', '1x1.gif', '1x1-transparent.gif', '1x1-transparent-gif', 'blank-gif');
addRedirect('2x2.png', '2x2.png', '2x2-transparent.png', 'blank-png');
addRedirect('3x2.png', '3x2.png', '3x2-transparent.png');
addRedirect('32x32.png', '32x32.png', '32x32-transparent.png');
addRedirect('noop-vmap1.xml', 'noopvmap-1.0', 'noop-vmap1.0.xml', 'noopvmap');
addRedirect('noop-vast2.xml', 'noopvast-2.0', 'noop-vast2.xml');
addRedirect('noop-vast3.xml', 'noopvast-3.0', 'noop-vast3.xml');
addRedirect('noop-vast4.xml', 'noopvast-4.0', 'noop-vast4.xml', 'noopvast');
addRedirect('googlesyndication_adsbygoogle.js', 'googlesyndication_adsbygoogle.js', 'googlesyndication.com/adsbygoogle.js', 'googlesyndication-adsbygoogle');
addRedirect('google-analytics_analytics.js', 'google-analytics_analytics.js', 'google-analytics.com/analytics.js', 'google-analytics_ga.js', 'google-analytics.com/ga.js', 'googletagmanager_gtm.js', 'googletagmanager.com/gtm.js', 'google-analytics-ga', 'googletagmanager-gtm');
addRedirect('googletagservices_gpt.js', 'googletagservices_gpt.js', 'googletagservices.com/gpt.js', 'googletagservices-gpt');
addRedirect('amazon_apstag.js', 'amazon_apstag.js', 'amazon-adsystem.com/aax2/amzn_ads.js', 'amazon-apstag');
addRedirect('prebid-ads.js', 'prebid-ads.js');
addRedirect('google-ima.js', 'google-ima.js', 'google-ima3', 'google-ima', 'google-ima3.js');
addRedirect('scorecardresearch_beacon.js', 'scorecardresearch_beacon.js', 'scorecardresearch.com/beacon.js');

export function redirectResource(name) {
  return REDIRECTS.get(name) || null;
}
export const REDIRECT_FILES = [...new Set(REDIRECTS.values())];

// Third-party iframes still allowed at level 5 (video, payments, captchas, sign-in, maps).
export const EMBED_ALLOWLIST = [
  'youtube.com', 'youtube-nocookie.com', 'ytimg.com', 'googlevideo.com', 'vimeo.com', 'vimeocdn.com',
  'dailymotion.com', 'twitch.tv', 'spotify.com', 'soundcloud.com', 'bandcamp.com', 'wistia.com',
  'wistia.net', 'jwplayer.com', 'jwplatform.com', 'brightcove.net', 'kaltura.com', 'cloudflarestream.com',
  'videodelivery.net', 'mux.com', 'streamable.com', 'loom.com', 'archive.org', 'google.com', 'gstatic.com',
  'recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com', 'arkoselabs.com', 'funcaptcha.com',
  'stripe.com', 'stripe.network', 'paypal.com', 'paypalobjects.com', 'braintreegateway.com', 'adyen.com',
  'checkout.com', 'klarna.com', 'plaid.com', 'apple.com', 'icloud.com', 'microsoft.com', 'live.com',
  'microsoftonline.com', 'office.com', 'sharepoint.com', 'auth0.com', 'okta.com', 'duosecurity.com',
  'figma.com', 'typeform.com', 'calendly.com', 'zoom.us', 'codepen.io', 'jsfiddle.net', 'codesandbox.io',
  'stackblitz.com', 'openstreetmap.org', 'mapbox.com', 'arcgis.com', 'bing.com', 'here.com',
];

const VALID_METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);
const MAX_DOMAINS_PER_RULE = 10000;
export const MAX_REGEX_RULES = 900; // Chrome allows 1000 across enabled static rulesets

export function isAscii(s) {
  return /^[\x20-\x7e]*$/.test(s);
}

// RE2 (used by Chrome DNR) does not support lookarounds or backreferences.
export function isRe2Compatible(re) {
  if (re.length > 400 || !isAscii(re)) return false;
  if (/\(\?[=!<]|\\[1-9]|\(\?>|[*+?}]\+/.test(re)) return false;
  try {
    new RegExp(re);
  } catch {
    return false;
  }
  return true;
}

function cleanUrlFilter(p) {
  let s = p;
  if (s.startsWith('||*')) s = s.slice(3).replace(/^\*+/, '');
  if (!isAscii(s)) return null;
  const inner = s.replace(/^\|\|?/, '').replace(/\|$/, '');
  if (inner.includes('|')) return null;
  if (s === '' || s === '|' || s === '||') return null;
  return s;
}

function expandDomains(list) {
  const out = [];
  for (const d of list) for (const e of expandEntity(d)) out.push(e);
  return [...new Set(out)];
}

// Builds the DNR condition for a filter, or null if it cannot be expressed.
function buildCondition(f, { resourceTypes } = {}) {
  const o = f.options;
  const c = {};
  switch (f.kind) {
    case 'hostname':
      c.requestDomains = [f.hostname];
      break;
    case 'pattern': {
      const u = cleanUrlFilter(f.pattern);
      if (!u) return null;
      c.urlFilter = u;
      break;
    }
    case 'regex':
      if (!isRe2Compatible(f.regex)) return null;
      c.regexFilter = f.regex;
      break;
    case 'hostwildcard': {
      const body = f.pattern.replace(/^\*\./, '').split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9.-]*');
      c.regexFilter = `^[a-z-]+://(?:[^/?#]*\\.)?${body}[:/?#]`;
      break;
    }
    case 'any':
      break;
    default:
      return null;
  }
  if (o.matchCase && (c.urlFilter || c.regexFilter)) c.isUrlFilterCaseSensitive = true;
  if (o.thirdParty !== null) c.domainType = o.thirdParty ? 'thirdParty' : 'firstParty';
  if (o.initiatorDomains) c.initiatorDomains = expandDomains(o.initiatorDomains);
  if (o.excludedInitiatorDomains) c.excludedInitiatorDomains = expandDomains(o.excludedInitiatorDomains);
  if (o.requestDomains) {
    if (c.requestDomains) return null;
    c.requestDomains = expandDomains(o.requestDomains);
  }
  if (o.excludedRequestDomains) c.excludedRequestDomains = expandDomains(o.excludedRequestDomains);
  if (o.methods) {
    if (!o.methods.every((m) => VALID_METHODS.has(m))) return null;
    c.requestMethods = o.methods;
  }
  if (o.excludedMethods) {
    if (!o.excludedMethods.every((m) => VALID_METHODS.has(m))) return null;
    c.excludedRequestMethods = o.excludedMethods;
  }
  if (resourceTypes) {
    c.resourceTypes = resourceTypes;
  } else if (o.types) {
    c.resourceTypes = [...o.types].sort();
  } else if (o.notTypes) {
    c.excludedResourceTypes = [...new Set(['main_frame', ...o.notTypes])].sort();
  }
  // A rule needs at least one constraint; a bare "match everything" rule is too dangerous.
  const constrained = c.requestDomains || c.urlFilter || c.regexFilter || c.initiatorDomains || c.domainType || c.resourceTypes;
  if (!constrained) return null;
  return c;
}

const hasOnly = (o, keys) => {
  for (const k of ['types', 'notTypes', 'thirdParty', 'initiatorDomains', 'excludedInitiatorDomains', 'requestDomains',
    'excludedRequestDomains', 'methods', 'excludedMethods', 'redirect', 'csp']) {
    if (keys.includes(k)) continue;
    if (o[k] !== null && o[k] !== undefined) return false;
  }
  return o.removeparam === undefined && !o.document && !o.popup && !o.matchCase;
};

export class DnrCompiler {
  constructor() {
    this.badfilters = new Set();
    this.rules = []; // { ruleset, level, rule, mergeable }
    this.removeparam = { generic: new Map(), exclusions: new Map(), globalExclusions: new Set() };
    this.cosmeticExceptions = [];
    this.stats = { input: 0, dropped: 0, reasons: {} };
  }

  drop(reason) {
    this.stats.dropped++;
    this.stats.reasons[reason] = (this.stats.reasons[reason] || 0) + 1;
  }

  // First pass: remember $badfilter rules so the filters they cancel are skipped.
  noteBadfilter(f) {
    if (f.type === 'network' && f.options.badfilter) this.badfilters.add(badfilterTarget(f.raw));
  }

  push(ruleset, level, rule, mergeable = false) {
    this.rules.push({ ruleset, level, rule, mergeable });
  }

  // f: parsed network filter; level: list level; docLevel: level from which plain
  // hostname blocks also block top-level pages (null = never)
  add(f, level, docLevel = null) {
    if (f.type !== 'network' || f.options.badfilter) return;
    this.stats.input++;
    if (this.badfilters.has(f.raw)) return this.drop('badfilter');
    const o = f.options;
    const net = `net_l${level}`;
    const doc = `doc_l${level}`;

    if (f.exception) return this.addException(f, level);

    if (o.removeparam !== undefined) return this.addRemoveparam(f, level);

    if (o.csp !== undefined) {
      if (!o.csp) return this.drop('csp-empty');
      const c = buildCondition(f, { resourceTypes: ['main_frame', 'sub_frame'] });
      if (!c) return this.drop('condition');
      return this.push(net, level, {
        priority: PRIORITY.csp,
        action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: o.csp }] },
        condition: c,
      });
    }

    const priority = o.important ? PRIORITY.important : PRIORITY.block;

    // Top-level page blocking: $document / $popup / $all
    if (o.document || o.popup) {
      const c = buildCondition(f, { resourceTypes: ['main_frame'] });
      if (c) {
        this.push(doc, level, { priority, action: { type: 'redirect', redirect: { extensionPath: BLOCKED_PAGE } }, condition: c }, f.kind === 'hostname');
      } else this.drop('condition');
      if (!o.types) return;
    }

    if (o.redirect && o.redirect !== 'block') {
      const file = redirectResource(o.redirect);
      if (file) {
        const c = buildCondition(f);
        if (!c) return this.drop('condition');
        return this.push(net, level, {
          priority: o.important ? PRIORITY.important + 10 : PRIORITY.redirect,
          action: { type: 'redirect', redirect: { extensionPath: `/resources/${file}` } },
          condition: c,
        });
      }
      this.drop('redirect-unknown-as-block');
    }

    const c = buildCondition(f);
    if (!c) return this.drop('condition');
    const mergeable = f.kind === 'hostname' && !c.urlFilter && !c.regexFilter;
    this.push(net, level, { priority, action: { type: 'block' }, condition: c }, mergeable);

    // Plain hostname with no options: also block it as a page from docLevel.
    if (docLevel !== null && f.kind === 'hostname' && hasOnly(o, [])) {
      this.push(`doc_l${docLevel}`, docLevel, {
        priority: PRIORITY.block,
        action: { type: 'redirect', redirect: { extensionPath: BLOCKED_PAGE } },
        condition: { requestDomains: [f.hostname], resourceTypes: ['main_frame'] },
      }, true);
    }
  }

  addException(f, level) {
    const o = f.options;
    const net = `net_l${level}`;
    if (o.elemhide || o.generichide || o.specifichide) {
      const domains = f.kind === 'hostname' ? [f.hostname] : (o.initiatorDomains || []);
      if (domains.length) {
        this.cosmeticExceptions.push({ domains: expandDomains(domains), elemhide: o.elemhide, generichide: o.generichide, specifichide: o.specifichide, level });
      }
      if (!o.types && !o.document) return;
    }
    if (o.removeparam !== undefined) {
      const hosts = f.kind === 'hostname' ? [f.hostname] : (o.initiatorDomains || o.requestDomains || []);
      if (!hosts.length) return this.drop('removeparam-exception-generic');
      const expanded = expandDomains(hosts);
      if (o.removeparam === '') expanded.forEach((h) => this.removeparam.globalExclusions.add(h));
      else {
        const set = this.removeparam.exclusions.get(o.removeparam) || new Set();
        expanded.forEach((h) => set.add(h));
        this.removeparam.exclusions.set(o.removeparam, set);
      }
      return;
    }
    if (o.csp !== undefined || o.redirect) return this.drop('exception-unsupported');
    if (o.document) {
      const c = buildCondition(f, { resourceTypes: ['main_frame', 'sub_frame'] });
      if (!c) return this.drop('condition');
      return this.push(net, level, { priority: PRIORITY.allowAllRequests, action: { type: 'allowAllRequests' }, condition: c });
    }
    if (o.popup && !o.types) {
      const c = buildCondition(f, { resourceTypes: ['main_frame'] });
      if (!c) return this.drop('condition');
      return this.push(`doc_l${level}`, level, { priority: PRIORITY.allow, action: { type: 'allow' }, condition: c });
    }
    const c = buildCondition(f);
    if (!c) return this.drop('condition');
    this.push(net, level, { priority: o.important ? PRIORITY.important + 20 : PRIORITY.allow, action: { type: 'allow' }, condition: c }, f.kind === 'hostname');
  }

  addRemoveparam(f, level) {
    const o = f.options;
    const p = o.removeparam;
    if (p === '' && !(o.initiatorDomains || o.requestDomains || f.kind === 'hostname')) return this.drop('removeparam-all-generic');
    if (p.startsWith('/') || p.startsWith('~') || /[*^|\s]/.test(p) || !isAscii(p)) return this.drop('removeparam-regex');
    const generic = f.kind === 'any' && !o.initiatorDomains && !o.excludedInitiatorDomains && !o.requestDomains &&
      !o.excludedRequestDomains && !o.methods && !o.document && !o.popup && !o.matchCase && !o.types && o.thirdParty === null;
    if (generic && p) {
      const prev = this.removeparam.generic.get(p);
      if (prev === undefined || level < prev) this.removeparam.generic.set(p, level);
      return;
    }
    const c = buildCondition(f, { resourceTypes: o.types ? [...o.types] : ['main_frame', 'sub_frame'] });
    if (!c) return this.drop('condition');
    if (p && !c.urlFilter && !c.regexFilter) c.urlFilter = `${p}=`;
    const transform = p ? { queryTransform: { removeParams: [p] } } : { query: '' };
    this.push(`net_l${level}`, level, { priority: PRIORITY.removeparam, action: { type: 'redirect', redirect: { transform } }, condition: c });
  }

  addBuiltins() {
    this.push('ping_l4', 4, {
      priority: PRIORITY.block,
      action: { type: 'block' },
      condition: { domainType: 'thirdParty', resourceTypes: ['ping', 'csp_report'] },
    });
    this.push('frames_l5', 5, {
      priority: PRIORITY.block,
      action: { type: 'block' },
      condition: { domainType: 'thirdParty', resourceTypes: ['sub_frame'], excludedRequestDomains: EMBED_ALLOWLIST },
    });
  }

  finalizeRemoveparam() {
    const global = [...this.removeparam.globalExclusions];
    for (const [param, level] of this.removeparam.generic) {
      const excl = [...(this.removeparam.exclusions.get(param) || []), ...global];
      const condition = { urlFilter: `${param}=`, resourceTypes: ['main_frame', 'sub_frame'] };
      if (excl.length) condition.excludedRequestDomains = [...new Set(excl)].sort();
      this.push(`net_l${level}`, level, {
        priority: PRIORITY.removeparam,
        action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [param] } } } },
        condition,
      });
    }
  }

  // Produces { rulesetId: [rules with ids] } and statistics.
  finalize({ builtins = true } = {}) {
    if (builtins) this.addBuiltins();
    this.finalizeRemoveparam();

    // Merge hostname rules with identical action/condition shape.
    const groups = new Map(); // key -> Map(hostname -> {level, ruleset})
    const shapes = new Map();
    const out = new Map();
    const addOut = (rs, rule) => {
      if (!out.has(rs)) out.set(rs, []);
      out.get(rs).push(rule);
    };
    let regexCount = 0;
    const sorted = this.rules.slice().sort((a, b) => a.level - b.level);
    const seen = new Set();
    for (const { ruleset, level, rule, mergeable } of sorted) {
      if (mergeable && rule.condition.requestDomains && rule.condition.requestDomains.length === 1) {
        const { requestDomains, ...rest } = rule.condition;
        const kind = ruleset.replace(/_l\d$/, '');
        const key = JSON.stringify([kind, rule.priority, rule.action, rest]);
        if (!groups.has(key)) {
          groups.set(key, new Map());
          shapes.set(key, { kind, priority: rule.priority, action: rule.action, rest });
        }
        const g = groups.get(key);
        const h = requestDomains[0];
        const prev = g.get(h);
        if (prev === undefined || level < prev) g.set(h, level);
        continue;
      }
      if (rule.condition.regexFilter) {
        if (regexCount >= MAX_REGEX_RULES) {
          this.drop('regex-budget');
          continue;
        }
        regexCount++;
      }
      const sig = `${ruleset}|${JSON.stringify(rule)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      addOut(ruleset, rule);
    }

    for (const [key, hosts] of groups) {
      const shape = shapes.get(key);
      // Drop hostnames already covered by a parent domain at the same or lower level.
      const byLevel = new Map();
      for (const [h, level] of hosts) {
        let covered = false;
        let p = h;
        for (let dot = p.indexOf('.'); dot !== -1; dot = p.indexOf('.')) {
          p = p.slice(dot + 1);
          const pl = hosts.get(p);
          if (pl !== undefined && pl <= level) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        if (!byLevel.has(level)) byLevel.set(level, []);
        byLevel.get(level).push(h);
      }
      for (const [level, list] of byLevel) {
        list.sort();
        for (let i = 0; i < list.length; i += MAX_DOMAINS_PER_RULE) {
          addOut(`${shape.kind}_l${level}`, {
            priority: shape.priority,
            action: shape.action,
            condition: { requestDomains: list.slice(i, i + MAX_DOMAINS_PER_RULE), ...shape.rest },
          });
        }
      }
    }

    const rulesets = {};
    for (const [rs, rules] of [...out.entries()].sort()) {
      rulesets[rs] = rules.map((r, i) => ({ id: i + 1, ...r }));
    }
    const counts = Object.fromEntries(Object.entries(rulesets).map(([k, v]) => [k, v.length]));
    return { rulesets, cosmeticExceptions: this.cosmeticExceptions, stats: { ...this.stats, regexCount, counts } };
  }
}
