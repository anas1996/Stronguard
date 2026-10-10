// Runs the Stronguard network shield: filter engine + DNS sinkhole + filtering
// proxy + local dashboard, with automatic list updates.

import fs from 'node:fs';
import { ConfigStore } from './config.js';
import { FilterEngine } from './engine.js';
import { Stats } from './stats.js';
import { DnsServer } from './dns/server.js';
import { FilteringProxy } from './proxy/server.js';
import { Dashboard } from './dashboard/server.js';
import { levelInfo } from '../core/levels.js';
import { applyWindowsLayers } from './windows/apply.js';

export class StronguardService {
  constructor({ root, dataDir, log = console.log }) {
    this.root = root;
    this.dataDir = dataDir;
    this.log = (m) => log(`[${new Date().toISOString()}] ${m}`);
    this.store = new ConfigStore(dataDir);
    this.pausedUntil = 0;
    this.timers = [];
  }

  get config() {
    return this.store.config;
  }

  async start({ offline = false } = {}) {
    const config = await this.store.load();
    this.stats = new Stats(config.queryLogSize);
    this.engine = new FilterEngine({ root: this.root, dataDir: this.dataDir, log: this.log });
    // Start from cached lists immediately; refresh from the network in the background.
    await this.engine.load(config, { offline: true });

    if (config.dns.enabled) {
      this.dns = new DnsServer({ config, engine: this.engine, stats: this.stats, log: this.log });
      await this.dns.start();
    }
    if (config.proxy.enabled) {
      this.proxy = new FilteringProxy({ config, engine: this.engine, stats: this.stats, log: this.log });
      await this.proxy.start();
    }
    if (config.dashboard.enabled) {
      this.dashboard = new Dashboard({ service: this, log: this.log });
      await this.dashboard.start();
    }
    this.log(`Stronguard network shield running at level ${config.level} (${levelInfo(config.level).name})`);

    if (!offline) this.refresh(false);
    const hours = Math.max(1, config.updateIntervalHours || 24);
    this.timers.push(setInterval(() => this.refresh(true), hours * 3600e3));
    this.watchConfig();
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    fs.unwatchFile(this.store.file);
    if (this.dns) await this.dns.stop();
    if (this.proxy) this.proxy.stop();
    if (this.dashboard) this.dashboard.stop();
  }

  async refresh(force) {
    try {
      await this.engine.load(this.config, { refresh: force });
      if (this.dns) this.dns.clearCache();
    } catch (err) {
      this.log(`List update failed: ${err.message}`);
    }
  }

  // Picks up edits made by the CLI (e.g. "stronguard level 4") or by hand.
  watchConfig() {
    fs.watchFile(this.store.file, { interval: 2000 }, async () => {
      try {
        const prev = this.config;
        const next = this.store.readSync();
        if (!next || JSON.stringify(next) === JSON.stringify(prev)) return; // our own write, or unreadable
        this.store.config = next;
        if (next.level !== prev.level || JSON.stringify(next.extraLists) !== JSON.stringify(prev.extraLists) || JSON.stringify(next.customRules) !== JSON.stringify(prev.customRules)) {
          this.log(`Configuration changed: level ${next.level}`);
          await this.engine.load(next, {});
          if (next.level !== prev.level) applyWindowsLayers(next, this.log).catch(() => {});
        } else {
          this.engine.setUserLists(next);
        }
        if (this.dns) {
          this.dns.applyConfig(next);
        }
      } catch (err) {
        this.log(`Config reload failed: ${err.message}`);
      }
    });
  }

  async setLevel(level) {
    const config = await this.store.update({ level });
    await this.engine.load(config, {});
    if (this.dns) this.dns.clearCache();
    this.log(`Level set to ${config.level} (${levelInfo(config.level).name})`);
    applyWindowsLayers(config, this.log).catch((err) => this.log(`Windows layers: ${err.message}`));
    return config.level;
  }

  setPaused(minutes) {
    const paused = minutes > 0;
    this.pausedUntil = paused ? Date.now() + minutes * 60e3 : 0;
    if (this.dns) this.dns.paused = paused;
    if (this.proxy) this.proxy.paused = paused;
    clearTimeout(this.pauseTimer);
    if (paused) this.pauseTimer = setTimeout(() => this.setPaused(0), minutes * 60e3);
    if (this.dns) this.dns.clearCache();
    this.log(paused ? `Protection paused for ${minutes} minutes` : 'Protection resumed');
  }

  async editList(kind, action, domain) {
    const d = String(domain || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (!/^[a-z0-9_.-]+\.[a-z0-9-]+$/.test(d)) throw new Error('invalid domain');
    const key = kind === 'allow' ? 'allowlist' : 'blocklist';
    const other = kind === 'allow' ? 'blocklist' : 'allowlist';
    let list = this.config[key].filter((x) => x !== d);
    if (action === 'add') list = [...list, d];
    const config = await this.store.update({ [key]: list, [other]: this.config[other].filter((x) => x !== d) });
    this.engine.setUserLists(config);
    if (this.dns) this.dns.clearCache();
    return { allowlist: config.allowlist, blocklist: config.blocklist };
  }

  status() {
    return {
      version: '1.0.0',
      level: this.config.level,
      levelName: levelInfo(this.config.level).name,
      paused: this.pausedUntil > Date.now(),
      pausedUntil: this.pausedUntil,
      dns: this.dns ? { listen: this.config.dns.listen, upstreams: this.dns.upstream.health(), cacheEntries: this.dns.cache.map.size, cacheHits: this.dns.cache.hits } : null,
      proxy: this.proxy ? { listen: this.config.proxy.listen, pac: `http://${this.proxy.host}:${this.proxy.port}/proxy.pac` } : null,
      stats: this.stats.snapshot(),
      engine: this.engine.summary(),
      allowlist: this.config.allowlist,
      blocklist: this.config.blocklist,
    };
  }
}
