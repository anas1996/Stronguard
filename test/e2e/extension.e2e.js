#!/usr/bin/env node
// End-to-end test of the built Chrome extension in a real Chromium.
//
//   npm run build && npm run test:e2e
//
// Every hostname is routed (via --proxy-server) to a local fake web server, so
// tests can visit "news.test", "exoclick.com", etc. without internet access.

import http from 'node:http';
import https from 'node:https';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'dist', 'chrome');

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}
const { chromium } = loadPlaywright();

// ---------------------------------------------------------------------------
// Fake internet

const PAGES = {
  'news.test/': `<!doctype html><html><head><title>News</title>
    <script src="http://news.test/app.js"></script>
    <script src="http://exoclick.com/ads.js"></script>
    <script src="http://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
    </head><body>
    <h1>Real news</h1>
    <ins class="adsbygoogle" id="ins1" style="display:block;width:300px;height:250px">ad</ins>
    <div id="div-gpt-ad-123" style="width:300px;height:250px">gpt</div>
    <div class="ad-banner" id="banner">banner</div>
    <div class="promo-box" id="promo">promo</div>
    <div class="card" id="sponsored">Sponsored: buy now</div>
    <div class="card" id="normal">Normal article</div>
    <img src="http://adsterra.com/banner.png" id="adimg">
    <button id="btn" onclick="window.__w = window.open('http://other.test/page')">Open</button>
    <div id="plain" style="height:40px" onclick="window.__w2 = window.open('http://other.test/hijack')">plain div</div>
    <button id="pop" onclick="window.open('http://popads.net/landing')">popnet</button>
    <script>window.addEventListener('load', () => { const w = window.open('http://other.test/auto'); window.__autoFake = !(w instanceof Window); });</script>
    </body></html>`,
  'wall.test/': `<!doctype html><html><body style="overflow:hidden"><p>Article text that is long enough. ${'Lorem ipsum dolor sit amet. '.repeat(80)}</p>
    <script>setTimeout(() => {
      const d = document.createElement('div');
      d.id = 'wall';
      d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);color:#fff';
      d.innerHTML = '<h2>Adblock detected</h2><p>Please disable your ad blocker to continue.</p>';
      document.body.appendChild(d);
      document.body.style.overflow = 'hidden';
      window.__wallShown = true;
    }, 200);</script></body></html>`,
  'hijack.test/': `<!doctype html><html><body><p>video page</p>
    <a id="layer" href="http://adsterra.com/go" target="_blank" style="position:fixed;inset:0;opacity:0;z-index:2147483647"></a>
    </body></html>`,
  // Mimics YouTube: player responses with ad slots, a Shorts sequence with an ad
  // entry, a feed ad slot, and an ad that starts playing in the main <video>.
  'www.youtube.com/watch': `<!doctype html><html><body>
    <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video>
      <button class="ytp-skip-ad-button" onclick="window.__skipped = (window.__skipped || 0) + 1">Skip</button></div>
    <ytd-ad-slot-renderer id="feedad" style="display:block">feed ad</ytd-ad-slot-renderer>
    <script>
      window.__r = {};
      fetch('/youtubei/v1/player?key=f', { method: 'POST', body: '{}' }).then((r) => r.text()).then((t) => (window.__r.fetch = t));
      const x = new XMLHttpRequest();
      x.open('POST', '/youtubei/v1/player?key=x');
      x.onload = () => (window.__r.xhr = x.responseText);
      x.send('{}');
      fetch('/youtubei/v1/reel/reel_watch_sequence?key=s').then((r) => r.json()).then((j) => (window.__r.shorts = j));
    </script></body></html>`,
  // Mimics the Spotify web player: a detached <audio> element and the tab title.
  'open.spotify.com/': `<!doctype html><html><head><title>Song • Artist</title></head><body><div id="root">player</div>
    <script>window.__audio = document.createElement('audio'); window.__audio.play().catch(() => {});</script></body></html>`,
  // Generic sites: a Video.js-style player in ad mode, a long video beside an ad label,
  // a long clip under a strong ad signal, the IMA SDK, a VAST request and HLS playlists.
  'videojs.test/': `<!doctype html><html><body>
    <div class="video-js vjs-ad-playing" id="player"><video id="adv" src="/ad30.wav" preload="auto"></video>
      <video id="content" src="/clip90.wav" preload="auto"></video>
      <button class="vjs-skip" onclick="window.__skipped = (window.__skipped || 0) + 1">Skip Ad</button></div>
    <script>document.getElementById('adv').play();</script></body></html>`,
  'labels.test/': `<!doctype html><html><body>
    <div id="wrap"><video id="cv" src="/content300.wav" preload="auto"></video><div>Ad 1 of 2 · 0:15</div></div>
    <script>document.getElementById('cv').play();</script></body></html>`,
  'containers.test/': `<!doctype html><html><body>
    <div id="head-container"><video id="hero" src="/ad30.wav" preload="auto" loop></video></div>
    <div id="threadContainer"><video id="clip" src="/clip90.wav" preload="auto"></video></div>
    <div id="video-ad-container"><video id="ad" src="/ad30.wav" preload="auto"></video></div>
    <script>for (const id of ['hero', 'clip', 'ad']) document.getElementById(id).play();</script></body></html>`,
  'longad.test/': `<!doctype html><html><body>
    <div class="jw-flag-ads"><video id="lv" src="/content300.wav" preload="auto"></video></div>
    <script>document.getElementById('lv').play();</script></body></html>`,
  'ima.test/': `<!doctype html><html><body>
    <script src="https://imasdk.googleapis.com/js/sdkloader/ima3.js"></script>
    <script>
      window.__r = {};
      const loader = new google.ima.AdsLoader(new google.ima.AdDisplayContainer(document.body));
      loader.addEventListener(google.ima.AdErrorEvent.Type.AD_ERROR, (e) => (window.__r.ima = 'error:' + e.getError().getErrorCode()));
      loader.addEventListener(google.ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, () => (window.__r.ima = 'ads'));
      const req = new google.ima.AdsRequest();
      req.adTagUrl = 'https://pubads.g.doubleclick.net/gampad/ads?iu=/1/video&output=vast';
      loader.requestAds(req);
      const x = new XMLHttpRequest();
      x.open('GET', 'https://pubads.g.doubleclick.net/gampad/ads?iu=/1/video&output=vast&sz=640x480');
      x.onload = () => (window.__r.vast = x.responseText);
      x.onerror = () => (window.__r.vast = 'network-error');
      x.send();
    </script></body></html>`,
  'hls.test/': `<!doctype html><html><body><script>
      window.__r = {};
      fetch('/vod.m3u8').then((r) => r.text()).then((t) => (window.__r.vodFetch = t));
      const x = new XMLHttpRequest();
      x.open('GET', '/media/vod2.m3u8');
      x.onload = () => (window.__r.vodXhr = x.responseText);
      x.send();
      fetch('/live.m3u8').then((r) => r.text()).then((t) => (window.__r.live = t));
    </script></body></html>`,
  'tabunder.test/': `<!doctype html><html><body><button id="go" onclick="
      window.open(location.href, '_blank');
      setTimeout(() => { location.href = 'http://lander.test/'; }, 30);
    ">watch</button></body></html>`,
};

const PLAYER_RESPONSE = JSON.stringify({
  responseContext: {},
  playabilityStatus: { status: 'OK' },
  adPlacements: [{ adPlacementRenderer: { config: { kind: 'AD_PLACEMENT_KIND_START' } } }],
  playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
  adSlots: [{ adSlotRenderer: {} }],
  videoDetails: { videoId: 'abc' },
});
const SHORTS_RESPONSE = JSON.stringify({
  entries: [
    { command: { reelWatchEndpoint: { videoId: 'v1' } } },
    { command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } },
    { command: { reelWatchEndpoint: { videoId: 'v2' } } },
  ],
});

// Silent 8 kHz mono WAV of the given length: real media with a real duration.
function wav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  return b;
}
const MEDIA = { '/ad30.wav': wav(30), '/clip90.wav': wav(90), '/content300.wav': wav(300) };

const HLS_VOD = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXTINF:6.0,', 'content1.ts',
  '#EXT-X-CUE-OUT:DURATION=6', '#EXT-X-DISCONTINUITY', '#EXTINF:6.0,', 'ad-segment.ts', '#EXT-X-CUE-IN', '#EXT-X-DISCONTINUITY',
  '#EXTINF:6.0,', 'content2.ts', '#EXT-X-ENDLIST', ''].join('\n');
const HLS_LIVE = HLS_VOD.replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '').replace('#EXT-X-ENDLIST\n', '') +
  '#EXT-X-DATERANGE:ID="i1",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:00Z",X-ASSET-URI="https://ads.example/ad.m3u8"\n';

const hits = [];
function startServer() {
  const handler = (req, res) => {
    let url;
    try {
      url = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    hits.push(url.href);
    const key = `${url.hostname}${url.pathname}`;
    if (MEDIA[url.pathname]) {
      const body = MEDIA[url.pathname];
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : body.length - 1;
        res.writeHead(206, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
        res.end(body.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': body.length }).end(body);
      }
      return;
    }
    if (url.pathname.endsWith('.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(url.pathname.includes('live') ? HLS_LIVE : HLS_VOD);
      return;
    }
    if (url.pathname.startsWith('/gampad/ads')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end('<VAST version="4.0"><Ad id="real-ad"/></VAST>');
      return;
    }
    if (url.pathname.startsWith('/youtubei/v1/player')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(PLAYER_RESPONSE);
    } else if (url.pathname.startsWith('/youtubei/v1/reel/reel_watch_sequence')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(SHORTS_RESPONSE);
    } else if (PAGES[key]) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGES[key]);
    } else if (url.pathname.endsWith('.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(`window.__scripts = (window.__scripts || []).concat(${JSON.stringify(url.href)});`);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>${url.hostname}</title><p>${url.href}</p>`);
    }
  };
  const server = http.createServer(handler);
  // HTTPS: terminate TLS for every host with a test-only certificate
  // (Chromium runs with ignoreHTTPSErrors). Needed for HSTS-preloaded sites.
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const tls = https.createServer(
    { key: fsSync.readFileSync(path.join(fixtures, 'test-key.pem')), cert: fsSync.readFileSync(path.join(fixtures, 'test-cert.pem')) },
    (req, res) => {
      req.url = `https://${req.headers.host}${req.url}`;
      handler(req, res);
    },
  );
  server.on('connect', (req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tls.emit('connection', socket);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 5000, step = 100) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await sleep(step);
  }
  return last;
}

async function main() {
  await fs.access(path.join(EXT, 'manifest.json')).catch(() => {
    throw new Error('dist/chrome missing: run "npm run build" first');
  });
  const server = await startServer();
  const port = server.address().port;
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--proxy-server=http://127.0.0.1:${port}`,
      '--proxy-bypass-list=<-loopback>',
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log(`Extension loaded: ${extId}`);

    // Wait until extension APIs are bound and the background applied the default level.
    const ready = await until(() => sw.evaluate(async () => !!(chrome.scripting && (await chrome.scripting.getRegisteredContentScripts()).length > 2)), 20000, 250);
    assert.ok(ready, 'background did not register content scripts');

    const ui = await context.newPage();
    await ui.goto(`chrome-extension://${extId}/ui/popup.html`);
    const send = (msg) => ui.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const setLevel = (level) => send({ t: 'ui:setLevel', level });

    const blockedRequests = (page) => {
      const list = [];
      page.on('requestfailed', (r) => {
        if ((r.failure() || {}).errorText === 'net::ERR_BLOCKED_BY_CLIENT') list.push(r.url());
      });
      return list;
    };

    console.log('\nLevel 3 (default)');

    await test('static rulesets for level 3 are enabled', async () => {
      const ids = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
      for (const id of ['net_l1', 'net_l2', 'net_l3', 'doc_l1', 'doc_l3']) assert.ok(ids.includes(id), `${id} missing: ${ids}`);
      assert.ok(!ids.includes('net_l4') && !ids.includes('frames_l5'), `unexpected: ${ids}`);
    });

    await test('page scripts registered (isolated, guard, scriptlets)', async () => {
      const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
      const ids = scripts.map((s) => s.id);
      assert.ok(ids.includes('sg-isolated') && ids.includes('sg-guard'), ids.join(','));
      assert.ok(ids.some((i) => i.startsWith('sg-s-aopr-L1')), 'aopr bundle missing');
      assert.ok(!ids.some((i) => i.endsWith('-L4')), 'level 4 bundles should be off');
    });

    const page = await context.newPage();
    const blocked = blockedRequests(page);
    await page.goto('http://news.test/');
    await page.waitForLoadState('load');
    await sleep(800);

    await test('ad/popup-network requests are blocked, first-party script loads', async () => {
      assert.ok(blocked.some((u) => u.includes('exoclick.com')), `blocked: ${blocked}`);
      assert.ok(blocked.some((u) => u.includes('adsterra.com')), `blocked: ${blocked}`);
      assert.ok(blocked.some((u) => u.includes('googlesyndication.com')), `blocked: ${blocked}`);
      const scripts = await page.evaluate(() => window.__scripts || []);
      assert.ok(scripts.some((s) => s.includes('news.test/app.js')), `scripts: ${scripts}`);
      assert.ok(!hits.some((h) => h.includes('exoclick.com')), 'exoclick reached the network');
    });

    const displayOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).display, sel);

    await test('generic cosmetic filters hide ad containers', async () => {
      const ok = await until(async () => (await displayOf('#ins1')) === 'none' && (await displayOf('#div-gpt-ad-123')) === 'none' && (await displayOf('#banner')) === 'none');
      assert.ok(ok, `ins=${await displayOf('#ins1')} gpt=${await displayOf('#div-gpt-ad-123')} banner=${await displayOf('#banner')}`);
      assert.equal(await displayOf('#normal'), 'block');
    });

    await test('window.open without a user gesture is blocked', async () => {
      // (page.evaluate would carry a synthetic user gesture, so the page opens it on load)
      assert.equal(await page.evaluate(() => window.__autoFake), true, 'expected a fake window object');
      assert.ok(!hits.some((h) => h.includes('other.test/auto')), 'popup reached the network');
      assert.ok(!context.pages().some((p) => p.url().includes('other.test/auto')), 'popup tab opened');
    });

    await test('window.open from a real button click is allowed', async () => {
      const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }), page.click('#btn')]);
      await popup.waitForLoadState().catch(() => {});
      assert.ok(popup.url().includes('other.test'), popup.url());
      await popup.close();
    });

    await test('popup to a popup network is redirected and its tab auto-closed', async () => {
      const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }), page.click('#pop')]);
      const closed = await until(() => popup.isClosed(), 6000);
      assert.ok(closed, `popup still open at ${popup.url()}`);
      assert.ok(!hits.some((h) => h.includes('popads.net')), 'popads.net reached the network');
    });

    await test('scriptlet aopr runs on bild.de (SmartAdServerASMI throws)', async () => {
      const p = await context.newPage();
      await p.goto('http://bild.de/');
      const r = await p.evaluate(() => {
        try {
          void window.SmartAdServerASMI;
          return 'no-throw';
        } catch (e) {
          return 'threw';
        }
      });
      await p.close();
      assert.equal(r, 'threw');
    });

    await test('notification prompts are denied', async () => {
      const r = await page.evaluate(() => Notification.requestPermission());
      assert.equal(r, 'denied');
    });

    await test('anti-adblock overlay removed and scrolling restored', async () => {
      const p = await context.newPage();
      await p.goto('http://wall.test/');
      const gone = await until(() => p.evaluate(() => window.__wallShown === true && !document.getElementById('wall')), 8000, 200);
      await sleep(300);
      const overflow = await p.evaluate(() => getComputedStyle(document.body).overflowY);
      const style = await p.evaluate(() => document.body.getAttribute('style'));
      await p.close();
      assert.ok(gone, 'overlay still present');
      assert.notEqual(overflow, 'hidden', `body style: ${style}`);
    });

    await test('invisible click-hijacking link layer removed', async () => {
      const p = await context.newPage();
      await p.goto('http://hijack.test/');
      const gone = await until(() => p.evaluate(() => !document.getElementById('layer')), 6000, 200);
      await p.close();
      assert.ok(gone, 'layer still present');
    });

    await test('tracking parameters stripped from navigations', async () => {
      const p = await context.newPage();
      await p.goto('http://news.test/?utm_source=newsletter&fbclid=abc&id=7');
      const u = new URL(p.url());
      await p.close();
      assert.equal(u.searchParams.get('utm_source'), null, p.url());
      assert.equal(u.searchParams.get('fbclid'), null);
      assert.equal(u.searchParams.get('id'), '7');
    });

    await test('custom filters: specific + procedural cosmetic rules', async () => {
      const r = await send({ t: 'opt:save', patch: { customFilters: 'news.test##.promo-box\nnews.test##.card:has-text(Sponsored)\n||blockme.test^' } });
      assert.ok(r.userFilterStats && r.userFilterStats.rules >= 1, JSON.stringify(r));
      const p = await context.newPage();
      const b = blockedRequests(p);
      await p.goto('http://news.test/');
      await p.evaluate(() => fetch('http://blockme.test/x').catch(() => null));
      const ok = await until(() => p.evaluate(() => getComputedStyle(document.getElementById('promo')).display === 'none' && getComputedStyle(document.getElementById('sponsored')).display === 'none'));
      const normal = await p.evaluate(() => getComputedStyle(document.getElementById('normal')).display);
      await p.close();
      assert.ok(ok, 'custom cosmetic rules not applied');
      assert.equal(normal, 'block');
      assert.ok(b.some((u) => u.includes('blockme.test')), `custom network rule not applied: ${b}`);
    });

    await test('allowlisted site gets no blocking', async () => {
      await send({ t: 'ui:toggleSite', hostname: 'news.test', allowed: true });
      const ruled = await until(() => ui.evaluate(async () =>
        (await chrome.declarativeNetRequest.getDynamicRules()).some((r) => r.action.type === 'allowAllRequests' && (r.condition.requestDomains || []).includes('news.test'))), 3000);
      assert.ok(ruled, 'allowlist rule not installed');
      const p = await context.newPage();
      const b = blockedRequests(p);
      await p.goto('http://news.test/');
      await sleep(800);
      const d = await p.evaluate(() => getComputedStyle(document.getElementById('banner')).display);
      await p.close();
      await send({ t: 'ui:toggleSite', hostname: 'news.test', allowed: false });
      assert.equal(b.length, 0, `blocked on allowlisted site: ${b}`);
      assert.notEqual(d, 'none');
    });

    console.log('\nStreaming services');

    const yt = await context.newPage();
    await yt.goto('https://www.youtube.com/watch');

    await test('YouTube: ad slots stripped from player responses (fetch + XHR)', async () => {
      const ok = await until(() => yt.evaluate(() => window.__r.fetch && window.__r.xhr), 6000);
      assert.ok(ok, 'player responses never arrived');
      const r = await yt.evaluate(() => window.__r);
      assert.ok(!r.fetch.includes('"adPlacements"') && !r.fetch.includes('"adSlots"'), `fetch: ${r.fetch}`);
      assert.ok(!r.xhr.includes('"adPlacements"'), `xhr: ${r.xhr}`);
      assert.ok(r.fetch.includes('"videoDetails"'), 'content must survive');
    });

    await test('YouTube: Shorts ad entries removed', async () => {
      const shorts = await until(() => yt.evaluate(() => window.__r.shorts), 6000);
      assert.deepEqual(shorts.entries.map((e) => e.command.reelWatchEndpoint.videoId), ['v1', 'v2']);
    });

    await test('YouTube: feed ad slots hidden', async () => {
      const hidden = await until(() => yt.evaluate(() => getComputedStyle(document.getElementById('feedad')).display === 'none'));
      assert.ok(hidden);
    });

    await test('YouTube: a playing ad is muted, fast-forwarded and skipped, then state restored', async () => {
      await yt.evaluate(() => {
        const v = document.querySelector('video');
        v.muted = false;
        v.playbackRate = 1.25;
        document.getElementById('movie_player').classList.add('ad-showing');
      });
      const during = await until(() => yt.evaluate(() => {
        const v = document.querySelector('video');
        return v.muted && v.playbackRate === 16 && window.__skipped > 0 ? { muted: v.muted, rate: v.playbackRate } : null;
      }), 3000);
      assert.ok(during, 'ad was not muted / fast-forwarded / skipped');
      await yt.evaluate(() => document.getElementById('movie_player').classList.remove('ad-showing'));
      const after = await until(() => yt.evaluate(() => {
        const v = document.querySelector('video');
        return !v.muted && v.playbackRate === 1.25;
      }), 3000);
      assert.ok(after, 'mute/speed not restored after the ad');
    });

    await test('YouTube: "ad blockers are not allowed" wall removed', async () => {
      await yt.evaluate(() => {
        const d = document.createElement('tp-yt-paper-dialog');
        d.id = 'wall';
        d.appendChild(document.createElement('ytd-enforcement-message-view-model'));
        document.body.appendChild(d);
      });
      const gone = await until(() => yt.evaluate(() => !document.getElementById('wall')), 3000);
      assert.ok(gone);
    });
    await yt.close();

    await test('Spotify web player: audio ads muted, sound restored after', async () => {
      const sp = await context.newPage();
      await sp.goto('https://open.spotify.com/');
      await sp.waitForTimeout(400);
      assert.equal(await sp.evaluate(() => window.__audio.muted), false, 'music must not be muted');
      await sp.evaluate(() => (document.title = 'Advertisement'));
      const muted = await until(() => sp.evaluate(() => window.__audio.muted), 3000);
      await sp.evaluate(() => (document.title = 'Next Song • Artist'));
      const restored = await until(() => sp.evaluate(() => !window.__audio.muted), 3000);
      await sp.close();
      assert.ok(muted, 'ad was not muted');
      assert.ok(restored, 'sound not restored after the ad');
    });

    console.log('\nVideo ads on any site');
    const mediaState = (p, id) => p.evaluate((i) => {
      const v = document.getElementById(i);
      return { muted: v.muted, rate: v.playbackRate, time: v.currentTime, duration: v.duration, ended: v.ended };
    }, id);

    await test('player in ad mode: ad muted, fast-forwarded and skipped; restored after', async () => {
      const p = await context.newPage();
      await p.goto('http://videojs.test/');
      const during = await until(async () => {
        const s = await mediaState(p, 'adv');
        const skipped = await p.evaluate(() => window.__skipped > 0);
        return s.muted && (s.ended || s.time > 25) && skipped ? s : null;
      }, 6000);
      assert.ok(during, `ad not handled: ${JSON.stringify(await mediaState(p, 'adv'))}`);
      await p.evaluate(() => document.getElementById('player').classList.remove('vjs-ad-playing'));
      const after = await until(async () => {
        const s = await mediaState(p, 'adv');
        const c = await mediaState(p, 'content');
        return !s.muted && s.rate === 1 && !c.muted ? c : null;
      }, 3000);
      await p.close();
      assert.ok(after, 'mute/speed not restored after the ad');
      assert.ok(after.time < 1 && after.rate === 1, `paused content video next to the ad was moved: ${JSON.stringify(after)}`);
    });

    await test('ad containers are recognised by whole words, never "head-container"', async () => {
      const p = await context.newPage();
      await p.goto('http://containers.test/');
      const ad = await until(async () => {
        const s = await mediaState(p, 'ad');
        return s.muted && (s.ended || s.time > 25) ? s : null;
      }, 6000);
      await p.waitForTimeout(600);
      const hero = await mediaState(p, 'hero');
      const clip = await mediaState(p, 'clip');
      await p.close();
      assert.ok(ad, 'video in #video-ad-container not handled');
      for (const [name, s] of [['hero', hero], ['clip', clip]]) {
        assert.ok(!s.muted && s.rate === 1 && s.time < 10, `${name} wrongly treated as an ad: ${JSON.stringify(s)}`);
      }
    });

    await test('ad label beside a long video: muted only, never fast-forwarded', async () => {
      const p = await context.newPage();
      await p.goto('http://labels.test/');
      const muted = await until(async () => (await mediaState(p, 'cv')).muted, 5000);
      await p.waitForTimeout(800);
      const s = await mediaState(p, 'cv');
      // A label is only a hint: if the user unmutes, it stays unmuted.
      await p.evaluate(() => (document.getElementById('cv').muted = false));
      await p.waitForTimeout(900);
      const unmuted = !(await mediaState(p, 'cv')).muted;
      await p.close();
      assert.ok(muted, 'ad-labelled playback not muted');
      assert.ok(s.time < 10 && s.rate === 1, `content must not be fast-forwarded: ${JSON.stringify(s)}`);
      assert.ok(unmuted, 'user could not unmute a label-only match');
    });

    await test('strong ad signal on a 5-minute clip: muted, not fast-forwarded', async () => {
      const p = await context.newPage();
      await p.goto('http://longad.test/');
      const muted = await until(async () => (await mediaState(p, 'lv')).muted, 5000);
      await p.waitForTimeout(800);
      const s = await mediaState(p, 'lv');
      await p.close();
      assert.ok(muted);
      assert.ok(s.time < 10, `long clip must not be skipped: ${JSON.stringify(s)}`);
    });

    await test('Google IMA SDK replaced: ad requests end in "no ad", VAST tags answered empty', async () => {
      const p = await context.newPage();
      await p.goto('http://ima.test/');
      const r = await until(() => p.evaluate(() => (window.__r.ima && window.__r.vast ? window.__r : null)), 6000);
      await p.close();
      assert.ok(r, 'IMA flow did not complete');
      assert.equal(r.ima, 'error:1009');
      assert.ok(!r.vast.includes('real-ad'), `real VAST reached the page: ${r.vast}`);
      assert.ok(!hits.some((h) => h.includes('imasdk.googleapis.com')), 'real IMA SDK was downloaded');
    });

    await test('HLS: stitched ad breaks cut from on-demand playlists, live untouched except interstitials', async () => {
      const p = await context.newPage();
      await p.goto('http://hls.test/');
      const r = await until(() => p.evaluate(() => (window.__r.vodFetch && window.__r.vodXhr && window.__r.live ? window.__r : null)), 6000);
      await p.close();
      assert.ok(r, 'playlists not loaded');
      for (const t of [r.vodFetch, r.vodXhr]) {
        assert.ok(!t.includes('ad-segment.ts') && t.includes('content1.ts') && t.includes('content2.ts'), t);
      }
      assert.ok(r.live.includes('ad-segment.ts'), 'live playlist segments must be kept');
      assert.ok(!r.live.includes('interstitial'), 'interstitial ad must be dropped');
    });

    console.log('\nLevel 4');
    await setLevel(4);

    await test('level 4 rulesets on, scriptlets for cookies registered', async () => {
      const ids = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
      assert.ok(ids.includes('net_l4') && ids.includes('ping_l4'), ids.join(','));
      const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
      assert.ok(scripts.some((s) => s.id.endsWith('-L4')), 'no L4 scriptlet bundles');
    });

    await test('cross-site popup from a non-link element is blocked', async () => {
      const p = await context.newPage();
      await p.goto('http://news.test/');
      const before = context.pages().length;
      await p.click('#plain');
      await sleep(700);
      const after = context.pages().length;
      await p.close();
      assert.equal(after, before, 'popup opened from a plain div');
    });

    await test('tab-under redirect is reverted', async () => {
      const p = await context.newPage();
      await p.goto('http://tabunder.test/');
      const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }), p.click('#go')]);
      const back = await until(() => p.url().includes('tabunder.test') && hits.some((h) => h.includes('lander.test')), 6000, 200);
      const finalUrl = p.url();
      await popup.close().catch(() => {});
      await p.close();
      assert.ok(back && finalUrl.includes('tabunder.test'), `tab ended on ${finalUrl}`);
    });

    console.log('\nLevel 5');
    await setLevel(5);

    await test('nuclear rulesets enabled within the browser rule budget', async () => {
      const ids = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
      assert.ok(ids.includes('frames_l5') && ids.includes('net_l5'), ids.join(','));
      const { warnings = {} } = await sw.evaluate(() => chrome.storage.local.get('warnings'));
      assert.ok(!warnings.rulesets, warnings.rulesets);
    });

    console.log('\nLevel 1');
    await setLevel(1);
    await test('level 1 disables higher rulesets', async () => {
      const ids = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
      assert.deepEqual(ids.filter((i) => !i.endsWith('_l1')), []);
    });
    await setLevel(3);

    await test('popup UI renders with the slider', async () => {
      await ui.reload();
      await ui.waitForSelector('#level');
      const v = await ui.$eval('#level', (e) => e.value);
      const name = await ui.$eval('#levelName', (e) => e.textContent);
      assert.equal(v, '3');
      assert.match(name, /Aggressive/);
    });

    await test('options page renders built-in lists', async () => {
      const o = await context.newPage();
      await o.goto(`chrome-extension://${extId}/ui/options.html`);
      await o.waitForSelector('#lists tr:nth-child(5)');
      const rows = await o.$$eval('#lists tr', (r) => r.length);
      await o.close();
      assert.ok(rows > 10, `rows=${rows}`);
    });
  } finally {
    await context.close();
    server.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
