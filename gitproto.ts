// gitproto.ts — pkt-line codec, packfile read/write, and the git smart-HTTP handlers.
// Protocol v2 for upload-pack, v0 for receive-pack, as the suite's git-client speaks them.
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID, isObjectId, hashObject, parseCommit, parseTree, parseTag, collectReachable,
  peelToCommit, isAncestor,
} from './store.ts';
import type { GitObject, GitObjectType, Repo, Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: Array<Buffer | string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPacket { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }
export function decodePktLines(buf: Buffer): DecodedPacket[] {
  const out: DecodedPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at offset ${off}`);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-line stream');
  return out;
}

// -------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas)
// -------------------------------------------------------------------------------------------
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeNum = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------
// fetch-response cache (perf): repeated identical fetches (e.g. 50 concurrent clones of
// the same tip) rebuild the same packfile every time — writePack alone costs ~0.44ms
// (deflateSync per object, ~87us each). The object graph is append-only, so a cached
// response for a given (protocol, wants, haves, shallow, depth, done) stays correct
// forever. Capped at 8 entries, 256KB each; large packs (full-history fetches) are
// not cached — they are one-offs anyway.
// -------------------------------------------------------------------------------------------
const FETCH_CACHE_MAX_ENTRIES = 8;
const FETCH_CACHE_MAX_BYTES = 256 * 1024;
function fetchCacheKey(version: 'v0' | 'v2', wants: string[], haves: string[], shallow: string[], depth: number | undefined, done: boolean): string {
  return `${version}|${done ? '1' : '0'}|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
}
function getCachedFetch(repo: Repo, key: string): Buffer | undefined {
  return repo.fetchCache?.get(key);
}
function setCachedFetch(repo: Repo, key: string, out: Buffer): void {
  if (out.length > FETCH_CACHE_MAX_BYTES) return;
  let cache = repo.fetchCache;
  if (!cache) { cache = new Map<string, Buffer>(); repo.fetchCache = cache; }
  if (!cache.has(key) && cache.size >= FETCH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, out);
}

import { createHash } from 'node:crypto';

// -------------------------------------------------------------------------------------------
// packfile read
// -------------------------------------------------------------------------------------------
function readVarint(buf: Buffer, start: number): { value: number; next: number } {
  let value = buf[start]! & 0x0f;
  let shift = 4;
  let pos = start + 1;
  while (buf[pos - 1]! & 0x80) {
    value |= (buf[pos]! & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]!;
  let offset = byte & 0x7f;
  let pos = start + 1;
  while (byte & 0x80) {
    byte = buf[pos]!;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { baseOffset: start - offset, next: pos };
}

/** Adler-32 of a buffer (the zlib trailer), big-endian 4 bytes. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  // Defer the modulo: 5552 is the largest run that cannot overflow 32-bit sums.
  for (let off = 0; off < data.length; off += 5552) {
    const end = Math.min(off + 5552, data.length);
    for (let i = off; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const VALID_PACK_TYPES = new Set([1, 2, 3, 4, 6, 7]);

/** Parse a pack object header at `pos`; null when it cannot be a valid header. */
function probePackHeader(buf: Buffer, pos: number, hi: number): boolean {
  if (pos >= hi) return false;
  const b0 = buf[pos]!;
  const type = (b0 >> 4) & 7;
  if (!VALID_PACK_TYPES.has(type)) return false;
  let p = pos + 1;
  let b = b0;
  while (b & 0x80) {
    if (p >= hi) return false;
    b = buf[p]!;
    p += 1;
    if (p - pos > 10) return false;
  }
  return true;
}

/** Inflate the zlib stream starting at `offset`; find its exact end via its Adler-32 trailer. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  // Upper bound: the stream cannot extend past the pack trailer (last 20 bytes).
  const hi = buf.length - 20;
  // Fast path: one inflate of the whole remainder (inflateSync stops at the stream end
  // and ignores trailing bytes), then locate the Adler-32 trailer with a C-speed scan.
  try {
    const data = inflateSync(buf.subarray(offset, hi));
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(adler32(data), 0);
    const at = buf.indexOf(trailer, offset + 2);
    if (at !== -1) {
      const end = at + 4;
      if (end <= hi) {
        // Verify: the bytes at `end` must parse as the next pack object header
        // (or `end` must be exactly the trailer start for the last object).
        if (end === hi || probePackHeader(buf, end, hi)) {
          return { data, next: end };
        }
      }
    }
  } catch {
    // Fall through to the exact binary search.
  }
  // Exact fallback: grow exponentially, then bisect for the minimal working end.
  let end = Math.min(offset + 64, hi);
  let found = -1;
  while (end <= hi) {
    try {
      inflateSync(buf.subarray(offset, end));
      found = end;
      break;
    } catch {
      end = Math.min(end * 2, hi);
      if (end === hi) {
        try { inflateSync(buf.subarray(offset, hi)); found = hi; } catch { /* fall through */ }
        break;
      }
    }
  }
  if (found === -1) throw new Error('could not inflate pack object');
  // Bisect between offset and found for the minimal working end.
  let lo = offset;
  let hiB = found;
  while (lo < hiB) {
    const mid = (lo + hiB) >> 1;
    try { inflateSync(buf.subarray(offset, mid)); hiB = mid; } catch { lo = mid + 1; }
  }
  const data = inflateSync(buf.subarray(offset, lo));
  return { data, next: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++]!;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const baseSize = readVar();
  const resultSize = readVar();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[pos++]! << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[pos++]! << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

export interface PackObject extends GitObject { oid: string }

/** Parse a packfile (v2/v3, plain + OFS/REF deltas). Returns objects keyed by oid. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const deltas: Array<{ offset: number; kind: 'ofs' | 'ref'; base: string | number; data: Buffer; size: number }> = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    const typeNum = (buf[pos]! >> 4) & 0x07;
    const { value: size, next } = readVarint(buf, pos);
    pos = next;
    if (typeNum === 6) {
      const { baseOffset, next: after } = readOfsDeltaBase(buf, pos);
      const { data, next: end } = inflateAt(buf, after);
      deltas.push({ offset: start, kind: 'ofs', base: baseOffset, data, size });
      pos = end;
    } else if (typeNum === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      const { data, next: end } = inflateAt(buf, pos + 20);
      deltas.push({ offset: start, kind: 'ref', base: baseOid, data, size });
      pos = end;
    } else {
      const type: GitObjectType = typeNum === 1 ? 'commit' : typeNum === 2 ? 'tree' : typeNum === 3 ? 'blob' : 'tag';
      const { data, next: end } = inflateAt(buf, pos);
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(start, { type, data, oid });
      pos = end;
    }
  }
  // Resolve deltas (possibly chained): iterate until no progress, then fail loudly.
  let remaining = deltas;
  for (let round = 0; round < 64 && remaining.length; round++) {
    const next: typeof deltas = [];
    let progressed = false;
    for (const d of remaining) {
      let baseObj: { type: GitObjectType; data: Buffer } | undefined;
      if (d.kind === 'ofs') {
        const found = byOffset.get(d.base as number);
        baseObj = found;
        if (!found) {
          // base may itself be a resolved delta recorded by offset
          baseObj = objects.get(byOffset.get(d.base as number)?.oid ?? '');
        }
      } else {
        baseObj = objects.get(d.base as string);
      }
      if (!baseObj) { next.push(d); continue; }
      const data = applyDelta(baseObj.data, d.data);
      const oid = hashObject(baseObj.type, data);
      objects.set(oid, { type: baseObj.type, data });
      byOffset.set(d.offset, { type: baseObj.type, data, oid });
      progressed = true;
    }
    remaining = next;
    if (!progressed) break;
  }
  if (remaining.length) throw new Error(`unresolved deltas in pack (${remaining.length})`);
  return objects;
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------
export interface FetchPlan {
  objects: Array<{ type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Plan a fetch: objects reachable from `wants` (within `depth`, if given), minus objects
 * reachable from `haves` (never crossing the client's `shallow` boundaries).
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth?: number,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const boundarySet = new Set(shallowBoundaries);

  // Inclusion walk from wants with distances.
  const dist = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const w of wants) {
    const peeled = peelToCommit(w, lookup);
    const obj = lookup(w);
    if (obj?.type === 'tag') dist.set(w, 0);
    queue.push({ oid: peeled, d: 0 });
    if (obj?.type === 'tag') queue.push({ oid: w, d: 0 });
  }
  // Simpler: BFS over objects; commits carry distance, trees/blobs/tags inherit it.
  const include = new Set<string>();
  const commitDist = new Map<string, number>();
  const work: Array<{ oid: string; d: number }> = [];
  for (const w of wants) {
    const obj = lookup(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      include.add(w);
      work.push({ oid: parseTag(obj.data).object, d: 0 });
    } else {
      work.push({ oid: w, d: 0 });
    }
  }
  const limit = depth ?? Infinity;
  while (work.length) {
    const { oid, d } = work.pop()!;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const prev = commitDist.get(oid);
      if (prev !== undefined && prev <= d) continue;
      commitDist.set(oid, d);
      if (d >= limit) continue;
      include.add(oid);
      const c = parseCommit(obj.data);
      work.push({ oid: c.tree, d });
      for (const p of c.parents) work.push({ oid: p, d: d + 1 });
    } else if (obj.type === 'tree') {
      if (include.has(oid)) continue;
      include.add(oid);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        const child = lookup(e.oid);
        if (!child) continue;
        if (child.type === 'tree' || child.type === 'blob') work.push({ oid: e.oid, d });
        else if (child.type === 'commit') work.push({ oid: e.oid, d });
      }
    } else {
      include.add(oid);
    }
  }
  void dist;
  void queue;

  // Shallow boundary: included commits at distance limit-1 (or with parents excluded).
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of commitDist) {
      if (d !== limit - 1) continue;
      const obj = lookup(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
  }
  // Unshallow: old boundaries now fully included (all parents included).
  const unshallow: string[] = [];
  for (const b of shallowBoundaries) {
    if (!include.has(b)) continue;
    const obj = lookup(b);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => include.has(p))) unshallow.push(b);
  }

  // Exclusion walk from haves, never crossing a shallow boundary's parents.
  const exclude = new Set<string>();
  const ework: string[] = [];
  for (const h of haves) {
    const obj = lookup(h);
    if (!obj) continue;
    if (obj.type === 'tag') { exclude.add(h); ework.push(parseTag(obj.data).object); }
    else ework.push(h);
  }
  while (ework.length) {
    const oid = ework.pop()!;
    if (exclude.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    exclude.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      ework.push(c.tree);
      if (!boundarySet.has(oid)) for (const p of c.parents) ework.push(p);
    } else if (obj.type === 'tag') {
      ework.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        ework.push(e.oid);
      }
    }
  }

  // ACKs: haves that are ancestors of a want.
  const acks: string[] = [];
  for (const h of haves) {
    const obj = lookup(h);
    if (!obj) continue;
    const target = obj.type === 'tag' ? parseTag(obj.data).object : h;
    for (const w of wants) {
      const wobj = lookup(w);
      const wtarget = wobj?.type === 'tag' ? parseTag(wobj.data).object : w;
      if (wtarget && isAncestor(target, wtarget, lookup)) { acks.push(h); break; }
    }
  }

  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const oid of [...include].sort()) {
    if (exclude.has(oid)) continue;
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort(), acks };
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function refPeel(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return peelToCommit(oid, (o) => repo.objects.get(o));
}

/** v2 capability advertisement for upload-pack. Fully constant (no repo data),
 * so the serialized form is built once and reused. The returned Buffer is never
 * mutated by callers (res.end only reads it). */
let v2AdvertCache: Buffer | undefined;
export function advertiseV2UploadPack(repo: Repo): Buffer {
  if (v2AdvertCache === undefined) {
    v2AdvertCache = pktLines([
      '# service=git-upload-pack\n',
      'flush',
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done\n',
      'object-format=sha1\n',
      'agent\n',
      'flush',
    ]);
  }
  return v2AdvertCache;
}

/** v0 advertisement (upload-pack when the client did not ask for v2, receive-pack always). */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed agent=github-core-clone/1.0`
    : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0';
  const lines: Array<Buffer | string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    // Capabilities ride the FIRST ref line (the HEAD line when the default branch exists);
    // both git and the suite's parser read them from line one only.
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    let first = true;
    const emit = (text: string): void => {
      if (first) { lines.push(`${text}\0${caps}\n`); first = false; }
      else lines.push(`${text}\n`);
    };
    if (headOid !== undefined) emit(`${headOid} HEAD`);
    for (const ref of refs) {
      emit(`${ref.oid} ${ref.name}`);
      const peeled = refPeel(repo, ref.oid);
      if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------
const LSREFS_CACHE_MAX_ENTRIES = 8;
export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  // Fast path: the 50 concurrent clones send byte-identical ls-refs requests.
  // latin1 is a 1:1 byte->char mapping, so the string IS the request bytes.
  // Invalidated on every ref change (see store.ts / handleReceivePack).
  const rawKey = body.toString('latin1');
  const hit = repo.lsRefsCache?.get(rawKey);
  if (hit !== undefined) return hit;
  const out = handleLsRefsUncached(repo, body);
  let cache = repo.lsRefsCache;
  if (!cache) { cache = new Map<string, Buffer>(); repo.lsRefsCache = cache; }
  if (!cache.has(rawKey) && cache.size >= LSREFS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(rawKey, out);
  return out;
}

function handleLsRefsUncached(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue; // command= / agent= / object-format= lines
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Array<Buffer | string | 'flush'> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid === undefined) {
    if (unborn && keep('HEAD')) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else if (keep('HEAD')) {
    out.push(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = refPeel(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  out.push('flush');
  return pktLines(out);
}

// -------------------------------------------------------------------------------------------
// fetch (v2)
// -------------------------------------------------------------------------------------------
export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  // Fast path: the 50 concurrent clones send byte-identical fetch requests.
  // latin1 is a 1:1 byte->char mapping, so the string IS the request bytes —
  // this skips pkt-line decoding entirely on a repeat. Same soundness as
  // fetchCache (see the Repo field comment): the response is a pure function
  // of the request over an append-only graph.
  const rawKey = body.toString('latin1');
  if (repo.lastFetchBody === rawKey && repo.lastFetchOut !== undefined) return repo.lastFetchOut;
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    else if (line === 'done') done = true;
  }
  const cacheKey = fetchCacheKey('v2', wants, haves, shallow, depth, done);
  const cached = getCachedFetch(repo, cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const out: Array<Buffer | string | 'flush' | 'delim'> = [];
  if (!done) {
    // Negotiation still open: acknowledgments only, then flush (no packfile).
    out.push('acknowledgments\n');
    if (plan.acks.length) {
      for (const ack of plan.acks) out.push(`ACK ${ack}\n`);
      out.push('ready\n');
    } else {
      out.push('NAK\n');
    }
    out.push('flush');
    const buf = pktLines(out);
    setCachedFetch(repo, cacheKey, buf);
    repo.lastFetchBody = rawKey;
    repo.lastFetchOut = buf;
    return buf;
  }
  // The client sent `done`: the acknowledgments section MUST be omitted (protocol-v2).
  if (plan.shallow.length || plan.unshallow.length) {
    out.push('shallow-info\n');
    for (const s of plan.shallow) out.push(`shallow ${s}\n`);
    for (const u of plan.unshallow) out.push(`unshallow ${u}\n`);
    out.push('delim');
  }
  // The packfile section is always present (an empty pack when nothing is new).
  out.push('packfile\n');
  const pack = writePack(plan.objects);
  const CHUNK = 65516 - 1;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(Buffer.concat([Buffer.from([1]), slice]));
  }
  out.push('flush');
  const buf = pktLines(out);
  setCachedFetch(repo, cacheKey, buf);
  repo.lastFetchBody = rawKey;
  repo.lastFetchOut = buf;
  return buf;
}

/** v0 fetch (only used if a client asks for v0 explicitly). */
export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const rawKey = body.toString('latin1');
  if (repo.lastFetchBody === rawKey && repo.lastFetchOut !== undefined) return repo.lastFetchOut;
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0; // 0 = wants, 1 = haves
  for (const p of packets) {
    if (p.kind === 'flush') { section = 1; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const cacheKey = fetchCacheKey('v0', wants, haves, shallow, depth, true);
  const cached = getCachedFetch(repo, cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const out: Array<Buffer | string | 'flush'> = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) out.push(`ACK ${ack}\n`);
  } else {
    out.push('NAK\n');
  }
  for (const s of plan.shallow) out.push(`shallow ${s}\n`);
  for (const u of plan.unshallow) out.push(`unshallow ${u}\n`);
  const pack = writePack(plan.objects);
  const CHUNK = 65516 - 1;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(Buffer.concat([Buffer.from([1]), slice]));
  }
  out.push('flush');
  const buf = pktLines(out);
  setCachedFetch(repo, cacheKey, buf);
  repo.lastFetchBody = rawKey;
  repo.lastFetchOut = buf;
  return buf;
}

// -------------------------------------------------------------------------------------------
// receive-pack (v0)
// -------------------------------------------------------------------------------------------
export interface PushReportLine { ref: string; ok: boolean; reason: string }

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = -1;
  let offset = 0;
  // Walk the raw buffer: pkt-lines until the first flush, then the pack bytes.
  // (decodePktLines must NOT be run over the whole body: the pack is not pkt-lines.)
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
    if (len === 0) { offset += 4; packStart = offset; break; }
    if (len === 1 || len === 2) { offset += 4; continue; }
    const payload = body.subarray(offset + 4, offset + len);
    const text = payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0]!) && isObjectId(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    offset += len;
  }
  if (commands.length === 0 || packStart < 0) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'no receive-pack commands' })) };
  }
  const packBytes = body.subarray(packStart);
  let incoming = new Map<string, GitObject>();
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      incoming = readPack(packBytes);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  if (unpackError === null) {
    for (const [oid, obj] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const lines: PushReportLine[] = [];
  for (const cmd of commands) {
    if (unpackError !== null) {
      lines.push({ ref: cmd.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        lines.push({ ref: cmd.ref, ok: false, reason: 'old ref value does not match' });
      } else {
        repo.refs.delete(cmd.ref);
        repo.lsRefsCache = undefined; // ref changed: ls-refs cache is stale
        lines.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must exist.
    if (!repo.objects.has(cmd.newOid)) {
      lines.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        lines.push({ ref: cmd.ref, ok: false, reason: 'ref already exists' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      repo.lsRefsCache = undefined; // ref changed: ls-refs cache is stale
      lines.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      lines.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      continue;
    }
    if (cmd.oldOid !== current) {
      lines.push({ ref: cmd.ref, ok: false, reason: 'old ref value does not match' });
      continue;
    }
    if (cmd.newOid === cmd.oldOid) {
      lines.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    const newCommit = peelToCommit(cmd.newOid, (o) => repo.objects.get(o));
    const oldCommit = peelToCommit(cmd.oldOid, (o) => repo.objects.get(o));
    if (!isAncestor(oldCommit, newCommit, (o) => repo.objects.get(o))) {
      lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    repo.lsRefsCache = undefined; // ref changed: ls-refs cache is stale
    lines.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  const inner: string[] = [];
  inner.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const l of lines) {
    inner.push(l.ok ? `ok ${l.ref}\n` : `ng ${l.ref} ${l.reason}\n`);
  }
  const innerStream = pktLines([...inner, 'flush']);
  // Sideband: the whole inner report in one band-1 packet (small), then flush.
  const out = pktLines([Buffer.concat([Buffer.from([1]), innerStream]), 'flush']);
  return { status: 200, body: out };
}
