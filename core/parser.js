// Filter syntax parser: Adblock Plus / uBlock Origin / AdGuard / hosts / domain lists.
//
// parseFilter(line, format) returns one of:
//   { type: 'network',   exception, kind, hostname|pattern|regex, options, raw }
//   { type: 'cosmetic',  exception, domains, selector, action, raw }
//   { type: 'scriptlet', exception, domains, name, args, raw }
//   { type: 'skip' | 'unsupported', reason }   (comments, headers, unsupported syntax)
//
// Pure ES module, no dependencies: runs in Node and in the extension service worker.

// ----------------------------------------------------------------------------
// Helpers

const HOSTNAME_RE = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;
const ENTITY_OR_HOST_RE = /^(?:[a-z0-9_*](?:[a-z0-9_*-]*[a-z0-9_*])?\.)*(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?|\*)$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOSTS_IGNORE = new Set([
  'localhost', 'localhost.localdomain', 'local', 'broadcasthost', '0.0.0.0', 'ip6-localhost',
  'ip6-loopback', 'ip6-localnet', 'ip6-mcastprefix', 'ip6-allnodes', 'ip6-allrouters', 'ip6-allhosts',
]);

export function isValidHostname(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 253 && h.includes('.') && HOSTNAME_RE.test(h) && !IPV4_RE.test(h);
}

export function normalizeHostname(h) {
  let s = String(h || '').trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.startsWith('*.')) s = s.slice(2);
  if (s.startsWith('.')) s = s.slice(1);
  return s;
}

// Parses "a.com|~b.com" (sep '|') or "a.com,~b.com" (sep ',').
// Returns null when an entry is not a valid hostname/entity (regex domains etc.).
export function parseDomainList(text, sep) {
  const include = [];
  const exclude = [];
  for (let part of text.split(sep)) {
    part = part.trim().toLowerCase();
    if (!part) continue;
    let negated = false;
    if (part.startsWith('~')) {
      negated = true;
      part = part.slice(1);
    }
    if (part.endsWith('.')) part = part.slice(0, -1);
    if (!ENTITY_OR_HOST_RE.test(part)) return null;
    (negated ? exclude : include).push(part);
  }
  return { include, exclude };
}

// ----------------------------------------------------------------------------
// Network filters

const TYPE_MAP = {
  script: 'script',
  image: 'image',
  img: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  ping: 'ping',
  beacon: 'ping',
  websocket: 'websocket',
  media: 'media',
  font: 'font',
  other: 'other',
  csp_report: 'csp_report',
  webtransport: 'webtransport',
  webbundle: 'webbundle',
};

export const ALL_SUBRESOURCE_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
];

// Options that are understood but cannot be expressed by our engines: rules using
// them are dropped rather than applied with the wrong semantics.
const UNSUPPORTED_OPTIONS = new Set([
  'header', 'permissions', 'urlskip', 'cname', 'ipaddress', 'replace', 'uritransform',
  'urltransform', 'jsonprune', 'hls', 'xmlprune', 'network', 'stealth', 'cookie', 'app',
  'extension', 'content', 'jsinject', 'urlblock', 'dnstype', 'dnsrewrite', 'client', 'ctag',
  'genericblock', 'redirect-rule', 'webrtc', 'object-subrequest-x', 'strict-first-party',
  'strict-third-party', 'referrerpolicy', 'removeheader', 'to-x',
]);
const IGNORED_OPTIONS = new Set(['reason', '_', 'stealth-x']);

const KNOWN_OPTIONS = new Set([
  ...Object.keys(TYPE_MAP), ...UNSUPPORTED_OPTIONS, ...IGNORED_OPTIONS,
  'document', 'doc', 'popup', 'popunder', 'all', 'third-party', '3p', 'first-party', '1p',
  'strict1p', 'strict3p', 'domain', 'from', 'to', 'denyallow', 'method', 'important',
  'match-case', 'badfilter', 'redirect', 'rewrite', 'removeparam', 'queryprune', 'csp',
  'inline-script', 'inline-font', 'empty', 'mp4', 'elemhide', 'ehide', 'generichide', 'ghide',
  'specifichide', 'shide',
]);

function emptyOptions() {
  return {
    types: null,
    notTypes: null,
    thirdParty: null,
    initiatorDomains: null,
    excludedInitiatorDomains: null,
    requestDomains: null,
    excludedRequestDomains: null,
    methods: null,
    excludedMethods: null,
    important: false,
    matchCase: false,
    badfilter: false,
    redirect: null,
    removeparam: undefined,
    csp: undefined,
    popup: false,
    document: false,
    elemhide: false,
    generichide: false,
    specifichide: false,
  };
}

function findOptionsStart(s) {
  for (let i = s.indexOf('$'); i !== -1; i = s.indexOf('$', i + 1)) {
    if (s[i + 1] === '$') return -2; // AdGuard HTML filtering ($$) - not supported
    const tail = s.slice(i + 1);
    const name = tail.split(/[,=]/, 1)[0].replace(/^~/, '').toLowerCase();
    if (KNOWN_OPTIONS.has(name)) return i;
  }
  return -1;
}

function splitOptions(text) {
  // Split on commas that start a new option (values such as regexes may contain commas).
  return text.split(/,(?=\s*~?[a-z0-9_-]+(?:=|,|$))/i).map((o) => o.trim()).filter(Boolean);
}

function addTo(obj, key, values) {
  obj[key] = (obj[key] || []).concat(values);
}

export function parseNetworkOptions(text) {
  const o = emptyOptions();
  for (const raw of splitOptions(text)) {
    const eq = raw.indexOf('=');
    let name = (eq === -1 ? raw : raw.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? null : raw.slice(eq + 1);
    let negated = false;
    if (name.startsWith('~')) {
      negated = true;
      name = name.slice(1);
    }
    if (IGNORED_OPTIONS.has(name) || /^_+$/.test(name)) continue;
    if (UNSUPPORTED_OPTIONS.has(name)) return { unsupported: name };
    if (TYPE_MAP[name]) {
      const t = TYPE_MAP[name];
      if (negated) (o.notTypes ||= new Set()).add(t);
      else (o.types ||= new Set()).add(t);
      continue;
    }
    switch (name) {
      case 'document':
      case 'doc':
        if (negated) return { unsupported: '~document' };
        o.document = true;
        break;
      case 'popup':
      case 'popunder':
        if (negated) return { unsupported: '~popup' };
        o.popup = true;
        break;
      case 'all':
        o.document = true;
        o.popup = true;
        o.types = new Set(ALL_SUBRESOURCE_TYPES);
        break;
      case 'third-party':
      case '3p':
      case 'strict3p':
        o.thirdParty = !negated;
        break;
      case 'first-party':
      case '1p':
      case 'strict1p':
        o.thirdParty = negated;
        break;
      case 'domain':
      case 'from': {
        if (!value) return { unsupported: 'domain' };
        const d = parseDomainList(value, '|');
        if (!d) return { unsupported: 'domain-regex' };
        if (d.include.length) addTo(o, 'initiatorDomains', d.include);
        if (d.exclude.length) addTo(o, 'excludedInitiatorDomains', d.exclude);
        break;
      }
      case 'to': {
        if (!value) return { unsupported: 'to' };
        const d = parseDomainList(value, '|');
        if (!d) return { unsupported: 'to-regex' };
        if (d.include.length) addTo(o, 'requestDomains', d.include);
        if (d.exclude.length) addTo(o, 'excludedRequestDomains', d.exclude);
        break;
      }
      case 'denyallow': {
        if (!value) return { unsupported: 'denyallow' };
        const d = parseDomainList(value, '|');
        if (!d || d.exclude.length) return { unsupported: 'denyallow' };
        addTo(o, 'excludedRequestDomains', d.include);
        break;
      }
      case 'method': {
        if (!value) return { unsupported: 'method' };
        for (let m of value.toLowerCase().split('|')) {
          const neg = m.startsWith('~');
          if (neg) m = m.slice(1);
          addTo(o, neg ? 'excludedMethods' : 'methods', [m]);
        }
        break;
      }
      case 'important':
        o.important = true;
        break;
      case 'match-case':
        o.matchCase = true;
        break;
      case 'badfilter':
        o.badfilter = true;
        break;
      case 'redirect':
        if (!value) return { unsupported: 'redirect' };
        o.redirect = value.replace(/:\d+$/, '');
        break;
      case 'rewrite':
        o.redirect = value && value.startsWith('abp-resource:') ? value.slice(13) : 'block';
        break;
      case 'empty':
        o.redirect = 'nooptext';
        break;
      case 'mp4':
        o.redirect = 'noopmp4';
        break;
      case 'removeparam':
      case 'queryprune':
        o.removeparam = value === null ? '' : value;
        break;
      case 'csp':
        o.csp = value === null ? '' : value;
        break;
      case 'inline-script':
        o.csp = "script-src 'unsafe-eval' * blob: data:";
        break;
      case 'inline-font':
        o.csp = 'font-src *';
        break;
      case 'elemhide':
      case 'ehide':
        o.elemhide = true;
        break;
      case 'generichide':
      case 'ghide':
        o.generichide = true;
        break;
      case 'specifichide':
      case 'shide':
        o.specifichide = true;
        break;
      default:
        return { unsupported: name };
    }
  }
  return o;
}

function parseNetwork(line, format) {
  let s = line;
  let exception = false;
  if (s.startsWith('@@')) {
    exception = true;
    s = s.slice(2);
  }
  let pattern = s;
  let options = emptyOptions();
  const dollar = findOptionsStart(s);
  if (dollar === -2) return { type: 'unsupported', reason: 'html-filter' };
  if (dollar >= 0) {
    pattern = s.slice(0, dollar);
    const parsed = parseNetworkOptions(s.slice(dollar + 1));
    if (parsed.unsupported) return { type: 'unsupported', reason: `option:${parsed.unsupported}` };
    options = parsed;
  } else if (s.includes('$') && !s.startsWith('/')) {
    return { type: 'unsupported', reason: 'unknown-option' };
  }

  const base = { type: 'network', exception, options, raw: line };

  // Regular expression
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return { ...base, kind: 'regex', regex: pattern.slice(1, -1) };
  }

  let p = options.matchCase ? pattern : pattern.toLowerCase();

  // ||hostname^  -> hostname filter
  const hm = /^\|\|([a-z0-9_.-]+?)\.?(\^\|?|\^\*|)$/.exec(p.toLowerCase());
  if (hm && isValidHostname(hm[1]) && !options.matchCase) {
    return { ...base, kind: 'hostname', hostname: hm[1] };
  }
  // Plain hostname in a domain list (not in adblock lists, where it is a substring)
  if (format === 'domains') {
    const h = normalizeHostname(p);
    if (isValidHostname(h)) return { ...base, kind: 'hostname', hostname: h };
    if (/^\*\.|\*/.test(p) && /^[a-z0-9*_.-]+$/.test(p)) return { ...base, kind: 'hostwildcard', pattern: p };
  }
  // ||ad*.example.com^ style host wildcards (AdGuard DNS)
  const wm = /^\|\|([a-z0-9_.*-]+)\^\|?$/.exec(p);
  if (wm && wm[1].includes('*')) return { ...base, kind: 'hostwildcard', pattern: wm[1] };

  // Generic URL pattern
  if (!p.startsWith('||') && !p.startsWith('|')) p = p.replace(/^\*+/, '');
  if (!p.endsWith('|')) p = p.replace(/\*+$/, '');
  if (p === '' || p === '*') return { ...base, kind: 'any', pattern: '' };
  if (/\s/.test(p)) return { type: 'unsupported', reason: 'whitespace' };
  return { ...base, kind: 'pattern', pattern: p };
}

// ----------------------------------------------------------------------------
// Cosmetic filters

const COSMETIC_RE = /^([^\s"!|\/\\]*?)#(@?)(\$\?|\?|\$|%)?#(.*)$/;

// Procedural operators (uBO, AdGuard ExtCSS, ABP).
export const PROCEDURAL_OPS = [
  'has-text', 'contains', '-abp-contains', 'upward', 'nth-ancestor', 'xpath', 'matches-css',
  'matches-css-before', 'matches-css-after', 'min-text-length', 'matches-attr', 'matches-path',
  'watch-attr', 'remove', 'style', 'remove-attr', 'remove-class', '-abp-has', 'if', 'if-not',
  'others', 'matches-media', 'matches-prop', '-abp-properties',
];
const PROCEDURAL_RE = new RegExp(`:(?:${PROCEDURAL_OPS.map((o) => o.replace(/[-]/g, '\\-')).join('|')})\\(`);

export function isProceduralSelector(sel) {
  if (PROCEDURAL_RE.test(sel)) return true;
  // :has()/:not() containing procedural syntax are handled by the procedural engine too
  return false;
}

// Canonical scriptlet names and their aliases (uBO short names + AdGuard names).
const SCRIPTLET_ALIASES = {
  aopr: ['abort-on-property-read', 'aopr'],
  aopw: ['abort-on-property-write', 'aopw'],
  acs: ['abort-current-script', 'acs', 'abort-current-inline-script', 'acis'],
  aost: ['abort-on-stack-trace', 'aost'],
  set: ['set-constant', 'set', 'trusted-set-constant', 'trusted-set'],
  aeld: ['addeventlistener-defuser', 'aeld', 'prevent-addeventlistener'],
  nostif: ['no-settimeout-if', 'nostif', 'settimeout-defuser', 'std', 'prevent-settimeout'],
  nosiif: ['no-setinterval-if', 'nosiif', 'setinterval-defuser', 'sid', 'prevent-setinterval'],
  'nano-stb': ['adjust-settimeout', 'nano-settimeout-booster', 'nano-stb'],
  'nano-sib': ['adjust-setinterval', 'nano-setinterval-booster', 'nano-sib'],
  nowoif: ['no-window-open-if', 'nowoif', 'window.open-defuser', 'prevent-window-open'],
  ra: ['remove-attr', 'ra'],
  rc: ['remove-class', 'rc'],
  rmnt: ['remove-node-text', 'rmnt'],
  rpnt: ['replace-node-text', 'rpnt', 'trusted-replace-node-text', 'trusted-rpnt'],
  'set-attr': ['set-attr', 'trusted-set-attr'],
  'no-fetch-if': ['no-fetch-if', 'prevent-fetch'],
  'no-xhr-if': ['no-xhr-if', 'prevent-xhr'],
  'json-prune': ['json-prune'],
  nowebrtc: ['nowebrtc'],
  noeval: ['noeval', 'silent-noeval'],
  'noeval-if': ['noeval-if', 'prevent-eval-if'],
  nobab: ['nobab', 'bab-defuser', 'prevent-bab'],
  nofab: ['nofab', 'fuckadblock.js-3.2.0', 'prevent-fab-3.2.0'],
  'popads-dummy': ['popads-dummy', 'popads.net'],
  'set-cookie': ['set-cookie', 'trusted-set-cookie'],
  'set-cookie-reload': ['set-cookie-reload', 'trusted-set-cookie-reload'],
  'cookie-remover': ['cookie-remover', 'remove-cookie'],
  'set-local-storage-item': ['set-local-storage-item', 'trusted-set-local-storage-item'],
  'set-session-storage-item': ['set-session-storage-item', 'trusted-set-session-storage-item'],
  'click-element': ['trusted-click-element'],
  'href-sanitizer': ['href-sanitizer'],
  'close-window': ['close-window', 'window-close-if'],
  'disable-newtab-links': ['disable-newtab-links'],
  'prevent-refresh': ['prevent-refresh', 'refresh-defuser'],
  'prevent-dialog': ['prevent-dialog'],
};
const SCRIPTLET_NAME = new Map();
for (const [canon, aliases] of Object.entries(SCRIPTLET_ALIASES)) {
  for (const a of aliases) SCRIPTLET_NAME.set(a, canon);
}
export const KNOWN_SCRIPTLETS = Object.keys(SCRIPTLET_ALIASES);

export function canonicalScriptletName(name) {
  const n = String(name).trim().toLowerCase().replace(/\.js$/, '');
  return SCRIPTLET_NAME.get(n) || n;
}

// Splits scriptlet arguments: commas separate, "\," escapes, quoted args allowed.
export function splitScriptletArgs(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i <= n) {
    while (i < n && text[i] === ' ') i++;
    const q = text[i];
    let arg = '';
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\' && text[j + 1] === q) {
          arg += q;
          j += 2;
          continue;
        }
        if (text[j] === q) break;
        arg += text[j++];
      }
      i = j + 1;
      while (i < n && text[i] !== ',') i++;
    } else {
      let j = i;
      while (j < n && !(text[j] === ',' && text[j - 1] !== '\\')) j++;
      arg = text.slice(i, j).trim().replace(/\\,/g, ',');
      i = j;
    }
    out.push(arg);
    if (i >= n) break;
    i++; // skip comma
  }
  return out;
}

function parseCosmetic(m, line) {
  const [, domainText, at, flavor = '', body] = m;
  const exception = at === '@';
  const domains = parseDomainList(domainText, ',');
  if (!domains) return { type: 'unsupported', reason: 'cosmetic-domains' };
  const base = { exception, domains, raw: line };
  const b = body.trim();
  if (!b) return { type: 'unsupported', reason: 'empty-cosmetic' };

  // uBO scriptlet:  ##+js(name, args...)
  if (flavor === '' && b.startsWith('+js(')) {
    if (!b.endsWith(')')) return { type: 'unsupported', reason: 'scriptlet-syntax' };
    const inner = b.slice(4, -1);
    if (inner.trim() === '') return { ...base, type: 'scriptlet', name: '', args: [] };
    const [name, ...args] = splitScriptletArgs(inner);
    return { ...base, type: 'scriptlet', name: canonicalScriptletName(name), args };
  }
  // AdGuard scriptlet:  #%#//scriptlet('name', 'arg')
  if (flavor === '%') {
    const sm = /^\/\/scriptlet\((.*)\)$/.exec(b);
    if (!sm) return { type: 'unsupported', reason: 'adguard-js' };
    const [name, ...args] = splitScriptletArgs(sm[1]);
    return { ...base, type: 'scriptlet', name: canonicalScriptletName(name), args };
  }
  // HTML filtering (uBO ##^)
  if (b.startsWith('^')) return { type: 'unsupported', reason: 'html-filter' };

  // AdGuard CSS injection:  #$#selector { declarations }
  if (flavor === '$' || flavor === '$?') {
    const cm = /^(.+?)\s*\{([^{}]*)\}$/.exec(b);
    if (!cm) return { type: 'unsupported', reason: 'abp-snippet' };
    const decl = cm[2].trim();
    if (/^remove\s*:\s*true\s*;?$/.test(decl)) {
      return { ...base, type: 'cosmetic', selector: normalizeExtended(cm[1]), action: { type: 'remove' } };
    }
    if (/url\s*\(|expression\s*\(|@import/i.test(decl)) return { type: 'unsupported', reason: 'unsafe-style' };
    return { ...base, type: 'cosmetic', selector: normalizeExtended(cm[1]), action: { type: 'style', style: decl } };
  }

  let selector = flavor === '?' ? normalizeExtended(b) : b;
  let action = { type: 'hide' };

  // ABP-style CSS injection under ##:  selector { declarations }
  const sm = /^(.+?)\s*\{([^{}]*)\}$/.exec(selector);
  if (sm) {
    if (/url\s*\(|expression\s*\(|@import/i.test(sm[2])) return { type: 'unsupported', reason: 'unsafe-style' };
    return { ...base, type: 'cosmetic', selector: sm[1].trim(), action: { type: 'style', style: sm[2].trim() } };
  }

  // Trailing action operators (uBO): :style(...), :remove(), :remove-attr(...), :remove-class(...)
  const am = /:(style|remove|remove-attr|remove-class)\(((?:[^()]|\([^()]*\))*)\)$/.exec(selector);
  if (am) {
    selector = selector.slice(0, am.index);
    if (am[1] === 'style') {
      if (/url\s*\(|expression\s*\(|@import/i.test(am[2])) return { type: 'unsupported', reason: 'unsafe-style' };
      action = { type: 'style', style: am[2].trim() };
    } else if (am[1] === 'remove') {
      action = { type: 'remove' };
    } else {
      action = { type: am[1], value: am[2].trim().replace(/^(['"])(.*)\1$/, '$2') };
    }
    if (!selector) return { type: 'unsupported', reason: 'empty-selector' };
  }
  if (/[{}]/.test(selector)) return { type: 'unsupported', reason: 'braces' };
  return { ...base, type: 'cosmetic', selector, action };
}

// ABP/AdGuard extended CSS -> uBO procedural syntax
function normalizeExtended(sel) {
  return sel
    .replace(/:-abp-has\(/g, ':has(')
    .replace(/:-abp-contains\(/g, ':has-text(')
    .replace(/:contains\(/g, ':has-text(')
    .replace(/\[-ext-has=(["'])(.*?)\1\]/g, ':has($2)')
    .replace(/\[-ext-contains=(["'])(.*?)\1\]/g, ':has-text($2)')
    .trim();
}

// ----------------------------------------------------------------------------
// Entry points

const HOSTS_LINE_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::0|::)\s+(.+)$/;

export function parseFilter(rawLine, format = 'adblock') {
  const line = rawLine.trim();
  if (!line) return { type: 'skip' };
  const c0 = line[0];
  if (c0 === '!' || (c0 === '[' && line.endsWith(']') && !line.includes('$'))) return { type: 'skip' };

  if (format === 'hosts' || HOSTS_LINE_RE.test(line)) {
    const hm = HOSTS_LINE_RE.exec(line);
    if (hm) {
      const host = normalizeHostname(hm[1].split('#')[0].trim().split(/\s+/)[0]);
      if (HOSTS_IGNORE.has(host) || !isValidHostname(host)) return { type: 'skip' };
      return { type: 'network', exception: false, kind: 'hostname', hostname: host, options: emptyOptions(), raw: line };
    }
    if (c0 === '#') return { type: 'skip' };
    if (format === 'hosts' && /^[0-9a-f:.%a-z]+\s+\S/i.test(line) && /^[0-9a-f]*[:.]/i.test(line)) return { type: 'skip' };
  }

  // Cosmetic / scriptlet
  if (line.includes('#')) {
    const m = COSMETIC_RE.exec(line);
    if (m) return parseCosmetic(m, line);
    if (c0 === '#') return { type: 'skip' }; // hosts-style comment
  }

  // Domain-list lines may carry trailing comments
  if (format === 'domains') {
    const d = line.split(/\s+#/)[0].trim();
    if (!d.includes('$') && !d.includes('/') && !d.startsWith('|') && !d.startsWith('@@')) {
      return parseNetwork(d, 'domains');
    }
  }
  return parseNetwork(line, format);
}

// For a $badfilter rule, the raw text of the filter it cancels.
export function badfilterTarget(raw) {
  return raw
    .replace(/([$,])badfilter(?=,|$)/, '$1')
    .replace(/,,/g, ',')
    .replace(/[$,]$/, '')
    .replace(/\$,/, '$');
}

// Guesses the list format from its first non-comment lines.
export function detectFormat(text) {
  let hosts = 0;
  let domains = 0;
  let adblock = 0;
  let seen = 0;
  const lines = text.split(/\r?\n/, 2000);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) {
      if (line.startsWith('[Adblock') || line.startsWith('[uBlock') || line.startsWith('[AdGuard')) adblock += 100;
      continue;
    }
    seen++;
    if (HOSTS_LINE_RE.test(line)) hosts++;
    else if (/^(?:\*\.)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i.test(line)) domains++;
    else adblock++;
    if (seen >= 300) break;
  }
  if (hosts > domains && hosts > adblock) return 'hosts';
  if (domains > adblock) return 'domains';
  return 'adblock';
}

// Parses a whole list. Calls onFilter(parsed) for each usable filter and returns stats.
export function parseFilterList(text, onFilter, format = detectFormat(text)) {
  const stats = { lines: 0, network: 0, cosmetic: 0, scriptlet: 0, unsupported: 0, reasons: {} };
  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    const line = text.slice(start, end);
    start = end + 1;
    stats.lines++;
    const f = parseFilter(line, format);
    if (f.type === 'skip') continue;
    if (f.type === 'unsupported') {
      stats.unsupported++;
      stats.reasons[f.reason] = (stats.reasons[f.reason] || 0) + 1;
      continue;
    }
    stats[f.type]++;
    onFilter(f);
  }
  stats.format = format;
  return stats;
}
