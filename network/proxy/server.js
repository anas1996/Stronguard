// Filtering HTTP/HTTPS proxy + PAC file.
//
// Browsers configured with the PAC file (Windows "automatic proxy setup") send
// every request through here, so blocked hosts are refused even when a browser
// uses its own encrypted DNS and bypasses the Stronguard resolver. HTTPS is
// filtered by hostname (CONNECT); nothing is decrypted.

import http from 'node:http';
import net from 'node:net';
import { parseHostPort } from '../config.js';

const HOP_BY_HOP = ['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

const PRIVATE_CLIENT = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|::ffff:(127|10|192\.168)\.|f[cd][0-9a-f]{2}:|fe80:)/i;

export function pacScript(proxyHost, proxyPort) {
  return `// Stronguard proxy auto-config. Falls back to DIRECT if the service is not running.
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === "localhost" || shExpMatch(host, "*.localhost") ||
      shExpMatch(host, "*.local") || shExpMatch(host, "*.lan") || shExpMatch(host, "*.home.arpa") ||
      /^(127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|169\\.254\\.)/.test(host) || host.indexOf(":") !== -1) {
    return "DIRECT";
  }
  if (url.substring(0, 5) !== "http:" && url.substring(0, 6) !== "https:" && url.substring(0, 3) !== "ws:" && url.substring(0, 4) !== "wss:") {
    return "DIRECT";
  }
  return "PROXY ${proxyHost}:${proxyPort}; DIRECT";
}
`;
}

export class FilteringProxy {
  constructor({ config, engine, stats, log = () => {} }) {
    this.config = config;
    this.engine = engine;
    this.stats = stats;
    this.log = log;
    this.paused = false;
    this.server = null;
  }

  blocked(host) {
    if (this.paused) return null;
    const m = this.engine.match(host);
    return m.blocked ? m : null;
  }

  start() {
    const { host, port } = parseHostPort(this.config.proxy.listen, 8118);
    this.host = host;
    this.port = port;
    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.on('connect', (req, socket, head) => this.onConnect(req, socket, head));
    server.on('clientError', (err, socket) => socket.destroy());
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        this.log(`Proxy listening on ${host}:${port} (PAC: http://${host}:${port}/proxy.pac)`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  allowedClient(addr) {
    return PRIVATE_CLIENT.test(addr || '');
  }

  record(host, blocked) {
    this.stats.counters.proxyRequests++;
    if (blocked) {
      this.stats.counters.proxyBlocked++;
      this.stats.topBlocked.add(host);
    }
  }

  onRequest(req, res) {
    if (!this.allowedClient(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }
    // Local endpoints (PAC)
    if (req.url.startsWith('/')) {
      if (req.url === '/proxy.pac' || req.url === '/wpad.dat') {
        const pacHost = this.host === '0.0.0.0' || this.host === '::' ? req.headers.host.split(':')[0] : this.host;
        res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-cache' });
        res.end(pacScript(pacHost, this.port));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Stronguard filtering proxy. Use /proxy.pac for automatic configuration.\n');
      return;
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const m = this.blocked(url.hostname);
    this.record(url.hostname, !!m);
    if (m) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'X-Stronguard': `blocked; list=${m.list}` });
      res.end(`Blocked by Stronguard (${m.list}: ${m.rule})\n`);
      return;
    }
    const port = Number(url.port) || 80;
    if (port === this.port && ['127.0.0.1', 'localhost', '::1', this.host].includes(url.hostname)) {
      res.writeHead(508).end();
      return;
    }
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const upstream = http.request({ host: url.hostname, port, method: req.method, path: url.pathname + url.search, headers }, (up) => {
      const out = { ...up.headers };
      for (const h of HOP_BY_HOP) delete out[h];
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }

  onConnect(req, client, head) {
    client.on('error', () => {});
    if (!this.allowedClient(client.remoteAddress)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const { host, port } = parseHostPort(req.url, 443);
    const m = this.blocked(host);
    this.record(host, !!m);
    if (m) {
      client.end(`HTTP/1.1 403 Forbidden\r\nX-Stronguard: blocked; list=${m.list}\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    let established = false;
    const upstream = net.connect({ host, port }, () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (established) client.destroy();
      else client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    client.on('close', () => upstream.destroy());
  }
}
