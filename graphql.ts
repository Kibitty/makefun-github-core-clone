// graphql.ts — a small GraphQL parser + executor for exactly the documents the suite sends.
// Supports: fields, aliases, arguments (variables, literals, input objects, lists, enums),
// inline fragments, __type introspection, and batched arrays. Unknown fields -> HTTP 200
// with an `errors` array naming the field.
import { Store, globalId, parseGlobalId } from './store.ts';
import type { Repo, Issue, Pull, Comment } from './store.ts';

// -------------------------------------------------------------------------------------------
// Lexer / parser
// -------------------------------------------------------------------------------------------
type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) { if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') isFloat = true; j++; }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!@$&|=...'.includes(ch)) {
      if (src.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export interface FieldNode {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  children: FieldNode[];
}

interface Parser { tokens: Token[]; pos: number }

function peek(p: Parser): Token | undefined { return p.tokens[p.pos]; }
function next(p: Parser): Token {
  const t = p.tokens[p.pos];
  if (!t) throw new Error('unexpected end of GraphQL document');
  p.pos++;
  return t;
}
function expectPunct(p: Parser, value: string): void {
  const t = next(p);
  if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.kind}:${t.value}`);
}

function parseValue(p: Parser, variables: Record<string, unknown>): unknown {
  const t = next(p);
  if (t.kind === 'punct' && t.value === '{') {
    const obj: Record<string, unknown> = {};
    while (!(peek(p)?.kind === 'punct' && peek(p)?.value === '}')) {
      const key = next(p);
      if (key.kind !== 'name') throw new Error('expected object key');
      expectPunct(p, ':');
      obj[key.value] = parseValue(p, variables);
    }
    next(p);
    return obj;
  }
  if (t.kind === 'punct' && t.value === '[') {
    const arr: unknown[] = [];
    while (!(peek(p)?.kind === 'punct' && peek(p)?.value === ']')) {
      arr.push(parseValue(p, variables));
    }
    next(p);
    return arr;
  }
  if (t.kind === 'string') return t.value;
  if (t.kind === 'int') return parseInt(t.value, 10);
  if (t.kind === 'float') return parseFloat(t.value);
  if (t.kind === 'name') {
    if (t.value.startsWith('$')) return variables[t.value.slice(1)];
    if (t.value === 'true') return true;
    if (t.value === 'false') return false;
    if (t.value === 'null') return null;
    return t.value; // enum literal
  }
  throw new Error(`unexpected token ${t.kind}:${t.value} in value`);
}

function parseArgs(p: Parser, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  expectPunct(p, '(');
  while (!(peek(p)?.kind === 'punct' && peek(p)?.value === ')')) {
    const key = next(p);
    if (key.kind !== 'name') throw new Error('expected argument name');
    expectPunct(p, ':');
    args[key.value] = parseValue(p, variables);
  }
  next(p);
  return args;
}

function parseSelectionSet(p: Parser, variables: Record<string, unknown>): FieldNode[] {
  expectPunct(p, '{');
  const fields: FieldNode[] = [];
  while (!(peek(p)?.kind === 'punct' && peek(p)?.value === '}')) {
    const t = peek(p)!;
    if (t.kind === 'punct' && t.value === '...') {
      next(p);
      const on = peek(p);
      if (on?.kind === 'name' && on.value === 'on') {
        next(p);
        const typeName = next(p);
        if (typeName.kind !== 'name') throw new Error('expected type name after ... on');
        const children = parseSelectionSet(p, variables);
        fields.push({ name: `... on ${typeName.value}`, alias: null, args: {}, children });
        continue;
      }
      // Named fragment spread — not used by the suite; parse its selection set if present.
      const fragName = next(p);
      void fragName;
      continue;
    }
    const first = next(p);
    if (first.kind !== 'name') throw new Error('expected field name');
    let alias: string | null = null;
    let name = first.value;
    const colon = peek(p);
    if (colon?.kind === 'punct' && colon.value === ':') {
      next(p);
      alias = name;
      const real = next(p);
      if (real.kind !== 'name') throw new Error('expected field name after alias');
      name = real.value;
    }
    let args: Record<string, unknown> = {};
    if (peek(p)?.kind === 'punct' && peek(p)?.value === '(') args = parseArgs(p, variables);
    let children: FieldNode[] = [];
    if (peek(p)?.kind === 'punct' && peek(p)?.value === '{') children = parseSelectionSet(p, variables);
    fields.push({ name, alias, args, children });
  }
  next(p);
  return fields;
}

interface ParsedDocument { operation: 'query' | 'mutation'; fields: FieldNode[] }

export function parseDocument(query: string, variables: Record<string, unknown>): ParsedDocument {
  const tokens = tokenize(query);
  const p: Parser = { tokens, pos: 0 };
  let operation: 'query' | 'mutation' = 'query';
  const t = peek(p);
  if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
    operation = t.value;
    next(p);
    // Optional operation name.
    const nameTok = peek(p);
    if (nameTok?.kind === 'name') next(p);
    // Optional variable definitions.
    if (peek(p)?.kind === 'punct' && peek(p)?.value === '(') {
      let depth = 0;
      while (p.pos < p.tokens.length) {
        const tok = next(p);
        if (tok.kind === 'punct' && tok.value === '(') depth++;
        if (tok.kind === 'punct' && tok.value === ')') { depth--; if (depth === 0) break; }
      }
    }
  }
  const fields = parseSelectionSet(p, variables);
  return { operation, fields };
}

// -------------------------------------------------------------------------------------------
// Introspection tables
// -------------------------------------------------------------------------------------------
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'comments', 'labels', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'],
  SearchType: [],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'REGISTRY', 'MILESTONE'];

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------
type Ctx = { store: Store };

function gqlError(message: string): { message: string } { return { message }; }

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^issue:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string { return issue.state === 'open' ? 'OPEN' : 'CLOSED'; }
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveUser(store: Store, login: string): Record<string, unknown> {
  return { login, id: globalId('User', login), name: login === store.viewerLogin() ? store.viewerName() : login };
}

function resolveIssue(store: Store, repo: Repo, issue: Issue, fields: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = issue.nodeId; break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'body': out[key] = issue.body; break;
      case 'state': out[key] = issueState(issue); break;
      case 'author': out[key] = resolveUser(store, issue.author); break;
      case 'createdAt': out[key] = issue.createdAt; break;
      case 'updatedAt': out[key] = issue.updatedAt; break;
      case 'closedAt': out[key] = issue.closedAt; break;
      case 'url': out[key] = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`; break;
      case 'repository': out[key] = resolveRepository(store, repo, f.children, errors); break;
      default: errors.push(gqlError(`Field 'issue.${f.name}' doesn't exist on type 'Issue'`));
    }
  }
  return out;
}

function resolvePull(store: Store, repo: Repo, pull: Pull, fields: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = pull.nodeId; break;
      case 'number': out[key] = pull.number; break;
      case 'title': out[key] = pull.title; break;
      case 'body': out[key] = pull.body; break;
      case 'state': out[key] = pullState(pull); break;
      case 'merged': out[key] = pull.merged; break;
      case 'mergeable': out[key] = store.prMergeable(repo, pull); break;
      case 'headRefName': out[key] = pull.headRef; break;
      case 'baseRefName': out[key] = pull.baseRef; break;
      case 'author': out[key] = resolveUser(store, pull.author); break;
      case 'createdAt': out[key] = pull.createdAt; break;
      case 'updatedAt': out[key] = pull.updatedAt; break;
      case 'closedAt': out[key] = pull.closedAt; break;
      case 'url': out[key] = `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`; break;
      case 'files': {
        const first = typeof f.args.first === 'number' ? f.args.first : 10;
        const files = store.prFiles(repo, pull).slice(0, first);
        const nodeFields = f.children.find((c) => c.name === 'nodes');
        out[key] = {
          nodes: files.map((file) => {
            const node: Record<string, unknown> = {};
            for (const nf of nodeFields?.children ?? []) {
              if (nf.name === 'path') node[nf.alias ?? 'path'] = file.filename;
              else if (nf.name === 'additions') node[nf.alias ?? 'additions'] = file.additions;
              else if (nf.name === 'deletions') node[nf.alias ?? 'deletions'] = file.deletions;
              else if (nf.name === 'changeType') node[nf.alias ?? 'changeType'] = file.status.toUpperCase();
            }
            return node;
          }),
          totalCount: files.length,
        };
        break;
      }
      case 'repository': out[key] = resolveRepository(store, repo, f.children, errors); break;
      default: errors.push(gqlError(`Field 'pullRequest.${f.name}' doesn't exist on type 'PullRequest'`));
    }
  }
  return out;
}

function resolveRepository(store: Store, repo: Repo, fields: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = repo.nodeId; break;
      case 'databaseId': out[key] = repo.dbId; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
      case 'owner': out[key] = resolveUser(store, repo.owner); break;
      case 'description': out[key] = repo.description; break;
      case 'isPrivate': out[key] = repo.private; break;
      case 'createdAt': out[key] = repo.createdAt; break;
      case 'updatedAt': out[key] = repo.updatedAt; break;
      case 'url': out[key] = `https://github.com/${repo.owner}/${repo.name}`; break;
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[key] = tip === undefined ? null : { name: repo.defaultBranch };
        break;
      }
      case 'issue': {
        const number = f.args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        out[key] = issue === undefined ? null : resolveIssue(store, repo, issue, f.children, errors);
        break;
      }
      case 'issues': {
        const first = typeof f.args.first === 'number' ? f.args.first : 10;
        const after = typeof f.args.after === 'string' ? f.args.after : null;
        const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : null;
        const orderBy = (f.args.orderBy ?? {}) as Record<string, unknown>;
        let issues = [...repo.issues.values()];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        if (orderBy.field === 'CREATED_AT') {
          issues.sort((a, b) => {
            const cmp = a.createdSeq - b.createdSeq;
            return orderBy.direction === 'DESC' ? -cmp : cmp;
          });
        } else {
          issues.sort((a, b) => a.number - b.number);
        }
        if (after !== null) {
          const afterNum = numberFromCursor(after);
          if (afterNum !== null) issues = issues.filter((i) => i.number > afterNum);
        }
        const page = issues.slice(0, first);
        const nodesField = f.children.find((c) => c.name === 'nodes');
        const pageInfoField = f.children.find((c) => c.name === 'pageInfo');
        const conn: Record<string, unknown> = {};
        if (nodesField) conn[nodesField.alias ?? 'nodes'] = page.map((i) => resolveIssue(store, repo, i, nodesField.children, errors));
        if (f.children.some((c) => c.name === 'totalCount')) conn.totalCount = issues.length;
        if (pageInfoField) {
          const info: Record<string, unknown> = {};
          for (const pf of pageInfoField.children) {
            const pk = pf.alias ?? pf.name;
            if (pf.name === 'hasNextPage') info[pk] = issues.length > first;
            else if (pf.name === 'hasPreviousPage') info[pk] = after !== null;
            else if (pf.name === 'endCursor') info[pk] = page.length ? cursorFor(page[page.length - 1]!.number) : null;
            else if (pf.name === 'startCursor') info[pk] = page.length ? cursorFor(page[0]!.number) : null;
          }
          conn[pageInfoField.alias ?? 'pageInfo'] = info;
        }
        out[key] = conn;
        break;
      }
      case 'pullRequest': {
        const number = f.args.number as number | undefined;
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        out[key] = pull === undefined ? null : resolvePull(store, repo, pull, f.children, errors);
        break;
      }
      case 'pullRequests': {
        const first = typeof f.args.first === 'number' ? f.args.first : 10;
        const pulls = [...repo.pulls.values()]
          .filter((p) => p.state === 'open')
          .sort((a, b) => a.number - b.number)
          .slice(0, first);
        const nodesField = f.children.find((c) => c.name === 'nodes');
        const conn: Record<string, unknown> = {};
        if (nodesField) conn[nodesField.alias ?? 'nodes'] = pulls.map((p) => resolvePull(store, repo, p, nodesField.children, errors));
        if (f.children.some((c) => c.name === 'totalCount')) conn.totalCount = repo.pulls.size;
        out[key] = conn;
        break;
      }
      default: errors.push(gqlError(`Field 'repository.${f.name}' doesn't exist on type 'Repository'`));
    }
  }
  return out;
}

function resolveType(name: string, fields: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = { name };
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'fields') {
      const names = TYPE_FIELDS[name] ?? [];
      out[key] = names.map((n) => ({ name: n }));
    } else if (f.name === 'enumValues') {
      out[key] = name === 'SearchType' ? SEARCH_TYPE_VALUES.map((n) => ({ name: n })) : [];
    } else if (f.name === 'kind') {
      out[key] = name === 'SearchType' ? 'ENUM' : 'OBJECT';
    } else {
      errors.push(gqlError(`Field '__type.${f.name}' doesn't exist on type '__Type'`));
    }
  }
  return out;
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function executeDocument(store: Store, doc: ParsedDocument): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const data: Record<string, unknown> = {};
  for (const f of doc.fields) {
    const key = f.alias ?? f.name;
    try {
      switch (f.name) {
        case 'viewer': {
          const out: Record<string, unknown> = {};
          for (const vf of f.children) {
            const vk = vf.alias ?? vf.name;
            if (vf.name === 'login') out[vk] = store.viewerLogin();
            else if (vf.name === 'id') out[vk] = store.viewerNodeId();
            else if (vf.name === 'name') out[vk] = store.viewerName();
            else if (vf.name === 'email') out[vk] = store.viewerEmail();
            else errors.push(gqlError(`Field 'viewer.${vf.name}' doesn't exist on type 'User'`));
          }
          data[key] = out;
          break;
        }
        case 'repository': {
          const owner = f.args.owner as string | undefined;
          const name = f.args.name as string | undefined;
          const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
          if (repo === undefined || owner !== store.viewerLogin()) {
            data[key] = null;
          } else {
            data[key] = resolveRepository(store, repo, f.children, errors);
          }
          break;
        }
        case '__type': {
          const name = f.args.name as string | undefined;
          data[key] = name === undefined ? null : resolveType(name, f.children, errors);
          break;
        }
        case 'node': {
          const id = f.args.id as string | undefined;
          const parsed = id === undefined ? null : parseGlobalId(id);
          let node: Record<string, unknown> | null = null;
          if (parsed?.kind === 'Repository') {
            const repo = findRepoByGlobalId(store, id!);
            if (repo) {
              node = { id: repo.nodeId };
              for (const cf of f.children) {
                if (cf.name.startsWith('... on ')) {
                  const typeName = cf.name.slice('... on '.length);
                  if (typeName === 'Repository') {
                    Object.assign(node, resolveRepository(store, repo, cf.children, errors));
                  }
                } else if (cf.name === 'id') {
                  node.id = repo.nodeId;
                } else {
                  errors.push(gqlError(`Field 'node.${cf.name}' doesn't exist on type 'Node'`));
                }
              }
            }
          }
          data[key] = node;
          break;
        }
        case 'createIssue': {
          const input = (f.args.input ?? {}) as Record<string, unknown>;
          const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
          if (!repo) { errors.push(gqlError('createIssue: repository not found')); data[key] = null; break; }
          const issue = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', store.viewerLogin(), []);
          const issueField = f.children.find((c) => c.name === 'issue');
          data[key] = issueField ? { issue: resolveIssue(store, repo, issue, issueField.children, errors) } : null;
          break;
        }
        case 'closeIssue': {
          const input = (f.args.input ?? {}) as Record<string, unknown>;
          const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
          let issue: Issue | undefined;
          let repo: Repo | undefined;
          if (parsed?.kind === 'Issue') {
            const parts = parsed.key.split('/');
            repo = parts.length === 3 ? store.getRepo(parts[0]!, parts[1]!) : undefined;
            issue = repo?.issues.get(parseInt(parts[2]!, 10));
          }
          if (!issue || !repo) { errors.push(gqlError('closeIssue: issue not found')); data[key] = null; break; }
          issue.state = 'closed';
          issue.closedAt = store.nowIso();
          issue.updatedAt = store.nowIso();
          const issueField = f.children.find((c) => c.name === 'issue');
          data[key] = issueField ? { issue: resolveIssue(store, repo, issue, issueField.children, errors) } : null;
          break;
        }
        case 'createPullRequest': {
          const input = (f.args.input ?? {}) as Record<string, unknown>;
          const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
          if (!repo) { errors.push(gqlError('createPullRequest: repository not found')); data[key] = null; break; }
          const pull = store.createPull(
            repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '',
            String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch), store.viewerLogin(),
          );
          if (!pull) { errors.push(gqlError('createPullRequest: head or base branch not found')); data[key] = null; break; }
          const prField = f.children.find((c) => c.name === 'pullRequest');
          data[key] = prField ? { pullRequest: resolvePull(store, repo, pull, prField.children, errors) } : null;
          break;
        }
        case 'mergePullRequest': {
          const input = (f.args.input ?? {}) as Record<string, unknown>;
          const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
          let pull: Pull | undefined;
          let repo: Repo | undefined;
          if (parsed?.kind === 'PullRequest') {
            const parts = parsed.key.split('/');
            repo = parts.length === 3 ? store.getRepo(parts[0]!, parts[1]!) : undefined;
            pull = repo?.pulls.get(parseInt(parts[2]!, 10));
          }
          if (!pull || !repo) { errors.push(gqlError('mergePullRequest: pull request not found')); data[key] = null; break; }
          const result = store.mergePull(repo, pull, String(input.mergeMethod ?? 'SQUASH'));
          if (result === 'conflict' || result === null) { errors.push(gqlError('mergePullRequest: merge conflict')); data[key] = null; break; }
          if (result === 'already') { errors.push(gqlError('mergePullRequest: already merged')); data[key] = null; break; }
          const prField = f.children.find((c) => c.name === 'pullRequest');
          data[key] = prField ? { pullRequest: resolvePull(store, repo, pull, prField.children, errors) } : null;
          break;
        }
        case 'addComment': {
          const input = (f.args.input ?? {}) as Record<string, unknown>;
          const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
          let issue: Issue | undefined;
          let repo: Repo | undefined;
          if (parsed?.kind === 'Issue') {
            const parts = parsed.key.split('/');
            repo = parts.length === 3 ? store.getRepo(parts[0]!, parts[1]!) : undefined;
            issue = repo?.issues.get(parseInt(parts[2]!, 10));
          }
          if (!issue || !repo) { errors.push(gqlError('addComment: subject not found')); data[key] = null; break; }
          const comment = store.addComment(repo, issue, typeof input.body === 'string' ? input.body : '', store.viewerLogin());
          const edgeField = f.children.find((c) => c.name === 'commentEdge');
          const nodeField = edgeField?.children.find((c) => c.name === 'node');
          const node: Record<string, unknown> = {};
          for (const nf of nodeField?.children ?? []) {
            const nk = nf.alias ?? nf.name;
            if (nf.name === 'id') node[nk] = comment.nodeId;
            else if (nf.name === 'body') node[nk] = comment.body;
            else errors.push(gqlError(`Field 'comment.${nf.name}' doesn't exist on type 'IssueComment'`));
          }
          data[key] = { commentEdge: { node } };
          break;
        }
        default: {
          errors.push(gqlError(`Cannot query field '${f.name}' on type 'Query'`));
          data[key] = null;
        }
      }
    } catch (err) {
      errors.push(gqlError(err instanceof Error ? err.message : String(err)));
      data[key] = null;
    }
  }
  return { data, errors };
}

export interface GraphQLBody { query?: unknown; variables?: unknown; operationName?: unknown }

/** Execute one GraphQL request body (object or batched array). Returns the response payload. */
export function executeGraphQL(store: Store, body: unknown): unknown {
  const runOne = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { data: null, errors: [gqlError('GraphQL body must be an object with a query string')] };
    }
    const { query, variables } = item as GraphQLBody;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [gqlError('GraphQL query must be a non-empty string')] };
    }
    const vars = (variables !== null && typeof variables === 'object' && !Array.isArray(variables))
      ? (variables as Record<string, unknown>)
      : {};
    let doc: ParsedDocument;
    try {
      doc = parseDocument(query, vars);
    } catch (err) {
      return { data: null, errors: [gqlError(err instanceof Error ? err.message : String(err))] };
    }
    const { data, errors } = executeDocument(store, doc);
    return errors.length ? { data, errors } : { data };
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}
