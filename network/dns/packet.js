// DNS wire format (RFC 1035 + EDNS(0) RFC 6891 + Extended DNS Errors RFC 8914).

export const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, SVCB: 64, HTTPS: 65, ANY: 255 };
export const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
export const CLASS_IN = 1;

export class DnsError extends Error {}

export function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  let total = 0;
  for (;;) {
    if (pos >= buf.length) throw new DnsError('name out of bounds');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    const kind = len & 0xc0;
    if (kind === 0xc0) {
      if (pos + 1 >= buf.length) throw new DnsError('bad pointer');
      if (++jumps > 64) throw new DnsError('compression loop');
      if (next === -1) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (kind !== 0) throw new DnsError('bad label type');
    if (pos + 1 + len > buf.length) throw new DnsError('label out of bounds');
    total += len + 1;
    if (total > 255) throw new DnsError('name too long');
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next === -1 ? pos : next };
}

export function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'latin1');
    if (b.length > 63) throw new DnsError('label too long');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function parseRR(buf, offset) {
  const { name, next } = readName(buf, offset);
  if (next + 10 > buf.length) throw new DnsError('rr header out of bounds');
  const type = buf.readUInt16BE(next);
  const klass = buf.readUInt16BE(next + 2);
  const ttlOffset = next + 4;
  const ttl = buf.readUInt32BE(ttlOffset);
  const rdLength = buf.readUInt16BE(next + 8);
  const rdOffset = next + 10;
  if (rdOffset + rdLength > buf.length) throw new DnsError('rdata out of bounds');
  const rr = { name: name.toLowerCase(), type, class: klass, ttl, ttlOffset, rdOffset, rdLength };
  if (type === TYPE.CNAME || type === TYPE.PTR || type === TYPE.NS) {
    rr.data = readName(buf, rdOffset).name.toLowerCase();
  } else if (type === TYPE.A && rdLength === 4) {
    rr.data = [...buf.subarray(rdOffset, rdOffset + 4)].join('.');
  } else if (type === TYPE.AAAA && rdLength === 16) {
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(rdOffset + i).toString(16));
    rr.data = parts.join(':');
  } else if (type === TYPE.SOA) {
    const m = readName(buf, rdOffset);
    const r = readName(buf, m.next);
    if (r.next + 20 <= rdOffset + rdLength) rr.minimum = buf.readUInt32BE(r.next + 16);
  } else if (type === TYPE.OPT) {
    rr.udpSize = klass;
  }
  return { rr, next: rdOffset + rdLength };
}

export function parseMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new DnsError('short message');
  const flags = buf.readUInt16BE(2);
  const msg = {
    id: buf.readUInt16BE(0),
    flags,
    qr: (flags >> 15) & 1,
    opcode: (flags >> 11) & 0xf,
    aa: (flags >> 10) & 1,
    tc: (flags >> 9) & 1,
    rd: (flags >> 8) & 1,
    ra: (flags >> 7) & 1,
    rcode: flags & 0xf,
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  };
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);
  if (qd > 4 || an > 512 || ns > 512 || ar > 512) throw new DnsError('too many records');
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const { name, next } = readName(buf, off);
    if (next + 4 > buf.length) throw new DnsError('question out of bounds');
    msg.questions.push({ name: name.toLowerCase(), type: buf.readUInt16BE(next), class: buf.readUInt16BE(next + 2) });
    off = next + 4;
  }
  msg.questionEnd = off;
  for (const [count, list] of [[an, msg.answers], [ns, msg.authorities], [ar, msg.additionals]]) {
    for (let i = 0; i < count; i++) {
      const { rr, next } = parseRR(buf, off);
      list.push(rr);
      off = next;
    }
  }
  const opt = msg.additionals.find((r) => r.type === TYPE.OPT);
  if (opt) {
    msg.edns = { udpSize: Math.max(512, opt.udpSize), do: (buf.readUInt32BE(opt.ttlOffset) >> 15) & 1 };
  }
  return msg;
}

// Query message (used by tests and the CLI).
export function buildQuery(name, type = TYPE.A, { id = Math.floor(Math.random() * 65536), rd = true, edns = true } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(rd ? 0x0100 : 0, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(edns ? 1 : 0, 10);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(CLASS_IN, 2);
  const parts = [header, encodeName(name), q];
  if (edns) parts.push(optRecord(1232));
  return Buffer.concat(parts);
}

function optRecord(udpSize, options = Buffer.alloc(0)) {
  const rr = Buffer.alloc(11);
  rr[0] = 0; // root name
  rr.writeUInt16BE(TYPE.OPT, 1);
  rr.writeUInt16BE(udpSize, 3);
  rr.writeUInt32BE(0, 5);
  rr.writeUInt16BE(options.length, 9);
  return Buffer.concat([rr, options]);
}

// Extended DNS Error option (RFC 8914): info-code 15 = Blocked, 17 = Filtered
function edeOption(code, text) {
  const t = Buffer.from(text || '', 'utf8');
  const o = Buffer.alloc(6);
  o.writeUInt16BE(15, 0);
  o.writeUInt16BE(2 + t.length, 2);
  o.writeUInt16BE(code, 4);
  return Buffer.concat([o, t]);
}

function responseHeader(query, rcode, counts) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(query.id, 0);
  const flags = 0x8000 | (query.opcode << 11) | (query.rd << 8) | 0x0080 | (rcode & 0xf);
  h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(counts.qd, 4);
  h.writeUInt16BE(counts.an, 6);
  h.writeUInt16BE(counts.ns, 8);
  h.writeUInt16BE(counts.ar, 10);
  return h;
}

function answerRR(type, ttl, rdata) {
  const rr = Buffer.alloc(12);
  rr.writeUInt16BE(0xc00c, 0); // pointer to the question name
  rr.writeUInt16BE(type, 2);
  rr.writeUInt16BE(CLASS_IN, 4);
  rr.writeUInt32BE(ttl, 6);
  rr.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([rr, rdata]);
}

function ipv6Bytes(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return b;
}

// Local answer for a question (A/AAAA with fixed addresses), e.g. sinkhole or localhost.
export function buildAnswer(query, raw, { rcode = RCODE.NOERROR, a = null, aaaa = null, ttl = 10, ede = null } = {}) {
  const q = query.questions[0];
  const answers = [];
  if (rcode === RCODE.NOERROR && q) {
    if (q.type === TYPE.A && a) answers.push(answerRR(TYPE.A, ttl, Buffer.from(a.split('.').map(Number))));
    if (q.type === TYPE.AAAA && aaaa) answers.push(answerRR(TYPE.AAAA, ttl, ipv6Bytes(aaaa)));
  }
  const additional = [];
  if (query.edns) additional.push(optRecord(1232, ede ? edeOption(ede.code, ede.text) : Buffer.alloc(0)));
  const question = q ? raw.subarray(12, query.questionEnd) : Buffer.alloc(0);
  return Buffer.concat([
    responseHeader(query, rcode, { qd: q ? 1 : 0, an: answers.length, ns: 0, ar: additional.length }),
    question,
    ...answers,
    ...additional,
  ]);
}

export function buildError(query, raw, rcode) {
  return buildAnswer(query, raw, { rcode });
}

// Minimal error response when the query itself could not be parsed.
export function buildFormErr(raw) {
  const h = Buffer.alloc(12);
  if (raw.length >= 2) raw.copy(h, 0, 0, 2);
  h.writeUInt16BE(0x8000 | RCODE.FORMERR, 2);
  return h;
}

export function setId(buf, id) {
  const out = Buffer.from(buf);
  out.writeUInt16BE(id, 0);
  return out;
}

// Returns a copy with all TTLs reduced by `elapsed` seconds (OPT records untouched).
export function withAgedTtls(buf, msg, elapsed) {
  const out = Buffer.from(buf);
  for (const rr of [...msg.answers, ...msg.authorities, ...msg.additionals]) {
    if (rr.type === TYPE.OPT) continue;
    out.writeUInt32BE(Math.max(0, rr.ttl - elapsed), rr.ttlOffset);
  }
  return out;
}

// TTL to cache a response for: lowest answer TTL, or SOA minimum for negative answers.
export function cacheTtl(msg) {
  const rrs = msg.answers.filter((r) => r.type !== TYPE.OPT);
  if (rrs.length) return Math.min(...rrs.map((r) => r.ttl));
  const soa = msg.authorities.find((r) => r.type === TYPE.SOA);
  if (soa) return Math.min(soa.ttl, soa.minimum === undefined ? soa.ttl : soa.minimum);
  return 60;
}

// Truncates a UDP response to header + question with TC set, for clients to retry over TCP.
export function truncate(buf, msg) {
  const out = Buffer.from(buf.subarray(0, msg.questionEnd));
  out.writeUInt16BE(out.readUInt16BE(2) | 0x0200, 2);
  out.writeUInt16BE(0, 6);
  out.writeUInt16BE(0, 8);
  out.writeUInt16BE(0, 10);
  return out;
}
