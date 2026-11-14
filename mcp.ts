// mcp.ts — Model Context Protocol endpoint (Streamable HTTP, JSON-RPC 2.0).
// Modern era 2026-07-28 via server/discover; legacy initialize + notifications/initialized also work.
import { Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

// Built once: tools/list must be byte-identical across calls.
const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(store: Store, owner: string, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  return {
    id: repo.id, node_id: repo.nodeId, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.ownerId, type: 'User' },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    has_issues: true,
  };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError?: boolean };

function okResult(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

/** Split owner/repo out of the args, honouring a full_name synonym. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let repo = typeof args.repo === 'string' ? args.repo : undefined;
  const full = typeof args.full_name === 'string' ? args.full_name : undefined;
  if ((owner === undefined || repo === undefined) && full !== undefined) {
    const parts = full.split('/');
    if (parts.length === 2) { owner = parts[0]; repo = parts[1]; }
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return errorResult('create_repo requires a name');
      if (store.getRepo(store.viewerLogin(), repoName)) return errorResult('name already exists on this account');
      store.createRepo(store.viewerLogin(), repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: args.private === true,
      });
      return okResult(repoJson(store, store.viewerLogin(), repoName));
    }
    case 'get_repo': {
      const or = ownerRepo(args);
      if (!or) return errorResult('get_repo requires owner and repo');
      const obj = repoJson(store, or.owner, or.repo);
      if (!obj) return errorResult('Not Found');
      return okResult(obj);
    }
    case 'create_issue': {
      const or = ownerRepo(args);
      const title = typeof args.title === 'string' ? args.title : '';
      if (!or || !title) return errorResult('create_issue requires owner, repo and title');
      const repo = store.getRepo(or.owner, or.repo);
      if (!repo) return errorResult('Not Found');
      const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', store.viewerLogin(), []);
      return okResult({
        id: issue.id, node_id: issue.nodeId, number: issue.number, title: issue.title,
        body: issue.body, state: issue.state, user: { login: issue.author, id: issue.authorId },
        labels: [], comments: issue.comments.length,
        created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt,
      });
    }
    case 'list_issues': {
      const or = ownerRepo(args);
      if (!or) return errorResult('list_issues requires owner and repo');
      const repo = store.getRepo(or.owner, or.repo);
      if (!repo) return errorResult('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, state).map((i) => ({
        id: i.id, node_id: i.nodeId, number: i.number, title: i.title,
        body: i.body, state: i.state, user: { login: i.author, id: i.authorId },
        labels: i.labels, comments: i.comments.length,
        created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt,
      }));
      return okResult({ issues });
    }
    case 'create_pull_request': {
      const or = ownerRepo(args);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!or || !title || !head || !base) return errorResult('create_pull_request requires owner, repo, title, head and base');
      const repo = store.getRepo(or.owner, or.repo);
      if (!repo) return errorResult('Not Found');
      const pull = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base, store.viewerLogin());
      if (!pull) return errorResult('head or base branch not found');
      return okResult({
        id: pull.id, node_id: pull.nodeId, number: pull.number, title: pull.title,
        body: pull.body, state: pull.state, merged: pull.merged,
        head: { ref: pull.headRef, sha: pull.headSha ?? '' },
        base: { ref: pull.baseRef, sha: pull.baseSha ?? '' },
        user: { login: pull.author, id: pull.authorId },
        created_at: pull.createdAt, updated_at: pull.updatedAt,
      });
    }
    case 'merge_pull_request': {
      const or = ownerRepo(args);
      const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      if (!or || !Number.isInteger(num)) return errorResult('merge_pull_request requires owner, repo and pull_number');
      const repo = store.getRepo(or.owner, or.repo);
      if (!repo) return errorResult('Not Found');
      const pull = store.getPull(repo, num);
      if (!pull) return errorResult('Not Found');
      const result = store.mergePull(repo, pull, 'squash');
      if (result === 'conflict') return errorResult('merge conflict');
      if (result === 'already') return errorResult('pull request already merged');
      if (!result) return errorResult('cannot merge');
      return okResult({ sha: result.sha, merged: true, message: result.message });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

export interface McpRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

export interface McpResponse {
  status: number;
  /** null body means: no body (notification acknowledgement). */
  body: Record<string, unknown> | null;
}

/** Handle one decoded JSON-RPC request object. */
export function handleMcp(store: Store, req: McpRequest): McpResponse {
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params))
    ? (req.params as Record<string, unknown>)
    : {};
  const isNotification = req.id === undefined;

  const result = (value: unknown): McpResponse => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
  });
  const rpcError = (code: number, message: string, data?: unknown): McpResponse => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } },
  });

  if (isNotification) {
    // Notifications (e.g. notifications/initialized) get a bare 202 acknowledgement.
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = requested === MODERN_REVISION
        ? MODERN_REVISION
        : LEGACY_REVISIONS.includes(requested) ? requested : LEGACY_REVISIONS[0]!;
      return result({
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(-32601, `unknown tool: ${name}`);
      const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
        ? (params.arguments as Record<string, unknown>)
        : {};
      const missing = tool.inputSchema.required.filter((prop) => !(prop in args) || args[prop] === undefined || args[prop] === null || args[prop] === '');
      if (missing.length > 0) {
        return result({ content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }], structuredContent: { error: `missing required argument(s): ${missing.join(', ')}` }, isError: true });
      }
      return result(callTool(store, name, args));
    }
    case 'ping':
      return result({});
    default:
      return rpcError(-32601, `method not found: ${method}`);
  }
}
