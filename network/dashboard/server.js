// Local dashboard + JSON API for the network shield.
//
// Security: binds to loopback by default, rejects requests whose Host header is
// not the dashboard itself (DNS-rebinding protection) and state-changing
// requests from foreign web origins (CSRF protection). Browser-extension
// origins are allowed so the Stronguard extension can sync its level.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS } from '../../core/levels.js';
import { parseHostPort } from '../config.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|extension|edge-extension):\/\/[a-z0-9-]+$/i;

export class Dashboard {
  constructor({ service, log = () => {} }) {
    this.service = service;
    this.log = log;
  }

  start() {
    const { host, port } = parseHostPort(this.service.config.dashboard.listen, 8080);
    this.host = host;
    this.port = port;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((err) => this.json(res, 500, { error: err.message })));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        this.log(`Dashboard on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  allowedHost(hostHeader) {
    if (!hostHeader) return false;
    const h = hostHeader.toLowerCase();
    const ok = ['127.0.0.1', 'localhost', '[::1]', this.host].map((x) => `${x}:${this.port}`);
    if (ok.includes(h)) return true;
    // When bound to the LAN, accept literal IP hosts (no DNS names: rebinding).
    return this.host === '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(h);
  }

  originOk(req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return !origin;
    if (EXTENSION_ORIGIN.test(origin)) return true;
    try {
      return this.allowedHost(new URL(origin).host);
    } catch {
      return false;
    }
  }

  json(res, status, body, origin) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (origin && EXTENSION_ORIGIN.test(origin)) headers['Access-Control-Allow-Origin'] = origin;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  async body(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 65536) throw new Error('body too large');
    }
    return data ? JSON.parse(data) : {};
  }

  async handle(req, res) {
    if (!this.allowedHost(req.headers.host)) {
      res.writeHead(421).end('Misdirected request');
      return;
    }
    const origin = req.headers.origin;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const svc = this.service;

    if (req.method === 'OPTIONS') {
      if (!origin || !EXTENSION_ORIGIN.test(origin)) return void res.writeHead(403).end();
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    if (req.method === 'POST' && !this.originOk(req)) return this.json(res, 403, { error: 'forbidden origin' });

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
        'X-Frame-Options': 'DENY',
      });
      res.end(fs.readFileSync(PAGE));
      return;
    }

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/status':
        return this.json(res, 200, svc.status(), origin);
      case 'GET /api/levels':
        return this.json(res, 200, LEVELS, origin);
      case 'GET /api/log':
        return this.json(res, 200, svc.stats.recent(Math.min(Number(url.searchParams.get('limit')) || 200, 2000), url.searchParams.get('filter') || ''), origin);
      case 'GET /api/top':
        return this.json(res, 200, svc.stats.top(Number(url.searchParams.get('n')) || 10), origin);
      case 'GET /api/check': {
        const d = url.searchParams.get('domain') || '';
        return this.json(res, 200, { domain: d, ...svc.engine.match(d) }, origin);
      }
      case 'POST /api/level': {
        const { level } = await this.body(req);
        return this.json(res, 200, { level: await svc.setLevel(level) }, origin);
      }
      case 'POST /api/pause': {
        const { minutes = 5 } = await this.body(req);
        svc.setPaused(Math.max(0, Math.min(Number(minutes) || 0, 24 * 60)));
        return this.json(res, 200, { pausedUntil: svc.pausedUntil }, origin);
      }
      case 'POST /api/resume':
        svc.setPaused(0);
        return this.json(res, 200, { pausedUntil: 0 }, origin);
      case 'POST /api/allow':
      case 'POST /api/block':
      case 'POST /api/unallow':
      case 'POST /api/unblock': {
        const { domain } = await this.body(req);
        const kind = url.pathname.includes('allow') ? 'allow' : 'block';
        const action = url.pathname.includes('/api/un') ? 'remove' : 'add';
        return this.json(res, 200, await svc.editList(kind, action, domain), origin);
      }
      case 'POST /api/update':
        await svc.refresh(true);
        return this.json(res, 200, svc.engine.summary(), origin);
      default:
        return this.json(res, 404, { error: 'not found' }, origin);
    }
  }
}
