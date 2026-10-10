// Compiles cosmetic (element hiding / procedural / style) and scriptlet filters.
//
// Output (all levels kept, consumers filter by the active level):
//   generic.simple   { ".ad-box": level }            selector === key, injected when key seen in DOM
//   generic.keyed    { ".ad": [[selector, level]] }  injected when key seen in DOM
//   generic.unkeyed  [[selector, level]]              injected on every page
//   specific         { "host": { hide, unhide, style, procedural, generichide, elemhide, specifichide } }
//   scriptlets       { name: { "host" | "*": [[args, level]] } }

import { isProceduralSelector } from './parser.js';
import { compileProcedural } from './procedural.js';

// Specific cosmetic data is split into shards so the extension only loads the
// few shards relevant to the hostname being visited.
export const SHARD_COUNT = 64;

export function shardFor(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SHARD_COUNT;
}

// Extracts a class/id token that must exist in the DOM for `sel` to match.
// Tokens inside :not()/:is()/:where()/attribute brackets are not necessary
// conditions, so parenthesised and bracketed parts are skipped.
export function selectorKey(sel) {
  let depth = 0;
  let bracket = 0;
  let best = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '\\') return null; // escaped selectors: keep unkeyed
    if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0 && bracket === 0) return null; // selector list
    else if ((c === '.' || c === '#') && depth === 0 && bracket === 0) {
      const m = /^[.#](-?[_a-zA-Z][_a-zA-Z0-9-]*)/.exec(sel.slice(i));
      if (m) {
        const token = c + m[1];
        if (!best || token.length > best.length) best = token;
        i += m[0].length - 1;
      }
    }
  }
  return best;
}

const SIMPLE_RE = /^[.#]-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

// Cheap sanity check for selectors injected as CSS (no DOM available at build time).
export function looksLikeValidCss(sel) {
  if (!sel || sel.length > 2000) return false;
  if (/[{}]|^\s*[>+~]|:-abp-|:contains\(|\/\*/.test(sel)) return false;
  let depth = 0;
  let bracket = 0;
  for (const c of sel) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    if (depth < 0 || bracket < 0) return false;
  }
  return depth === 0 && bracket === 0;
}

export class CosmeticCompiler {
  constructor({ knownScriptlets = null } = {}) {
    this.knownScriptlets = knownScriptlets ? new Set(knownScriptlets) : null;
    this.genericHide = new Map(); // selector -> level
    this.genericExceptions = new Set();
    this.specific = new Map(); // host -> entry
    this.scriptlets = new Map(); // name -> Map(host -> [[args, level]])
    this.scriptletExceptions = new Map(); // host -> Set(signature | '*')
    this.stats = { generic: 0, specific: 0, procedural: 0, style: 0, scriptlets: 0, dropped: 0, reasons: {} };
  }

  drop(reason) {
    this.stats.dropped++;
    this.stats.reasons[reason] = (this.stats.reasons[reason] || 0) + 1;
  }

  entry(host) {
    let e = this.specific.get(host);
    if (!e) {
      e = {};
      this.specific.set(host, e);
    }
    return e;
  }

  addFlag(host, flag, level) {
    const e = this.entry(host);
    if (e[flag] === undefined || level < e[flag]) e[flag] = level;
  }

  // Exceptions produced by the DNR compiler from @@...$generichide / $elemhide / $specifichide
  addNetworkExceptions(list) {
    for (const ex of list) {
      for (const d of ex.domains) {
        if (ex.generichide || ex.elemhide) this.addFlag(d, 'generichide', ex.level);
        if (ex.specifichide || ex.elemhide) this.addFlag(d, 'specifichide', ex.level);
      }
    }
  }

  add(f, level) {
    if (f.type === 'scriptlet') return this.addScriptlet(f, level);
    if (f.type !== 'cosmetic') return;
    const { include, exclude } = f.domains;
    const { selector, action } = f;

    if (f.exception) {
      if (!include.length) {
        if (action.type === 'hide') this.genericExceptions.add(selector);
        return;
      }
      for (const h of include) {
        const e = this.entry(h);
        (e.unhide ||= []).push(selector);
      }
      return;
    }

    const procedural = isProceduralSelector(selector);
    const simpleHide = action.type === 'hide' && !procedural;

    if (!include.length) {
      // Generic rule (possibly with ~domain exclusions)
      if (!simpleHide) return this.drop('generic-procedural');
      if (!looksLikeValidCss(selector)) return this.drop('invalid-css');
      const prev = this.genericHide.get(selector);
      if (prev === undefined || level < prev) this.genericHide.set(selector, level);
      for (const h of exclude) {
        const e = this.entry(h);
        (e.unhide ||= []).push(selector);
      }
      this.stats.generic++;
      return;
    }

    let compiled = null;
    if (procedural) {
      const steps = compileProcedural(selector);
      if (!steps) return this.drop('procedural-syntax');
      compiled = { steps, action };
    } else if (!looksLikeValidCss(selector)) {
      return this.drop('invalid-css');
    }

    for (const h of include) {
      const e = this.entry(h);
      if (compiled) {
        (e.procedural ||= []).push([compiled, level]);
        this.stats.procedural++;
      } else if (action.type === 'hide') {
        (e.hide ||= []).push([selector, level]);
        this.stats.specific++;
      } else if (action.type === 'style') {
        (e.style ||= []).push([selector, action.style, level]);
        this.stats.style++;
      } else {
        // remove / remove-attr / remove-class on plain selectors run in the content script
        (e.procedural ||= []).push([{ steps: [['css', selector]], action }, level]);
        this.stats.procedural++;
      }
    }
    // ~domain exclusions on domain-specific rules: treat as unhide for those hosts
    for (const h of exclude) {
      const e = this.entry(h);
      (e.unhide ||= []).push(selector);
    }
  }

  addScriptlet(f, level) {
    const sig = f.name ? JSON.stringify([f.name, ...f.args]) : '*';
    if (f.exception) {
      const hosts = f.domains.include.length ? f.domains.include : ['*'];
      for (const h of hosts) {
        if (!this.scriptletExceptions.has(h)) this.scriptletExceptions.set(h, new Set());
        this.scriptletExceptions.get(h).add(sig);
      }
      return;
    }
    if (!f.name) return this.drop('scriptlet-empty');
    if (this.knownScriptlets && !this.knownScriptlets.has(f.name)) return this.drop(`scriptlet:${f.name}`);
    const hosts = f.domains.include.length ? f.domains.include : ['*'];
    if (!this.scriptlets.has(f.name)) this.scriptlets.set(f.name, new Map());
    const map = this.scriptlets.get(f.name);
    for (const h of hosts) {
      if (!map.has(h)) map.set(h, []);
      const list = map.get(h);
      const key = JSON.stringify(f.args);
      const existing = list.find((x) => JSON.stringify(x[0]) === key);
      if (existing) existing[1] = Math.min(existing[1], level);
      else list.push([f.args, level]);
    }
    // Generic scriptlets with ~exclusions
    if (!f.domains.include.length) {
      for (const h of f.domains.exclude) {
        if (!this.scriptletExceptions.has(h)) this.scriptletExceptions.set(h, new Set());
        this.scriptletExceptions.get(h).add(sig);
      }
    }
    this.stats.scriptlets++;
  }

  finalize() {
    // Generic hiding index
    const simple = {};
    const keyed = {};
    const unkeyed = [];
    for (const [sel, level] of this.genericHide) {
      if (this.genericExceptions.has(sel)) continue;
      if (SIMPLE_RE.test(sel)) {
        simple[sel] = level;
        continue;
      }
      const key = selectorKey(sel);
      if (key) (keyed[key] ||= []).push([sel, level]);
      else unkeyed.push([sel, level]);
    }

    // Specific entries: dedupe and drop hides cancelled by unhide on the same host
    const specific = {};
    for (const [host, e] of this.specific) {
      const out = {};
      const unhide = new Set(e.unhide || []);
      if (e.hide) {
        const seen = new Map();
        for (const [s, l] of e.hide) if (!unhide.has(s) && (!seen.has(s) || l < seen.get(s))) seen.set(s, l);
        if (seen.size) out.hide = [...seen];
      }
      if (unhide.size) out.unhide = [...unhide];
      if (e.style) out.style = e.style;
      if (e.procedural) out.procedural = e.procedural;
      for (const flag of ['generichide', 'specifichide']) if (e[flag] !== undefined) out[flag] = e[flag];
      if (Object.keys(out).length) specific[host] = out;
    }

    // Scriptlets minus exceptions
    const scriptlets = {};
    const globalEx = this.scriptletExceptions.get('*');
    for (const [name, map] of this.scriptlets) {
      const out = {};
      for (const [host, list] of map) {
        const ex = this.scriptletExceptions.get(host);
        const kept = list.filter(([args]) => {
          const sig = JSON.stringify([name, ...args]);
          return !(ex && (ex.has('*') || ex.has(sig))) && !(globalEx && globalEx.has(sig));
        });
        if (kept.length) out[host] = kept;
      }
      if (Object.keys(out).length) scriptlets[name] = out;
    }
    // Hosts where a generic scriptlet must not run
    const scriptletExclusions = {};
    for (const [host, sigs] of this.scriptletExceptions) {
      if (host !== '*') scriptletExclusions[host] = [...sigs];
    }

    return {
      generic: { simple, keyed, unkeyed },
      specific,
      scriptlets,
      scriptletExclusions,
      stats: this.stats,
    };
  }
}
