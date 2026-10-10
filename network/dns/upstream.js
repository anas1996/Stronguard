// Upstream resolvers: DNS-over-HTTPS (HTTP/2, connection reuse), UDP and TCP.

import http2 from 'node:http2';
import dgram from 'node:dgram';
import net from 'node:net';
import { parseMessage, setId } from './packet.js';

function sameQuestion(a, b) {
  const qa = a.questions[0];
  const qb = b.questions[0];
  return qa && qb && qa.name === qb.name && qa.type === qb.type && qa.class === qb.class;
}

export class DohUpstream {
  constructor(url, { timeout = 4000, lookup = null } = {}) {
    this.url = new URL(url);
    this.label = url;
    this.timeout = timeout;
    this.lookup = lookup;
    this.session = null;
  }

  getSession() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const opts = { settings: { enablePush: false } };
    if (this.lookup) opts.lookup = this.lookup;
    const s = http2.connect(this.url.origin, opts);
    s.on('error', () => {});
    s.on('goaway', () => s.close());
    s.on('close', () => {
      if (this.session === s) this.session = null;
    });
    s.setTimeout(60000, () => s.close());
    s.unref();
    this.session = s;
    return s;
  }

  query(buf) {
    return new Promise((resolve, reject) => {
      const id = buf.readUInt16BE(0);
      const body = setId(buf, 0); // RFC 8484: ID 0 improves HTTP cache hits
      let session;
      try {
        session = this.getSession();
      } catch (err) {
        reject(err);
        return;
      }
      const req = session.request({
        ':method': 'POST',
        ':path': this.url.pathname + this.url.search,
        'content-type': 'application/dns-message',
        accept: 'application/dns-message',
        'content-length': body.length,
      });
      const chunks = [];
      let status = 0;
      const timer = setTimeout(() => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error('DoH timeout'));
      }, this.timeout);
      req.on('response', (h) => {
        status = h[':status'];
      });
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        clearTimeout(timer);
        if (status !== 200) return reject(new Error(`DoH HTTP ${status}`));
        const res = Buffer.concat(chunks);
        if (res.length < 12) return reject(new Error('DoH short response'));
        resolve(setId(res, id));
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end(body);
    });
  }

  close() {
    if (this.session) this.session.close();
  }
}

export class TcpUpstream {
  constructor(host, port = 53, { timeout = 4000 } = {}) {
    this.host = host;
    this.port = port;
    this.label = `tcp://${host}:${port}`;
    this.timeout = timeout;
  }

  query(buf) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      const len = Buffer.alloc(2);
      len.writeUInt16BE(buf.length);
      let acc = Buffer.alloc(0);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('TCP timeout'));
      }, this.timeout);
      sock.on('connect', () => sock.end(Buffer.concat([len, buf])));
      sock.on('data', (c) => {
        acc = Buffer.concat([acc, c]);
        if (acc.length >= 2 && acc.length >= 2 + acc.readUInt16BE(0)) {
          clearTimeout(timer);
          sock.destroy();
          resolve(acc.subarray(2, 2 + acc.readUInt16BE(0)));
        }
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.on('close', () => {
        clearTimeout(timer);
        reject(new Error('TCP closed'));
      });
    });
  }
}

export class UdpUpstream {
  constructor(host, port = 53, { timeout = 2500 } = {}) {
    this.host = host;
    this.port = port;
    this.label = `udp://${host}:${port}`;
    this.timeout = timeout;
    this.tcp = new TcpUpstream(host, port, { timeout });
  }

  query(buf) {
    return new Promise((resolve, reject) => {
      // A fresh socket per query gives a random source port (anti-spoofing).
      const sock = dgram.createSocket(net.isIPv6(this.host) ? 'udp6' : 'udp4');
      const sent = parseMessage(buf);
      let done = false;
      const finish = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sock.close();
        } catch {
          /* already closed */
        }
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('UDP timeout'))), this.timeout);
      sock.on('message', (msg, rinfo) => {
        if (rinfo.address.toLowerCase() !== this.host.toLowerCase() || rinfo.port !== this.port) return;
        let parsed;
        try {
          parsed = parseMessage(msg);
        } catch {
          return;
        }
        if (parsed.id !== sent.id || !parsed.qr || !sameQuestion(parsed, sent)) return;
        finish(() => {
          if (parsed.tc) this.tcp.query(buf).then(resolve, reject);
          else resolve(msg);
        });
      });
      sock.on('error', (err) => finish(() => reject(err)));
      sock.send(buf, this.port, this.host);
    });
  }
}

export function createUpstream(spec, opts = {}) {
  const s = String(spec).trim();
  if (s.startsWith('https://') || s.startsWith('http://')) return new DohUpstream(s, opts);
  const m = /^(udp|tcp):\/\/\[?([^\]]+?)\]?(?::(\d+))?$/.exec(s) || /^()\[?([0-9a-f.:]+?)\]?(?::(\d+))?$/i.exec(s);
  if (!m) throw new Error(`Invalid upstream: ${spec}`);
  const [, proto, host, port] = m;
  const p = port ? Number(port) : 53;
  return proto === 'tcp' ? new TcpUpstream(host, p, opts) : new UdpUpstream(host, p, opts);
}

// Ordered failover across upstreams; an upstream that fails is skipped for a while.
export class UpstreamPool {
  constructor(specs, opts = {}) {
    if (!specs || !specs.length) throw new Error('No upstream resolvers configured');
    this.upstreams = specs.map((s) => ({ u: createUpstream(s, opts), downUntil: 0, failures: 0, ok: 0 }));
  }

  get labels() {
    return this.upstreams.map((x) => x.u.label);
  }

  async query(buf) {
    const now = Date.now();
    const order = [...this.upstreams].sort((a, b) => (a.downUntil > now) - (b.downUntil > now));
    let lastErr = null;
    for (const entry of order) {
      try {
        const res = await entry.u.query(buf);
        entry.failures = 0;
        entry.downUntil = 0;
        entry.ok++;
        return res;
      } catch (err) {
        lastErr = err;
        entry.failures++;
        entry.downUntil = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(entry.failures, 5));
      }
    }
    throw lastErr || new Error('all upstreams failed');
  }

  health() {
    const now = Date.now();
    return this.upstreams.map((x) => ({ upstream: x.u.label, healthy: x.downUntil <= now, failures: x.failures, answered: x.ok }));
  }

  close() {
    for (const x of this.upstreams) if (x.u.close) x.u.close();
  }
}
