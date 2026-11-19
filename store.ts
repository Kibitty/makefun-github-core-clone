// store.ts — in-memory forge state, git object model, and the scenario PRNG.
// Determinism: no wall clock, no Math.random anywhere in this file. All timestamps come
// from MAKEFUN_TRIAL_NOW (or a fixed fallback epoch). Ids are assigned in creation order.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const DEFAULT_BRANCH = 'main';
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer }
export interface TreeEntry { mode: string; name: string; oid: string }

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(v: string): boolean { return HEX40.test(v); }

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string; parents: string[]; author: string; committer: string; message: string;
}

// Commit objects are immutable once stored (append-only object graph), and every
// parseCommit caller only reads .tree/.parents/.author/.committer/.message, so the
// parsed view can be memoized per data Buffer. Keyed by object identity: callers
// always pass the exact Buffer held in repo.objects.
const commitViewCache = new WeakMap<Buffer, CommitView>();

export function parseCommit(data: Buffer): CommitView {
  const cached = commitViewCache.get(data);
  if (cached !== undefined) return cached;
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  const view: CommitView = { tree, parents, author, committer, message };
  commitViewCache.set(data, view);
  return view;
}

export function buildCommit(o: {
  tree: string; parents?: string[]; message: string;
  author: string; committer: string; timestamp: number; timezone?: string;
}): Buffer {
  const tz = o.timezone ?? '+0000';
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${o.author} ${o.timestamp} ${tz}`, `committer ${o.committer} ${o.timestamp} ${tz}`, '');
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

export interface TagView { object: string; type: string; tag: string; tagger: string; message: string }

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, blank < 0 ? data.length : blank).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(o: {
  object: string; type: GitObjectType; tag: string; message: string; tagger: string; timestamp: number;
}): Buffer {
  return Buffer.from(
    `object ${o.object}\ntype ${o.type}\ntag ${o.tag}\ntagger ${o.tagger} ${o.timestamp} +0000\n\n${o.message}`,
    'utf8',
  );
}

/** Every object reachable from roots (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isObjectId(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

/** Peel a tag (transitively) to its commit, or return the oid unchanged. */
export function peelToCommit(
  oid: string,
  lookup: (oid: string) => GitObject | undefined,
): string {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = lookup(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(
  ancestor: string,
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return false;
}

/** First common ancestor of two commits (BFS from both sides, head side first). */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  const ancestorsA = new Set<string>();
  const qa = [peelToCommit(a, lookup)];
  while (qa.length) {
    const oid = qa.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = lookup(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push(p);
  }
  const qb = [peelToCommit(b, lookup)];
  const seenB = new Set<string>();
  while (qb.length) {
    const oid = qb.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = lookup(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push(p);
  }
  return null;
}

/** Flatten a tree (recursively) to path -> {oid, mode}. */
export function flattenTree(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Three-way merge of trees. Returns the merged flat map, or null when both sides changed
 * the same path differently relative to the base (a conflict).
 */
export function threeWayMerge(
  baseTree: string,
  headTree: string,
  otherTree: string,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, { oid: string; mode: string }> | null {
  const base = flattenTree(baseTree, lookup);
  const head = flattenTree(headTree, lookup);
  const other = flattenTree(otherTree, lookup);
  const out = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys(), ...other.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const o = other.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
      (x?.oid ?? null) === (y?.oid ?? null);
    if (same(h, o)) {
      if (h) out.set(path, h);
    } else if (same(b, o)) {
      if (h) out.set(path, h);
    } else if (same(b, h)) {
      if (o) out.set(path, o);
    } else {
      return null; // both sides changed it differently
    }
  }
  return out;
}

/** Build nested tree objects from a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(
  flat: Map<string, { oid: string; mode: string }>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort()) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** Line counts for a naive diff: additions/deletions between two blob contents. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldData !== null && oldData.length > 0 && oldData[oldData.length - 1] === 0x0a) oldLines.pop();
  if (newData !== null && newData.length > 0 && newData[newData.length - 1] === 0x0a) newLines.pop();
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  const newCount = new Map<string, number>();
  for (const l of newLines) newCount.set(l, (newCount.get(l) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [l, n] of newCount) additions += Math.max(0, n - (oldCount.get(l) ?? 0));
  for (const [l, n] of oldCount) deletions += Math.max(0, n - (newCount.get(l) ?? 0));
  return { additions, deletions };
}

// ---------------------------------------------------------------------------------------------
// The scenario PRNG (vendored from the kit's wire.ts: the scenario is fixed by SCENARIO_SEED,
// so the viewer/stranger logins are the same in every trial). Used only to learn the token
// owner's login; no scenario data is sent anywhere.
// ---------------------------------------------------------------------------------------------
const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & U64_MASK;
  }
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  private state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(arr: readonly T[]): T { return arr[this.nextInt(arr.length)]!; }
}
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

export interface ScenarioUser { id: number; login: string; name: string; email: string }

/** Derive the scenario's users from the fixed seed (wire.ts buildScenario, users stream). */
export function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let login = `${first}${last}`;
    let suffix = 2;
    while (used.has(login)) { login = `${first}${last}-${suffix}`; suffix += 1; }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// ---------------------------------------------------------------------------------------------
// The forge store
// ---------------------------------------------------------------------------------------------
export interface Comment {
  id: number; nodeId: string; body: string; createdSeq: number;
  author: string; authorId: number; createdAt: string; updatedAt: string;
  repo: string; number: number;
}
export interface Issue {
  number: number; id: number; nodeId: string; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; comments: Comment[];
  createdSeq: number; closedAt: string | null;
  author: string; authorId: number; createdAt: string; updatedAt: string; repo: string;
  // Perf: cached serialized REST representation of this issue (single-issue GET).
  // MUST be cleared at every Issue mutation site (REST PATCH, Store.addComment,
  // GraphQL closeIssue) or a stale body will be served.
  jsonCache?: { host: string; payload: Buffer };
}
export interface Label { name: string; color: string; description: string }
export interface Pull {
  number: number; id: number; nodeId: string; title: string; body: string;
  state: 'open' | 'closed'; headRef: string; baseRef: string;
  headSha: string | null; baseSha: string | null;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  createdSeq: number; closedAt: string | null;
  author: string; authorId: number; createdAt: string; updatedAt: string; repo: string;
}
export interface Repo {
  name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; dbId: number; nodeId: string; createdSeq: number;
  id: number; ownerId: number; createdAt: string; updatedAt: string; pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>; nextIssue: number;
  labels: Map<string, Label>;
  pulls: Map<number, Pull>; nextPull: number;
  nextCommentId: number;
  // Perf: cache of complete upload-pack fetch responses (v0/v2), keyed by the
  // full fetch request. The object graph is append-only, so a cached response
  // for a given key stays correct forever; capped and size-limited (see gitproto.ts).
  fetchCache?: Map<string, Buffer>;
  // Perf: 1-entry fast path in front of fetchCache — the raw request bytes are
  // the key, so a repeat identical fetch skips pkt-line decoding entirely.
  // Same soundness as fetchCache: the response is a pure function of the request
  // over an append-only graph (new objects are descendants, never ancestors of
  // the wants, so reachability from old wants is unchanged).
  lastFetchBody?: string;
  lastFetchOut?: Buffer;
  // Perf: ls-refs response cache, keyed by raw request bytes. MUST be cleared at
  // every ref mutation site (receive-pack, commitFile, createRef, squashMerge)
  // or ls-refs will serve stale refs. Peel targets are immutable, so ref changes
  // are the only invalidation trigger.
  lsRefsCache?: Map<string, Buffer>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDbId = 1;
  nextIssueDbId = 1;
  nextCommentDbId = 1;
  nextPullDbId = 1;
  seq = 0;
  requestCounter = 0;
  readonly viewer: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly token: string;
  readonly authHeader: string; // precomputed `Bearer <token>` (per-request template alloc avoided)
  readonly trialNowSec: number;
  readonly trialNowIso: string;

  constructor() {
    const users = scenarioUsers();
    this.viewer = users[0]!;
    this.stranger = users[2]!;
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    this.authHeader = this.token === '' ? '' : `Bearer ${this.token}`;
    const nowRaw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = nowRaw === '' ? NaN : Date.parse(nowRaw) / 1000;
    this.trialNowSec = Number.isFinite(parsed) ? Math.floor(parsed) : 1700000000;
    this.trialNowIso = new Date(this.trialNowSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nextSeq(): number { this.seq += 1; return this.seq; }
  nextRequestId(): string { this.requestCounter += 1; return `req-${this.requestCounter}`; }
  nowIso(): string { return this.trialNowIso; }
  viewerLogin(): string { return this.viewer.login; }
  viewerId(): number { return this.viewer.id; }
  viewerNodeId(): string { return globalId('User', this.viewer.login); }
  viewerName(): string { return this.viewer.name; }
  viewerEmail(): string { return this.viewer.email; }
  strangerLogin(): string { return this.stranger.login; }

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.repoKey(owner, name)); }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo {
    const dbId = this.nextDbId++;
    const repo: Repo = {
      name, owner, description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main', dbId,
      nodeId: globalId('Repository', `${owner}/${name}`),
      createdSeq: this.nextSeq(),
      id: dbId, ownerId: this.viewer.id,
      createdAt: this.trialNowIso, updatedAt: this.trialNowIso, pushedAt: this.trialNowIso,
      objects: new Map(), refs: new Map(),
      issues: new Map(), nextIssue: 1,
      labels: new Map(), pulls: new Map(), nextPull: 1, nextCommentId: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.repoKey(owner, name)); }

  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === this.viewer.login)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined { return repo.objects.get(oid); }

  /** Identity line for commits/tags the entry itself writes. */
  identity(): string { return `${this.viewer.name} <${this.viewer.email}>`; }

  /**
   * Create a commit on `branch` (creating the branch from the default branch tip when it
   * does not exist yet, or unborn when the repo has no commits). `change` maps path -> new
   * blob bytes, or null to delete the path. Returns the new commit oid.
   */
  commitFile(
    repo: Repo,
    branch: string,
    message: string,
    change: Map<string, Buffer | null>,
  ): string {
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      tip = baseTip; // undefined when the repo is unborn
    }
    let flat = new Map<string, { oid: string; mode: string }>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      flat = flattenTree(commit.tree, (oid) => repo.objects.get(oid));
      parents.push(tip);
    }
    for (const [path, bytes] of change) {
      if (bytes === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject(repo, 'blob', bytes), mode: '100644' });
    }
    const treeOid = buildTreeFromFlat(flat, (t, d) => this.putObject(repo, t, d));
    const commitData = buildCommit({
      tree: treeOid, parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.identity(), committer: this.identity(), timestamp: this.trialNowSec,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.lsRefsCache = undefined; // ref changed: ls-refs cache is stale
    return commitOid;
  }

  /** Commits reachable from `tip` (a branch name, ref, or sha), newest-first (DFS pre-order). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const resolved = repo.refs.get(`refs/heads/${tip}`) ?? repo.refs.get(tip) ?? tip;
    const stack = [peelToCommit(resolved, (oid) => repo.objects.get(oid))];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const c = parseCommit(obj.data);
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]!);
    }
    return out;
  }

  /** GitHub-shaped commit objects for GET /commits (newest first). */
  listCommitObjects(repo: Repo, tip: string): Array<Record<string, unknown>> {
    return this.listCommits(repo, tip).map((oid) => this.commitJson(repo, oid));
  }

  /** One commit as GitHub's REST shape: {sha, commit:{message, author, committer, tree}, ...}. */
  commitJson(repo: Repo, oid: string): Record<string, unknown> {
    const obj = repo.objects.get(oid);
    const view = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
    const person = (line: string): { name: string; email: string; date: string } => {
      const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (!m) return { name: line, email: '', date: this.trialNowIso };
      return { name: m[1]!, email: m[2]!, date: new Date(parseInt(m[3]!, 10) * 1000).toISOString() };
    };
    const message = view ? view.message.replace(/\n$/, '') : '';
    return {
      sha: oid,
      commit: {
        message,
        author: person(view?.author ?? ''),
        committer: person(view?.committer ?? ''),
        tree: { sha: view?.tree ?? '' },
      },
      author: { login: this.viewer.login, id: this.viewer.id },
      committer: { login: this.viewer.login, id: this.viewer.id },
      parents: (view?.parents ?? []).map((sha) => ({ sha })),
      url: '',
      html_url: '',
    };
  }

  /** Branches of a repo, in ref order. */
  listBranches(repo: Repo): Array<{ name: string; commit: { sha: string }; protected: boolean }> {
    const out: Array<{ name: string; commit: { sha: string }; protected: boolean }> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    return out;
  }

  /** Create a ref; false when it already exists or the object is missing. */
  createRef(repo: Repo, ref: string, sha: string): boolean {
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    repo.lsRefsCache = undefined; // ref changed: ls-refs cache is stale
    return true;
  }

  /** Whether merging head into base would conflict (three-way, against the merge-base). */
  prMergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    if (headTip === baseTip) return 'MERGEABLE';
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return 'UNKNOWN';
    const headTree = parseCommit(repo.objects.get(peelToCommit(headTip, (o) => repo.objects.get(o)))!.data).tree;
    const baseTree = parseCommit(repo.objects.get(peelToCommit(baseTip, (o) => repo.objects.get(o)))!.data).tree;
    const mergeBaseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const merged = threeWayMerge(mergeBaseTree, headTree, baseTree, (oid) => repo.objects.get(oid));
    return merged === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the squash commit oid,
   * or null when the merge conflicts.
   */
  squashMerge(repo: Repo, pr: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return null;
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return null;
    const headTree = parseCommit(repo.objects.get(peelToCommit(headTip, (o) => repo.objects.get(o)))!.data).tree;
    const baseTree = parseCommit(repo.objects.get(peelToCommit(baseTip, (o) => repo.objects.get(o)))!.data).tree;
    const mergeBaseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const merged = threeWayMerge(mergeBaseTree, headTree, baseTree, (oid) => repo.objects.get(oid));
    if (merged === null) return null;
    const treeOid = buildTreeFromFlat(merged, (t, d) => this.putObject(repo, t, d));
    const commitData = buildCommit({
      tree: treeOid, parents: [baseTip],
      message: `${pr.title} (#${pr.number})\n`,
      author: this.identity(), committer: this.identity(), timestamp: this.trialNowSec,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
    repo.lsRefsCache = undefined; // ref changed: ls-refs cache is stale
    return commitOid;
  }

  /** Changed files between the base tip tree and the head tip tree of a pull request. */
  prFiles(repo: Repo, pr: Pull): Array<{
    filename: string; status: string; additions: number; deletions: number; changes: number;
  }> {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const headTree = parseCommit(repo.objects.get(peelToCommit(headTip, (o) => repo.objects.get(o)))!.data).tree;
    const baseTree = parseCommit(repo.objects.get(peelToCommit(baseTip, (o) => repo.objects.get(o)))!.data).tree;
    const head = flattenTree(headTree, (oid) => repo.objects.get(oid));
    const base = flattenTree(baseTree, (oid) => repo.objects.get(oid));
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      const oldData = b ? repo.objects.get(b.oid)?.data ?? null : null;
      const newData = h ? repo.objects.get(h.oid)?.data ?? null : null;
      const { additions, deletions } = lineDiff(oldData, newData);
      out.push({
        filename: path,
        status: !b ? 'added' : !h ? 'removed' : 'modified',
        additions, deletions, changes: additions + deletions,
      });
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // Contents API
  // -----------------------------------------------------------------------------------------
  private tipTree(repo: Repo, branch: string): { treeOid: string; tip: string } | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return null;
    const commit = repo.objects.get(peelToCommit(tip, (o) => repo.objects.get(o)));
    if (!commit || commit.type !== 'commit') return null;
    return { treeOid: parseCommit(commit.data).tree, tip };
  }

  getContent(repo: Repo, path: string, branch: string): {
    kind: 'file'; content: string; sha: string; size: number;
  } | {
    kind: 'dir'; items: Array<{ type: string; name: string; path: string; sha: string; size?: number }>;
  } | null {
    const resolved = this.tipTree(repo, branch);
    if (!resolved) return null;
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    if (path === '' || path === '/') {
      const flat = flattenTree(resolved.treeOid, lookup);
      const items = new Map<string, { type: string; name: string; path: string; sha: string; size?: number }>();
      for (const [p, e] of flat) {
        const seg = p.split('/')[0]!;
        if (!items.has(seg)) {
          const isDir = p.includes('/');
          items.set(seg, { type: isDir ? 'dir' : 'file', name: seg, path: seg, sha: e.oid, size: isDir ? undefined : repo.objects.get(e.oid)?.data.length ?? 0 });
        }
      }
      // Directory shas must be the tree oids, not a child blob oid.
      const tree = parseTree(repo.objects.get(resolved.treeOid)!.data);
      for (const e of tree) {
        const item = items.get(e.name);
        if (item) item.sha = e.oid;
      }
      return { kind: 'dir', items: [...items.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
    }
    const segs = path.split('/');
    let treeOid = resolved.treeOid;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const entries = parseTree(repo.objects.get(treeOid)!.data);
      const entry = entries.find((e) => e.name === seg);
      if (!entry) return null;
      if (i === segs.length - 1) {
        const obj = repo.objects.get(entry.oid);
        if (!obj) return null;
        if (obj.type === 'blob') {
          return { kind: 'file', content: obj.data.toString('base64'), sha: entry.oid, size: obj.data.length };
        }
        if (obj.type === 'tree') {
          const items = parseTree(obj.data).map((e) => {
            const child = repo.objects.get(e.oid);
            return {
              type: e.mode === '40000' ? 'dir' : 'file', name: e.name,
              path: `${path}/${e.name}`, sha: e.oid,
              size: e.mode === '40000' ? undefined : child?.data.length ?? 0,
            };
          });
          return { kind: 'dir', items };
        }
        return null;
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  putFile(
    repo: Repo, path: string, contentB64: string, message: string,
    branch: string, _author: string, sha?: string,
  ): { created: boolean; blobSha: string; commitSha: string; message: string; size: number } | 'conflict' | null {
    const bytes = Buffer.from(contentB64, 'base64');
    const existing = this.getContent(repo, path, branch);
    let created = true;
    if (existing) {
      if (existing.kind !== 'file') return null;
      created = false;
      if (sha !== undefined && sha !== existing.sha) return 'conflict';
    }
    const blobSha = this.putObject(repo, 'blob', bytes);
    const change = new Map<string, Buffer | null>([[path, bytes]]);
    const commitSha = this.commitFile(repo, branch, message, change);
    repo.updatedAt = this.trialNowIso;
    return { created, blobSha, commitSha, message, size: bytes.length };
  }

  deleteFile(repo: Repo, path: string, branch: string, _author: string): { commitSha: string; message: string } | null {
    const existing = this.getContent(repo, path, branch);
    if (!existing || existing.kind !== 'file') return null;
    const message = 'Delete file';
    const commitSha = this.commitFile(repo, branch, message, new Map([[path, null]]));
    repo.updatedAt = this.trialNowIso;
    return { commitSha, message };
  }

  // -----------------------------------------------------------------------------------------
  // Labels, issues, pulls
  // -----------------------------------------------------------------------------------------
  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color, description: '' };
    repo.labels.set(name, label);
    return label;
  }

  hasLabel(repo: Repo, name: string): boolean { return repo.labels.has(name); }

  createIssue(repo: Repo, title: string, body: string, author: string, labels: string[]): Issue {
    const number = repo.nextIssue++;
    const issue: Issue = {
      number, id: this.nextIssueDbId++,
      nodeId: globalId('Issue', `${repo.owner}/${repo.name}/${number}`),
      title, body, state: 'open', labels: [...labels], comments: [],
      createdSeq: this.nextSeq(), closedAt: null,
      author, authorId: this.viewer.id,
      createdAt: this.trialNowIso, updatedAt: this.trialNowIso, repo: repo.name,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  listIssues(repo: Repo, state: string): Issue[] {
    const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    if (state === 'all') return all;
    return all.filter((i) => i.state === state);
  }

  getIssue(repo: Repo, number: number): Issue | undefined { return repo.issues.get(number); }

  addComment(repo: Repo, issue: Issue, body: string, author: string): Comment {
    const comment: Comment = {
      id: repo.nextCommentId++,
      nodeId: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${repo.nextCommentId - 1}`),
      body, createdSeq: this.nextSeq(),
      author, authorId: this.viewer.id,
      createdAt: this.trialNowIso, updatedAt: this.trialNowIso,
      repo: repo.name, number: issue.number,
    };
    issue.comments.push(comment);
    issue.updatedAt = this.trialNowIso;
    issue.jsonCache = undefined;
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, author: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const number = repo.nextPull++;
    const pull: Pull = {
      number, id: this.nextPullDbId++,
      nodeId: globalId('PullRequest', `${repo.owner}/${repo.name}/${number}`),
      title, body, state: 'open', headRef: head, baseRef: base,
      headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
      createdSeq: this.nextSeq(), closedAt: null,
      author, authorId: this.viewer.id,
      createdAt: this.trialNowIso, updatedAt: this.trialNowIso, repo: repo.name,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    if (state === 'all') return all;
    return all.filter((p) => p.state === state);
  }

  getPull(repo: Repo, number: number): Pull | undefined { return repo.pulls.get(number); }

  mergePull(repo: Repo, pull: Pull, _method: string): { sha: string; message: string } | 'conflict' | 'already' | null {
    if (pull.merged) return 'already';
    if (this.prMergeable(repo, pull) === 'CONFLICTING') return 'conflict';
    const sha = this.squashMerge(repo, pull);
    if (sha === null) return 'conflict';
    pull.merged = true;
    pull.mergedAt = this.trialNowIso;
    pull.mergeCommitSha = sha;
    pull.state = 'closed';
    pull.closedAt = this.trialNowIso;
    pull.updatedAt = this.trialNowIso;
    return { sha, message: `Merge pull request #${pull.number} from ${pull.headRef}` };
  }
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
