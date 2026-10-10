// Counters, top lists and a ring-buffer query log for the dashboard.

class TopCounter {
  constructor(max = 5000) {
    this.max = max;
    this.map = new Map();
  }

  add(key) {
    this.map.set(key, (this.map.get(key) || 0) + 1);
    if (this.map.size > this.max) {
      // Drop the least frequent half when full.
      const sorted = [...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.floor(this.max / 2));
      this.map = new Map(sorted);
    }
  }

  top(n = 10) {
    return [...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
  }
}

export class Stats {
  constructor(logSize = 2000) {
    this.startedAt = Date.now();
    this.counters = { queries: 0, blocked: 0, cnameBlocked: 0, cached: 0, forwarded: 0, upstreamErrors: 0, proxyBlocked: 0, proxyRequests: 0 };
    this.topBlocked = new TopCounter();
    this.topQueried = new TopCounter();
    this.topClients = new TopCounter(1000);
    this.logSize = logSize;
    this.log = [];
    this.hourly = new Array(24).fill(null).map(() => ({ queries: 0, blocked: 0 }));
    this.hourStamp = Math.floor(Date.now() / 3600e3);
  }

  rollHours() {
    const now = Math.floor(Date.now() / 3600e3);
    while (this.hourStamp < now) {
      this.hourStamp++;
      this.hourly.shift();
      this.hourly.push({ queries: 0, blocked: 0 });
    }
  }

  record(entry) {
    this.rollHours();
    this.counters.queries++;
    this.hourly[23].queries++;
    this.topQueried.add(entry.name);
    this.topClients.add(entry.client);
    if (entry.status === 'blocked' || entry.status === 'cname-blocked') {
      this.counters.blocked++;
      this.hourly[23].blocked++;
      if (entry.status === 'cname-blocked') this.counters.cnameBlocked++;
      this.topBlocked.add(entry.name);
    } else if (entry.status === 'cached') this.counters.cached++;
    else if (entry.status === 'forwarded') this.counters.forwarded++;
    else if (entry.status === 'error') this.counters.upstreamErrors++;
    this.log.push(entry);
    if (this.log.length > this.logSize) this.log.splice(0, this.log.length - this.logSize);
  }

  snapshot() {
    this.rollHours();
    const c = this.counters;
    return {
      ...c,
      blockedPercent: c.queries ? Math.round((c.blocked / c.queries) * 1000) / 10 : 0,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      hourly: this.hourly,
    };
  }

  top(n = 10) {
    return { blocked: this.topBlocked.top(n), queried: this.topQueried.top(n), clients: this.topClients.top(n) };
  }

  recent(limit = 200, filter = '') {
    const f = filter.toLowerCase();
    const out = [];
    for (let i = this.log.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.log[i];
      if (!f || e.name.includes(f) || e.status.includes(f) || e.client.includes(f)) out.push(e);
    }
    return out;
  }
}
