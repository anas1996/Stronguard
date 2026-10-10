import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import http from 'node:http';
import http2 from 'node:http2';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TYPE, RCODE, buildQuery, parseMessage, encodeName } from '../network/dns/packet.js';
import { DnsServer } from '../network/dns/server.js';
import { FilterEngine } from '../network/engine.js';
import { Stats } from '../network/stats.js';
import { normalizeConfig } from '../network/config.js';
import { FilteringProxy } from '../network/proxy/server.js';
import { Dashboard } from '../network/dashboard/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Fake upstream resolver

function answer(raw, records) {
  const q = parseMessage(raw);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  const parts = [header, raw.subarray(12, q.questionEnd)];
  for (const r of records) {
    let rdata;
    if (r.type === TYPE.A) rdata = Buffer.from(r.data.split('.').map(Number));
    else if (r.type === TYPE.CNAME) rdata = encodeName(r.data);
    else if (r.type === TYPE.TXT) rdata = Buffer.concat([Buffer.from([r.data.length]), Buffer.from(r.data)]);
    const name = r.name ? encodeName(r.name) : Buffer.from([0xc0, 0x0c]);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(r.type, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(r.ttl || 300, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    parts.push(name, fixed, rdata);
  }
  return Buffer.concat(parts);
}

const ZONE = {
  'example.com': [{ type: TYPE.A, data: '93.184.216.34' }],
  'cdn.site.test': [{ type: TYPE.CNAME, data: 'ib.adnxs.com' }, { name: 'ib.adnxs.com', type: TYPE.A, data: '1.2.3.4' }],
  'big.test': Array.from({ length: 6 }, (_, i) => ({ type: TYPE.TXT, data: `${i}`.repeat(200) })),
};

let upstreamHits = 0;
function upstreamReply(raw) {
  upstreamHits++;
  const q = parseMessage(raw);
  const records = ZONE[q.questions[0].name] || [];
  return answer(raw, records.filter((r) => r.type === q.questions[0].type || r.type === TYPE.CNAME || q.questions[0].type === TYPE.TXT));
}

let upstream;
let doh;
let server;
let stats;
let engine;
let dnsPort;
let config;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-test-'));

function query(name, type = TYPE.A, { proto = 'udp', edns = true } = {}) {
  const buf = buildQuery(name, type, { edns });
  if (proto === 'tcp') {
    return new Promise((resolve, reject) => {
      const c = net.connect(dnsPort, '127.0.0.1', () => {
        const l = Buffer.alloc(2);
        l.writeUInt16BE(buf.length);
        c.write(Buffer.concat([l, buf]));
      });
      let acc = Buffer.alloc(0);
      c.on('data', (d) => {
        acc = Buffer.concat([acc, d]);
        if (acc.length >= 2 && acc.length >= 2 + acc.readUInt16BE(0)) {
          c.end();
          resolve(parseMessage(acc.subarray(2)));
        }
      });
      c.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => {
      s.close();
      reject(new Error('timeout'));
    }, 3000);
    s.on('message', (m) => {
      clearTimeout(t);
      s.close();
      resolve({ ...parseMessage(m), size: m.length });
    });
    s.send(buf, dnsPort, '127.0.0.1');
  });
}

before(async () => {
  upstream = dgram.createSocket('udp4');
  upstream.on('message', (m, r) => upstream.send(upstreamReply(m), r.port, r.address));
  await new Promise((r) => upstream.bind(0, '127.0.0.1', r));

  // Cleartext HTTP/2 DoH server for the DoH client test
  doh = http2.createServer();
  doh.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      assert.equal(headers['content-type'], 'application/dns-message');
      stream.respond({ ':status': 200, 'content-type': 'application/dns-message' });
      stream.end(upstreamReply(Buffer.concat(chunks)));
    });
  });
  await new Promise((r) => doh.listen(0, '127.0.0.1', r));

  config = normalizeConfig({
    level: 3,
    dns: { listen: ['127.0.0.1:0'], upstreams: [`udp://127.0.0.1:${upstream.address().port}`] },
  });
  stats = new Stats(100);
  engine = new FilterEngine({ root: ROOT, dataDir });
  await engine.load(config, { offline: true }); // builtin lists only
  server = new DnsServer({ config, engine, stats });
  await server.start();
  dnsPort = server.addresses()[0].port;
});

after(async () => {
  await server.stop();
  upstream.close();
  doh.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('blocked domain and its subdomains are sinkholed with an EDE', async () => {
  const r = await query('doubleclick.net');
  assert.equal(r.rcode, RCODE.NOERROR);
  assert.equal(r.answers[0].data, '0.0.0.0');
  const r6 = await query('stats.g.doubleclick.net', TYPE.AAAA);
  assert.equal(r6.answers[0].data, '0:0:0:0:0:0:0:0');
  assert.equal(stats.counters.blocked, 2);
});

test('popup networks blocked; HTTPS records get NODATA', async () => {
  const r = await query('popads.net', TYPE.HTTPS);
  assert.equal(r.rcode, RCODE.NOERROR);
  assert.equal(r.answers.length, 0);
});

test('allowed names are forwarded and then cached', async () => {
  const before = upstreamHits;
  const r1 = await query('example.com');
  assert.equal(r1.answers[0].data, '93.184.216.34');
  const r2 = await query('example.com');
  assert.equal(r2.answers[0].data, '93.184.216.34');
  assert.equal(upstreamHits, before + 1, 'second answer should come from cache');
  assert.ok(stats.counters.cached >= 1);
});

test('CNAME-cloaked tracker is uncloaked and blocked', async () => {
  const r = await query('cdn.site.test');
  assert.equal(r.answers[0].data, '0.0.0.0');
  assert.equal(stats.counters.cnameBlocked, 1);
});

test('bypass canaries return NXDOMAIN at level 3', async () => {
  for (const d of ['use-application-dns.net', 'mask.icloud.com']) {
    const r = await query(d);
    assert.equal(r.rcode, RCODE.NXDOMAIN, d);
  }
});

test('localhost, LAN names and private reverse lookups stay local', async () => {
  const r = await query('localhost');
  assert.equal(r.answers[0].data, '127.0.0.1');
  assert.equal((await query('printer.lan')).rcode, RCODE.NXDOMAIN);
  assert.equal((await query('wpad')).rcode, RCODE.NXDOMAIN);
  assert.equal((await query('1.1.168.192.in-addr.arpa', TYPE.PTR)).rcode, RCODE.NXDOMAIN);
});

test('large UDP answers are truncated, TCP returns them in full', async () => {
  const udp = await query('big.test', TYPE.TXT, { edns: false });
  assert.equal(udp.tc, 1);
  const tcp = await query('big.test', TYPE.TXT, { proto: 'tcp', edns: false });
  assert.equal(tcp.tc, 0);
  assert.equal(tcp.answers.length, 6);
});

test('user allowlist overrides lists', async () => {
  engine.setUserLists({ allowlist: ['doubleclick.net'], blocklist: ['example.org'] });
  server.clearCache();
  const r = await query('doubleclick.net');
  assert.equal(r.answers.length, 0); // forwarded: fake upstream has no record
  const b = await query('www.example.org');
  assert.equal(b.answers[0].data, '0.0.0.0');
  engine.setUserLists({ allowlist: [], blocklist: [] });
});

test('pause forwards everything', async () => {
  server.paused = true;
  const r = await query('popcash.net');
  server.paused = false;
  assert.equal(r.answers.length, 0);
});

test('DNS-over-HTTPS upstream (HTTP/2)', async () => {
  const { DohUpstream } = await import('../network/dns/upstream.js');
  const u = new DohUpstream(`http://127.0.0.1:${doh.address().port}/dns-query`);
  const res = parseMessage(await u.query(buildQuery('example.com', TYPE.A, { id: 4242 })));
  u.close();
  assert.equal(res.id, 4242);
  assert.equal(res.answers[0].data, '93.184.216.34');
});

test('malformed packets get FORMERR, not a crash', async () => {
  const s = dgram.createSocket('udp4');
  const got = new Promise((resolve) => s.on('message', (m) => resolve(m)));
  s.send(Buffer.from([1, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 63, 1]), dnsPort, '127.0.0.1');
  const m = await got;
  s.close();
  assert.equal(m.readUInt16BE(2) & 0xf, RCODE.FORMERR);
});

// ---------------------------------------------------------------------------
// Proxy

test('proxy: CONNECT to blocked host refused, allowed host tunnelled, PAC served', async () => {
  const target = net.createServer((c) => c.end('hello'));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const proxy = new FilteringProxy({ config: normalizeConfig({ proxy: { listen: '127.0.0.1:0' } }), engine, stats });
  await proxy.start();
  const port = proxy.server.address().port;
  proxy.port = port;

  const connect = (dest) =>
    new Promise((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => c.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n\r\n`));
      let data = '';
      c.on('data', (d) => (data += d));
      c.on('close', () => resolve(data));
      setTimeout(() => c.end(), 300);
    });
  assert.match(await connect('ads.doubleclick.net:443'), /^HTTP\/1\.1 403/);
  const ok = await connect(`127.0.0.1:${target.address().port}`);
  assert.match(ok, /^HTTP\/1\.1 200/);
  assert.match(ok, /hello$/);

  const pac = await new Promise((resolve) => http.get({ port, host: '127.0.0.1', path: '/proxy.pac' }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => resolve(b));
  }));
  assert.match(pac, /function FindProxyForURL/);
  assert.match(pac, new RegExp(`PROXY 127\\.0\\.0\\.1:${port}; DIRECT`));

  const blockedGet = await new Promise((resolve) => http.get({ port, host: '127.0.0.1', path: 'http://popads.net/x', headers: { Host: 'popads.net' } }, (res) => resolve(res.statusCode)));
  assert.equal(blockedGet, 403);
  proxy.stop();
  target.close();
});

// ---------------------------------------------------------------------------
// Dashboard security

test('dashboard: API works locally, rejects rebinding hosts and foreign origins', async () => {
  const fake = {
    config: normalizeConfig({ dashboard: { listen: '127.0.0.1:0' } }),
    stats,
    engine,
    status: () => ({ level: 3 }),
    setLevel: async (l) => l,
  };
  const dash = new Dashboard({ service: fake });
  await dash.start();
  dash.port = dash.server.address().port;
  const req = (method, p, headers = {}, body) =>
    new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: dash.port, method, path: p, headers: { Host: `127.0.0.1:${dash.port}`, ...headers } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  assert.equal((await req('GET', '/api/status')).status, 200);
  assert.equal((await req('GET', '/api/status', { Host: 'evil.example:80' })).status, 421);
  assert.equal((await req('POST', '/api/level', { Origin: 'https://evil.example' }, { level: 1 })).status, 403);
  assert.equal((await req('POST', '/api/level', { Origin: 'chrome-extension://abcdefghijklmnop' }, { level: 4 })).status, 200);
  assert.equal(JSON.parse((await req('POST', '/api/level', {}, { level: 2 })).body).level, 2);
  const check = JSON.parse((await req('GET', '/api/check?domain=popads.net')).body);
  assert.equal(check.blocked, true);
  dash.stop();
});
