// Network service configuration (JSON file in the data directory).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LEVEL, clampLevel } from '../core/levels.js';

export const DEFAULT_CONFIG = {
  level: DEFAULT_LEVEL,
  dns: {
    enabled: true,
    listen: ['127.0.0.1:53', '[::1]:53'],
    // IP-literal DoH endpoints need no DNS to bootstrap and keep queries encrypted.
    upstreams: ['https://9.9.9.9/dns-query', 'https://1.1.1.1/dns-query', 'https://149.112.112.112/dns-query'],
    // LAN names (router.lan, printer.home.arpa, reverse lookups of private IPs) go to the router.
    localForward: { upstream: '', zones: ['lan', 'home.arpa', 'local', 'localdomain', 'internal', 'home', 'corp'] },
    blockResponse: 'null', // null (0.0.0.0 / ::) | nxdomain | refused
    blockedTtl: 10,
    cnameUncloaking: true,
    cache: { maxEntries: 50000, minTtl: 30, maxTtl: 86400 },
    rateLimitPerSecond: 300,
  },
  proxy: { enabled: true, listen: '127.0.0.1:8118' },
  dashboard: { enabled: true, listen: '127.0.0.1:8080' },
  // Windows layers the service keeps in sync with the level (set by the installer).
  windows: { firewall: false, policies: false, serveLan: false, windowsAds: false, dnsAdapters: true },
  firewall: { allowDnsServers: [] },
  allowlist: [],
  blocklist: [],
  customRules: [],
  extraLists: [],
  updateIntervalHours: 24,
  queryLogSize: 2000,
};

export function defaultDataDir() {
  if (process.env.STRONGUARD_DATA) return process.env.STRONGUARD_DATA;
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Stronguard');
  return path.join(os.homedir(), '.stronguard');
}

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function normalizeConfig(cfg) {
  const c = merge(DEFAULT_CONFIG, cfg);
  c.level = clampLevel(c.level);
  const hosts = (list) => [...new Set((list || []).map((d) => String(d).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')).filter(Boolean))].sort();
  c.allowlist = hosts(c.allowlist);
  c.blocklist = hosts(c.blocklist);
  if (!['null', 'nxdomain', 'refused'].includes(c.dns.blockResponse)) c.dns.blockResponse = 'null';
  return c;
}

export class ConfigStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.config = normalizeConfig({});
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      this.config = normalizeConfig(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Invalid config ${this.file}: ${err.message}`);
      this.config = normalizeConfig({});
      await this.save();
    }
    return this.config;
  }

  // Reads the file without replacing the in-memory config (null if unreadable).
  readSync() {
    try {
      return normalizeConfig(JSON.parse(fsSync.readFileSync(this.file, 'utf8')));
    } catch {
      return null;
    }
  }

  async save() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.config, null, 2)}\n`);
    await fs.rename(tmp, this.file);
  }

  async update(patch) {
    this.config = normalizeConfig(merge(this.config, patch));
    await this.save();
    return this.config;
  }
}

export function parseHostPort(s, defaultPort) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) || /^([^:]+):(\d+)$/.exec(s);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: s, port: defaultPort };
}
