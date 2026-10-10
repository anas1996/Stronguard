import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFilter, parseFilterList, detectFormat, splitScriptletArgs, badfilterTarget } from '../core/parser.js';
import { DomainMatcher, hostnameKeys, registrableDomain, expandEntity, isDnsUsable } from '../core/domains.js';
import { DnrCompiler, isRe2Compatible, PRIORITY, BLOCKED_PAGE } from '../core/dnr.js';
import { CosmeticCompiler, selectorKey, shardFor, SHARD_COUNT } from '../core/cosmetic.js';
import { compileProcedural } from '../core/procedural.js';
import { featuresFor, clampLevel, LEVELS } from '../core/levels.js';
import { listsFor, CATALOG } from '../core/catalog.js';

// ---------------------------------------------------------------------------
// Parser

test('parses hostname, pattern, regex and exception network filters', () => {
  const h = parseFilter('||ads.example.com^');
  assert.equal(h.type, 'network');
  assert.equal(h.kind, 'hostname');
  assert.equal(h.hostname, 'ads.example.com');

  const p = parseFilter('/banner/*/img^$image,third-party,domain=a.com|~b.a.com');
  assert.equal(p.kind, 'pattern');
  assert.deepEqual([...p.options.types], ['image']);
  assert.equal(p.options.thirdParty, true);
  assert.deepEqual(p.options.initiatorDomains, ['a.com']);
  assert.deepEqual(p.options.excludedInitiatorDomains, ['b.a.com']);

  const r = parseFilter('/^https?:\\/\\/[a-z]{8}\\.com\\/ads/$script');
  assert.equal(r.kind, 'regex');
  assert.equal(r.regex, '^https?:\\/\\/[a-z]{8}\\.com\\/ads');

  const e = parseFilter('@@||cdn.example.com^$document');
  assert.equal(e.exception, true);
  assert.equal(e.options.document, true);
});

test('parses popup/all/removeparam/redirect options and drops unsupported ones', () => {
  const all = parseFilter('||popads.net^$all');
  assert.ok(all.options.popup && all.options.document && all.options.types.size > 5);
  assert.equal(parseFilter('$removeparam=utm_source').options.removeparam, 'utm_source');
  assert.equal(parseFilter('||x.com/ads.js$script,redirect=noopjs:10').options.redirect, 'noopjs');
  assert.equal(parseFilter('||x.com^$replace=/a/b/').type, 'unsupported');
  assert.equal(parseFilter('example.com$$script[tag-content="ad"]').type, 'unsupported');
});

test('parses hosts files and plain domain lists', () => {
  assert.equal(detectFormat('# c\n0.0.0.0 a.com\n0.0.0.0 b.com\n'), 'hosts');
  assert.equal(detectFormat('a.com\nb.org\n*.c.net\n'), 'domains');
  const h = parseFilter('0.0.0.0 tracker.example.net # comment', 'hosts');
  assert.equal(h.hostname, 'tracker.example.net');
  assert.equal(parseFilter('127.0.0.1 localhost', 'hosts').type, 'skip');
  assert.equal(parseFilter('*.ads.example.org', 'domains').hostname, 'ads.example.org');
  // In adblock lists a bare "word.js" is a URL substring, not a hostname
  assert.equal(parseFilter('ads.js', 'adblock').kind, 'pattern');
});

test('parses cosmetic, procedural, style and scriptlet filters', () => {
  const c = parseFilter('example.com,~sub.example.com##.ad-box');
  assert.equal(c.type, 'cosmetic');
  assert.deepEqual(c.domains, { include: ['example.com'], exclude: ['sub.example.com'] });
  const s = parseFilter('example.com##body:style(overflow: auto !important)');
  assert.deepEqual(s.action, { type: 'style', style: 'overflow: auto !important' });
  const abp = parseFilter('site.com##.nav {top: 0}');
  assert.equal(abp.action.type, 'style');
  const ext = parseFilter('site.com#?#div:-abp-has(> .ad)');
  assert.equal(ext.selector, 'div:has(> .ad)');
  const js = parseFilter('example.com,example.*##+js(set, ads.enabled, false)');
  assert.equal(js.type, 'scriptlet');
  assert.equal(js.name, 'set');
  assert.deepEqual(js.args, ['ads.enabled', 'false']);
  const adg = parseFilter("example.org#%#//scriptlet('abort-on-property-read', 'detectAdblock')");
  assert.equal(adg.name, 'aopr');
  assert.deepEqual(adg.args, ['detectAdblock']);
  assert.equal(parseFilter('example.com##^script:has-text(ad)').type, 'unsupported');
});

test('scriptlet arguments honour escapes and quotes', () => {
  assert.deepEqual(splitScriptletArgs('a, b\\, c, "d, e", \'f\''), ['a', 'b, c', 'd, e', 'f']);
});

test('badfilter targets the original filter text', () => {
  assert.equal(badfilterTarget('||a.com^$script,badfilter,domain=x.com'), '||a.com^$script,domain=x.com');
});

test('parseFilterList reports stats', () => {
  const out = [];
  const st = parseFilterList('! comment\n||a.com^\n##.ad\nb.com##+js(nowebrtc)\n||x^$cname\n', (f) => out.push(f));
  assert.equal(st.network, 1);
  assert.equal(st.cosmetic, 1);
  assert.equal(st.scriptlet, 1);
  assert.equal(st.unsupported, 1);
});

// ---------------------------------------------------------------------------
// Domains

test('domain matcher: suffix matching, allow precedence, important, regex', () => {
  const m = new DomainMatcher();
  m.addBlock('doubleclick.net', 'l1');
  m.addAllow('good.doubleclick.net', 'l2');
  m.addBlock('evil.com', 'l3', true);
  m.addAllow('evil.com', 'l4');
  m.addWildcard('ad*.example.org');
  assert.equal(m.match('stats.g.doubleclick.net').blocked, true);
  assert.equal(m.match('good.doubleclick.net').blocked, false);
  assert.equal(m.match('evil.com').blocked, true, '$important beats allow');
  assert.equal(m.match('ads123.example.org').blocked, true);
  assert.equal(m.match('notdoubleclick.net').blocked, false);
});

test('hostname keys include parents and entity forms', () => {
  const keys = hostnameKeys('www.example.co.uk');
  for (const k of ['www.example.co.uk', 'example.co.uk', 'co.uk', 'example.*', 'www.example.*']) assert.ok(keys.includes(k), k);
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('x.example.com'), 'example.com');
  assert.ok(expandEntity('site.*').includes('site.to'));
});

test('only context-free filters are used at DNS level', () => {
  assert.equal(isDnsUsable(parseFilter('||ads.com^')), true);
  assert.equal(isDnsUsable(parseFilter('||ads.com^$important')), true);
  assert.equal(isDnsUsable(parseFilter('||pop.com^$all')), true);
  assert.equal(isDnsUsable(parseFilter('||cdn.com^$script')), false);
  assert.equal(isDnsUsable(parseFilter('||cdn.com^$domain=a.com')), false);
  assert.equal(isDnsUsable(parseFilter('||cdn.com^$third-party')), false);
  assert.equal(isDnsUsable(parseFilter('||cdn.com^$third-party'), { includeThirdParty: true }), true);
});

// ---------------------------------------------------------------------------
// DNR compiler

function compile(lines, level = 1, docLevel = null) {
  const c = new DnrCompiler();
  const fs = lines.map((l) => parseFilter(l));
  for (const f of fs) c.noteBadfilter(f);
  for (const f of fs) if (f.type === 'network') c.add(f, level, docLevel);
  return c.finalize({ builtins: false });
}

test('DNR: hostname rules merge into one requestDomains rule, subdomains pruned', () => {
  const { rulesets } = compile(['||a.com^', '||b.com^', '||x.a.com^', '||c.com^$third-party']);
  const rules = rulesets.net_l1;
  const merged = rules.find((r) => r.condition.requestDomains && !r.condition.domainType);
  assert.deepEqual(merged.condition.requestDomains, ['a.com', 'b.com']);
  assert.equal(merged.action.type, 'block');
  assert.ok(rules.some((r) => r.condition.domainType === 'thirdParty'));
});

test('DNR: exceptions, $document allowlisting, $important priorities', () => {
  const { rulesets } = compile(['@@||good.com^', '@@||site.com^$document', '||must.com^$important']);
  const r = rulesets.net_l1;
  assert.equal(r.find((x) => x.action.type === 'allow').priority, PRIORITY.allow);
  const all = r.find((x) => x.action.type === 'allowAllRequests');
  assert.deepEqual(all.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.equal(r.find((x) => x.condition.requestDomains && x.condition.requestDomains[0] === 'must.com').priority, PRIORITY.important);
});

test('DNR: popup/document rules redirect top-level pages to the blocked page', () => {
  const { rulesets } = compile(['||popads.net^$popup', '||malware.com^$doc'], 2);
  const doc = rulesets.doc_l2;
  assert.ok(doc.every((x) => x.action.type === 'redirect' && x.action.redirect.extensionPath === BLOCKED_PAGE));
  assert.ok(doc.every((x) => x.condition.resourceTypes[0] === 'main_frame'));
});

test('DNR: plain hostnames also become page blocks from their doc level', () => {
  const { rulesets } = compile(['||adserver.com^'], 1, 3);
  assert.ok(rulesets.net_l1);
  assert.deepEqual(rulesets.doc_l3[0].condition.requestDomains, ['adserver.com']);
});

test('DNR: removeparam, redirect resources, csp, badfilter', () => {
  const { rulesets } = compile([
    '$removeparam=utm_source',
    '@@||keep.com^$removeparam=utm_source',
    '||x.com/ads.js$script,redirect=noopjs',
    '||y.com^$csp=script-src none',
    '||z.com^',
    '||z.com^$badfilter',
  ]);
  const r = rulesets.net_l1;
  const rp = r.find((x) => x.action.redirect && x.action.redirect.transform);
  assert.deepEqual(rp.action.redirect.transform.queryTransform.removeParams, ['utm_source']);
  assert.deepEqual(rp.condition.excludedRequestDomains, ['keep.com']);
  assert.equal(r.find((x) => x.action.redirect && x.action.redirect.extensionPath).action.redirect.extensionPath, '/resources/noop.js');
  assert.equal(r.find((x) => x.action.type === 'modifyHeaders').action.responseHeaders[0].value, 'script-src none');
  assert.ok(!JSON.stringify(r).includes('z.com'), 'badfiltered rule must be gone');
});

test('DNR: RE2 compatibility check', () => {
  assert.equal(isRe2Compatible('^https?://[a-z]+\\.com/'), true);
  assert.equal(isRe2Compatible('(?=lookahead)'), false);
  assert.equal(isRe2Compatible('(a)\\1'), false);
});

// ---------------------------------------------------------------------------
// Cosmetic / procedural

test('cosmetic compiler builds generic index, specific map and scriptlet map', () => {
  const c = new CosmeticCompiler({ knownScriptlets: ['set'] });
  for (const l of ['##.ad-box', '##div.sponsor > .x', '##[id^="ad-"]', 'ex.com##.banner', 'ex.com#@#.ad-box',
    'ex.com##.post:has-text(Sponsored)', 'ex.com##+js(set, a, true)', 'ex.com##+js(unknownlet)', 'ex.com##body:style(overflow:auto)']) {
    const f = parseFilter(l);
    c.add(f, 1);
  }
  const out = c.finalize();
  assert.equal(out.generic.simple['.ad-box'], 1);
  assert.deepEqual(out.generic.keyed['.sponsor'], [['div.sponsor > .x', 1]]);
  assert.deepEqual(out.generic.unkeyed, [['[id^="ad-"]', 1]]);
  assert.deepEqual(out.specific['ex.com'].hide, [['.banner', 1]]);
  assert.deepEqual(out.specific['ex.com'].unhide, ['.ad-box']);
  assert.equal(out.specific['ex.com'].procedural.length, 1);
  assert.equal(out.specific['ex.com'].style[0][1], 'overflow:auto');
  assert.deepEqual(out.scriptlets.set['ex.com'], [[['a', 'true'], 1]]);
  assert.equal(out.stats.reasons['scriptlet:unknownlet'], 1);
});

test('selector keys ignore tokens inside :not() and attribute brackets', () => {
  assert.equal(selectorKey('div.ad-wrapper > span'), '.ad-wrapper');
  assert.equal(selectorKey('div:not(.x)'), null);
  assert.equal(selectorKey('a[href*=".com"]'), null);
  assert.equal(selectorKey('.a, .b'), null);
});

test('procedural selectors compile to step lists', () => {
  assert.deepEqual(compileProcedural('div.post:has-text(/sponsored/i):upward(2)'), [['css', 'div.post'], ['has-text', '/sponsored/i'], ['upward', 2]]);
  assert.deepEqual(compileProcedural('.card:has(> .label:has-text(Ad)) .body'), [
    ['css', '.card'], ['has', [['rel', '> .label'], ['has-text', 'Ad']]], ['rel', '.body'],
  ]);
  assert.deepEqual(compileProcedural(':xpath(//div[@ad])'), [['xpath', '//div[@ad]']]);
  assert.deepEqual(compileProcedural('div:not(.x):matches-css(position: fixed)'), [['css', 'div:not(.x)'], ['matches-css', 'position: fixed']]);
  assert.equal(compileProcedural('div:has-text('), null);
});

test('shards are stable and in range', () => {
  const s = shardFor('example.com');
  assert.equal(s, shardFor('example.com'));
  assert.ok(s >= 0 && s < SHARD_COUNT);
});

// ---------------------------------------------------------------------------
// Levels and catalog

test('levels are cumulative and clamp', () => {
  assert.equal(LEVELS.length, 5);
  assert.equal(clampLevel(9), 5);
  assert.equal(clampLevel('x'), 3);
  const keys = Object.keys(featuresFor(1)).filter((k) => typeof featuresFor(1)[k] === 'boolean');
  for (let l = 1; l < 5; l++) {
    for (const k of keys) if (featuresFor(l)[k]) assert.ok(featuresFor(l + 1)[k], `${k} lost at level ${l + 1}`);
  }
  assert.equal(featuresFor(3).overlayKiller, true);
  assert.equal(featuresFor(2).overlayKiller, false);
});

test('catalog: superseded DNS lists are skipped, every list has a source', () => {
  const ids = listsFor('dns', 5).map((l) => l.id);
  assert.ok(ids.includes('hagezi-ultimate'));
  assert.ok(!ids.includes('hagezi-pro') && !ids.includes('hagezi-pro-plus'));
  for (const e of CATALOG) assert.ok(e.builtin || (e.urls && e.urls.length), e.id);
});
