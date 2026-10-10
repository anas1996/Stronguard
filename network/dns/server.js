// Stronguard DNS sinkhole: UDP + TCP server with blocking, caching, CNAME
// uncloaking, bypass-canary handling, LAN conditional forwarding and DoH upstreams.

import dgram from 'node:dgram';
import net from 'node:net';
import {
  TYPE, TYPE_NAME, RCODE, parseMessage, buildAnswer, buildError, buildFormErr, setId, withAgedTtls, cacheTtl, truncate,
} from './packet.js';
import { UpstreamPool, createUpstream } from './upstream.js';
import { parseHostPort } from '../config.js';

const EDE_BLOCKED = 15;
const EDE_FILTERED = 17;

const PRIVATE_REVERSE = [
  /\.10\.in-addr\.arpa$/, /\.(1[6-9]|2\d|3[01])\.172\.in-addr\.arpa$/, /\.168\.192\.in-addr\.arpa$/,
  /\.127\.in-addr\.arpa$/, /\.254\.169\.in-addr\.arpa$/, /\.[cd]\.f\.ip6\.arpa$/, /\.[89ab]\.e\.f\.ip6\.arpa$/,
  /^1(\.0){31}\.ip6\.arpa$/,
];

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.') || addr === '::ffff:127.0.0.1';

class Cache {
  constructor({ maxEntries, minTtl, maxTtl }) {
    this.max = maxEntries;
    this.minTtl = minTtl;
    this.maxTtl = maxTtl;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return null;
    }
    const age = Math.floor((Date.now() - e.stored) / 1000);
    if (age >= e.ttl) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    this.map.delete(key);
    this.map.set(key, e); // LRU refresh
    this.hits++;
    return withAgedTtls(e.buf, e.msg, age);
  }

  set(key, buf, msg) {
    const ttl = Math.min(this.maxTtl, Math.max(this.minTtl, cacheTtl(msg)));
    this.map.set(key, { buf, msg, ttl, stored: Date.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  clear() {
    this.map.clear();
  }
}

export class DnsServer {
  constructor({ config, engine, stats, log = () => {} }) {
    this.engine = engine;
    this.stats = stats;
    this.log = log;
    this.sockets = [];
    this.servers = [];
    this.inflight = new Map();
    this.buckets = new Map();
    this.paused = false;
    this.applyConfig(config);
  }

  applyConfig(config) {
    const d = config.dns;
    this.config = config;
    if (this.upstream) this.upstream.close();
    this.upstream = new UpstreamPool(d.upstreams);
    this.local = d.localForward && d.localForward.upstream ? createUpstream(d.localForward.upstream, { timeout: 2000 }) : null;
    this.localZones = (d.localForward && d.localForward.zones) || [];
    this.cache = new Cache(d.cache);
  }

  clearCache() {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------

  async start() {
    const errors = [];
    for (const addr of this.config.dns.listen) {
      try {
        await this.listen(addr);
      } catch (err) {
        // e.g. no IPv6 on this machine: keep serving on the other addresses
        errors.push(`${addr}: ${err.code || err.message}`);
        this.log(`DNS could not listen on ${addr} (${err.code || err.message})`);
      }
    }
    if (!this.sockets.length) throw new Error(`DNS server could not listen (${errors.join('; ')}). Is port 53 already in use?`);
  }

  async listen(addr) {
    const { host } = parseHostPort(addr, 53);
    let { port } = parseHostPort(addr, 53);
    const type = net.isIPv6(host) ? 'udp6' : 'udp4';
    const sock = await new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
      s.once('error', reject);
      s.on('message', (msg, rinfo) => this.onUdp(s, msg, rinfo));
      s.bind(port, host, () => {
        s.removeListener('error', reject);
        s.on('error', (err) => this.log(`DNS UDP ${addr}: ${err.message}`));
        resolve(s);
      });
    });
    port = sock.address().port; // TCP follows the UDP port (matters when port 0 was requested)
    try {
      const srv = await new Promise((resolve, reject) => {
        const s = net.createServer((c) => this.onTcp(c));
        s.once('error', reject);
        s.listen({ host, port, ipv6Only: net.isIPv6(host) }, () => {
          s.removeListener('error', reject);
          resolve(s);
        });
      });
      this.servers.push(srv);
    } catch (err) {
      sock.close();
      throw err;
    }
    this.sockets.push(sock);
    this.log(`DNS listening on ${host}:${port} (UDP+TCP)`);
  }

  async stop() {
    for (const s of this.sockets) s.close();
    for (const s of this.servers) s.close();
    this.upstream.close();
    this.sockets = [];
    this.servers = [];
  }

  addresses() {
    return this.sockets.map((s) => s.address());
  }

  onUdp(sock, msg, rinfo) {
    this.handle(msg, { address: rinfo.address, proto: 'udp' })
      .then((res) => {
        if (!res) return;
        sock.send(res, rinfo.port, rinfo.address);
      })
      .catch(() => {});
  }

  onTcp(conn) {
    let acc = Buffer.alloc(0);
    conn.setTimeout(10000, () => conn.destroy());
    conn.on('error', () => {});
    conn.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 2) {
        const len = acc.readUInt16BE(0);
        if (acc.length < 2 + len) break;
        const q = acc.subarray(2, 2 + len);
        acc = acc.subarray(2 + len);
        this.handle(q, { address: conn.remoteAddress || '', proto: 'tcp' }).then((res) => {
          if (!res || conn.destroyed) return;
          const l = Buffer.alloc(2);
          l.writeUInt16BE(res.length);
          conn.write(Buffer.concat([l, res]));
        });
      }
      if (acc.length > 70000) conn.destroy();
    });
  }

  rateLimited(addr) {
    if (isLoopback(addr)) return false;
    const limit = this.config.dns.rateLimitPerSecond;
    if (!limit) return false;
    const sec = Math.floor(Date.now() / 1000);
    const b = this.buckets.get(addr);
    if (!b || b.sec !== sec) {
      this.buckets.set(addr, { sec, n: 1 });
      if (this.buckets.size > 10000) this.buckets.clear();
      return false;
    }
    return ++b.n > limit;
  }

  // ---------------------------------------------------------------------------

  blockedResponse(query, raw, m, reasonCode = EDE_BLOCKED) {
    const ttl = this.config.dns.blockedTtl;
    const text = `Stronguard: ${m.list || 'blocked'}`;
    if (m.nxdomain || this.config.dns.blockResponse === 'nxdomain') {
      return buildAnswer(query, raw, { rcode: RCODE.NXDOMAIN, ttl, ede: { code: reasonCode, text } });
    }
    if (this.config.dns.blockResponse === 'refused') {
      return buildAnswer(query, raw, { rcode: RCODE.REFUSED, ttl, ede: { code: reasonCode, text } });
    }
    return buildAnswer(query, raw, { a: '0.0.0.0', aaaa: '::', ttl, ede: { code: reasonCode, text } });
  }

  isLocalName(name) {
    if (!name.includes('.')) return true;
    if (PRIVATE_REVERSE.some((re) => re.test(name))) return true;
    return this.localZones.some((z) => name === z || name.endsWith(`.${z}`));
  }

  async handle(raw, client) {
    const t0 = Date.now();
    let query;
    try {
      query = parseMessage(raw);
    } catch {
      return buildFormErr(raw);
    }
    if (query.qr) return null;
    if (this.rateLimited(client.address)) return null;
    if (query.opcode !== 0) return buildError(query, raw, RCODE.NOTIMP);
    if (query.questions.length !== 1) return buildError(query, raw, RCODE.FORMERR);

    const q = query.questions[0];
    const name = q.name.replace(/\.$/, '');
    const entry = { time: t0, client: client.address, name, type: TYPE_NAME[q.type] || String(q.type), status: '', list: '', ms: 0 };
    const finish = (status, res, extra = {}) => {
      entry.status = status;
      entry.ms = Date.now() - t0;
      Object.assign(entry, extra);
      this.stats.record(entry);
      return this.fit(res, query, client);
    };

    if (q.type === TYPE.ANY && !isLoopback(client.address)) return finish('refused', buildError(query, raw, RCODE.NOTIMP));

    // localhost
    if (name === 'localhost' || name.endsWith('.localhost')) {
      return finish('local', buildAnswer(query, raw, { a: '127.0.0.1', aaaa: '::1', ttl: 3600 }));
    }

    // LAN names and private reverse lookups never leave the network.
    if (this.isLocalName(name)) {
      if (!this.local) return finish('local', buildError(query, raw, RCODE.NXDOMAIN));
      try {
        return finish('local', await this.local.query(raw));
      } catch {
        return finish('error', buildError(query, raw, RCODE.SERVFAIL));
      }
    }

    // Blocking
    const m = this.paused ? null : this.engine.match(name);
    if (m && m.blocked) return finish('blocked', this.blockedResponse(query, raw, m), { list: m.list, rule: m.rule });
    const userAllowed = !!(m && m.reason === 'user-allow');

    // Cache
    const key = `${name}|${q.type}|${q.class}|${query.edns && query.edns.do ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return finish('cached', setId(hit, query.id));

    // Forward (coalescing identical in-flight queries)
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.forward(raw, name, userAllowed).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      const { buf, msg, cnameBlock } = await pending;
      if (cnameBlock) {
        return finish('cname-blocked', this.blockedResponse(query, raw, cnameBlock, EDE_FILTERED), { list: cnameBlock.list, rule: cnameBlock.rule });
      }
      if (msg.rcode !== RCODE.SERVFAIL && msg.rcode !== RCODE.REFUSED && !msg.tc) this.cache.set(key, buf, msg);
      return finish('forwarded', setId(buf, query.id));
    } catch {
      return finish('error', buildError(query, raw, RCODE.SERVFAIL));
    }
  }

  async forward(raw, name, userAllowed) {
    const buf = await this.upstream.query(raw);
    const msg = parseMessage(buf);
    // CNAME uncloaking: a first-party name aliasing a blocked tracker is blocked too.
    if (this.config.dns.cnameUncloaking && !this.paused && !userAllowed) {
      for (const rr of msg.answers) {
        if (rr.type !== TYPE.CNAME || !rr.data) continue;
        const m = this.engine.match(rr.data);
        if (m.blocked) return { buf, msg, cnameBlock: { ...m, rule: `${name} → ${rr.data}` } };
      }
    }
    return { buf, msg };
  }

  // UDP responses larger than the client accepts are truncated (client retries over TCP).
  fit(res, query, client) {
    if (client.proto !== 'udp' || !res) return res;
    const max = query.edns ? Math.min(query.edns.udpSize, 4096) : 512;
    if (res.length <= max) return res;
    try {
      return truncate(res, parseMessage(res));
    } catch {
      return res.subarray(0, 12);
    }
  }
}
