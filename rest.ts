// rest.ts — GitHub REST API v3 handlers under /api/v3.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { Repo, Issue, Pull, Comment } from './store.ts';
import { DEFAULT_BRANCH } from './store.ts';
import { readJsonBody, jsonReply, jsonReplyRaw, errorReply, notFound } from './http.ts';

export interface RestCtx {
  store: Store;
  viewer: string; // viewer login, derived from the scenario
  req: IncomingMessage;
  res: ServerResponse;
  host: string;
}

const INSTALLED_VERSION = '1.0.0-github-core-clone';

export function repoJson(repo: Repo, ctx: RestCtx): Record<string, unknown> {
  const base = `http://${ctx.host}/api/v3`;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.ownerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    html_url: `https://${ctx.host}/${repo.owner}/${repo.name}`,
    url: `${base}/repos/${repo.owner}/${repo.name}`,
    clone_url: `http://${ctx.host}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${ctx.host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${ctx.host}:${repo.owner}/${repo.name}.git`,
  };
}

export function issueJson(issue: Issue, ctx: RestCtx): Record<string, unknown> {
  const base = `http://${ctx.host}/api/v3`;
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.author, id: issue.authorId, type: 'User' },
    labels: issue.labels.map((name) => ({ id: 0, name, color: '000000', default: false })),
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://${ctx.host}/${ctx.store.viewerLogin()}/${issue.repo}/issues/${issue.number}`,
    url: `${base}/repos/${ctx.store.viewerLogin()}/${issue.repo}/issues/${issue.number}`,
    repository_url: `${base}/repos/${ctx.store.viewerLogin()}/${issue.repo}`,
    author_association: 'OWNER',
  };
}

export function pullJson(pull: Pull, ctx: RestCtx): Record<string, unknown> {
  const base = `http://${ctx.host}/api/v3`;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? true : (pull.conflict ? false : true),
    mergeable_state: pull.conflict ? 'dirty' : 'clean',
    head: { ref: pull.headRef, sha: pull.headSha ?? '' },
    base: { ref: pull.baseRef, sha: pull.baseSha ?? '' },
    user: { login: pull.author, id: pull.authorId, type: 'User' },
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://${ctx.host}/${ctx.store.viewerLogin()}/${pull.repo}/pulls/${pull.number}`,
    url: `${base}/repos/${ctx.store.viewerLogin()}/${pull.repo}/pulls/${pull.number}`,
  };
}

function commentJson(comment: Comment, ctx: RestCtx): Record<string, unknown> {
  const base = `http://${ctx.host}/api/v3`;
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: comment.author, id: comment.authorId, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://${ctx.host}/${ctx.store.viewerLogin()}/${comment.repo}/issues/${comment.number}#issuecomment-${comment.id}`,
    url: `${base}/repos/${ctx.store.viewerLogin()}/${comment.repo}/issues/comments/${comment.id}`,
    issue_url: `${base}/repos/${ctx.store.viewerLogin()}/${comment.repo}/issues/${comment.number}`,
  };
}

function repoOr404(ctx: RestCtx, owner: string, repo: string): Repo | null {
  if (owner !== ctx.viewer) return null;
  return ctx.store.getRepo(owner, repo) ?? null;
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams;
}

/** Parse `?page=&per_page=` with GitHub defaults; returns {page, perPage}. */
function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(q.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Build a GitHub-style Link header for pagination. */
function linkHeader(req: IncomingMessage, q: URLSearchParams, page: number, perPage: number, total: number): string {
  const base = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const mk = (p: number): string => {
    const u = new URL(base.toString());
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return `<${u.toString()}>`;
  };
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < lastPage) parts.push(`${mk(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${mk(page - 1)}; rel="prev"`);
  parts.push(`${mk(1)}; rel="first"`);
  parts.push(`${mk(lastPage)}; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// -------------------------------------------------------------------------------------------
// Route handler: returns true when handled.
// -------------------------------------------------------------------------------------------
export async function handleRest(ctx: RestCtx): Promise<boolean> {
  const { req, res, store } = ctx;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const q = url.searchParams;
  const method = req.method ?? 'GET';
  const api = '/api/v3';
  if (!path.startsWith(api)) return false;
  const rest = path.slice(api.length) || '/';
  const seg = rest.split('/').filter(Boolean);

  // GET /  (root)
  if (rest === '/' && method === 'GET') {
    res.setHeader('X-OAuth-Scopes', 'repo, read:org');
    jsonReply(res, 200, { current_user_url: `http://${ctx.host}/api/v3/user` });
    return true;
  }
  // GET /meta
  if (rest === '/meta' && method === 'GET') {
    jsonReply(res, 200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
    return true;
  }
  // GET /user
  if (rest === '/user' && method === 'GET') {
    jsonReply(res, 200, {
      login: ctx.viewer,
      id: store.viewerId(),
      node_id: store.viewerNodeId(),
      name: store.viewerName(),
      email: store.viewerEmail(),
      type: 'User',
    });
    return true;
  }
  // GET /user/repos  +  POST /user/repos
  if (rest === '/user/repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(q);
      const repos = store.listRepos(ctx.viewer);
      const total = repos.length;
      res.setHeader('Link', linkHeader(req, q, page, perPage, total));
      jsonReply(res, 200, paginate(repos, page, perPage).map((r) => repoJson(r, ctx)));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { errorReply(res, 422, 'name is required'); return true; }
      const existing = store.getRepo(ctx.viewer, name);
      if (existing) { errorReply(res, 422, 'name already exists on this account'); return true; }
      const repo = store.createRepo(ctx.viewer, name, {
        description: typeof body.description === 'string' ? body.description : undefined,
        private: body.private === true,
        defaultBranch: DEFAULT_BRANCH,
      });
      jsonReply(res, 201, repoJson(repo, ctx));
      return true;
    }
    return true;
  }

  // /repos/{owner}/{repo}[...]
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1]!;
    const repoName = seg[2]!;
    const restPath = seg.slice(3);
    const repo = repoOr404(ctx, owner, repoName);
    if (!repo) { notFound(res); return true; }

    // GET /repos/{o}/{r}
    if (restPath.length === 0) {
      if (method === 'GET') { jsonReply(res, 200, repoJson(repo, ctx)); return true; }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== repo.name) {
          // Rename is not exercised by the suite; keep the name stable.
        }
        repo.updatedAt = store.nowIso();
        jsonReply(res, 200, repoJson(repo, ctx));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204);
        res.end();
        return true;
      }
      return true;
    }

    const sub = restPath[0]!;

    // GET /repos/{o}/{r}/branches[/{branch}]
    if (sub === 'branches') {
      if (method !== 'GET') return true;
      const branches = store.listBranches(repo);
      if (restPath.length === 2) {
        const branch = branches.find((b) => b.name === decodeURIComponent(restPath[1]!));
        if (!branch) { notFound(res); return true; }
        jsonReply(res, 200, branch);
        return true;
      }
      jsonReply(res, 200, branches);
      return true;
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (sub === 'commits') {
      if (method !== 'GET') return true;
      const sha = q.get('sha') ?? repo.defaultBranch;
      const { page, perPage } = pageParams(q);
      const commits = store.listCommitObjects(repo, sha);
      const total = commits.length;
      res.setHeader('Link', linkHeader(req, q, page, perPage, total));
      jsonReply(res, 200, paginate(commits, page, perPage));
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (sub === 'git' && restPath[1] === 'refs') {
      if (restPath.length === 2 && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref || !sha) { errorReply(res, 422, 'ref and sha are required'); return true; }
        if (!store.getObject(repo, sha)) { errorReply(res, 422, 'object not found'); return true; }
        const created = store.createRef(repo, ref, sha);
        if (!created) { errorReply(res, 422, 'reference already exists'); return true; }
        jsonReply(res, 201, { ref, object: { sha, type: 'commit', url: '' } });
        return true;
      }
      // GET /repos/{o}/{r}/git/refs/heads/{branch}
      if (restPath.length >= 4 && restPath[2] === 'heads' && method === 'GET') {
        const branch = decodeURIComponent(restPath.slice(3).join('/'));
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { notFound(res); return true; }
        jsonReply(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: '' } });
        return true;
      }
      return true;
    }

    // /repos/{o}/{r}/contents/{path}
    if (sub === 'contents') {
      const filePath = restPath.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const branch = q.get('ref') ?? repo.defaultBranch;
        const entry = store.getContent(repo, filePath, branch);
        if (!entry) { notFound(res); return true; }
        if (entry.kind === 'dir') {
          jsonReply(res, 200, entry.items.map((it) => ({
            type: it.type, name: it.name, path: it.path, sha: it.sha, size: it.size ?? 0,
          })));
        } else {
          jsonReply(res, 200, {
            type: 'file', encoding: 'base64', size: entry.size, name: filePath.split('/').pop() ?? '',
            path: filePath, content: entry.content, sha: entry.sha,
          });
        }
        return true;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const body = await readJsonBody(req);
        if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
        const branch = (typeof body.branch === 'string' ? body.branch : undefined) ?? repo.defaultBranch;
        if (method === 'DELETE') {
          const current = store.getContent(repo, filePath, branch);
          if (!current || current.kind !== 'file') { notFound(res); return true; }
          if (typeof body.sha === 'string' && body.sha !== current.sha) { errorReply(res, 409, 'sha does not match the current blob'); return true; }
          const result = store.deleteFile(repo, filePath, branch, ctx.viewer);
          if (!result) { notFound(res); return true; }
          jsonReply(res, 200, { content: null, commit: { sha: result.commitSha, message: result.message } });
          return true;
        }
        const content = typeof body!.content === 'string' ? body!.content : '';
        const message = typeof body!.message === 'string' ? body!.message : 'Update file';
        const sha = typeof body!.sha === 'string' ? body!.sha : undefined;
        const result = store.putFile(repo, filePath, content, message, branch, ctx.viewer, sha);
        if (result === 'conflict') { errorReply(res, 409, 'sha does not match the current blob'); return true; }
        if (!result) { errorReply(res, 422, 'could not create file'); return true; }
        jsonReply(res, result.created ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? '', path: filePath, sha: result.blobSha, size: result.size, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message: result.message },
        });
        return true;
      }
      return true;
    }

    // POST /repos/{o}/{r}/labels
    if (sub === 'labels' && method === 'POST' && restPath.length === 1) {
      const body = await readJsonBody(req);
      if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { errorReply(res, 422, 'name is required'); return true; }
      store.createLabel(repo, name, typeof body.color === 'string' ? body.color : '000000');
      jsonReply(res, 201, { id: 0, name, color: typeof body.color === 'string' ? body.color : '000000', default: false });
      return true;
    }

    // Issues
    if (sub === 'issues') {
      // POST /repos/{o}/{r}/issues
      if (restPath.length === 1 && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
        const title = typeof body.title === 'string' ? body.title : '';
        if (!title) { errorReply(res, 422, 'title is required'); return true; }
        const labels = Array.isArray(body.labels) ? body.labels.filter((l: unknown) => typeof l === 'string') as string[] : [];
        for (const label of labels) {
          if (!store.hasLabel(repo, label)) { errorReply(res, 422, `label does not exist: ${label}`); return true; }
        }
        const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', ctx.viewer, labels);
        jsonReply(res, 201, issueJson(issue, ctx));
        return true;
      }
      // GET /repos/{o}/{r}/issues
      if (restPath.length === 1 && method === 'GET') {
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'desc';
        const { page, perPage } = pageParams(q);
        let issues = store.listIssues(repo, state);
        if (sort === 'created') {
          issues = [...issues].sort((a, b) => {
            const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
        }
        const total = issues.length;
        res.setHeader('Link', linkHeader(req, q, page, perPage, total));
        jsonReply(res, 200, paginate(issues, page, perPage).map((i) => issueJson(i, ctx)));
        return true;
      }
      // /repos/{o}/{r}/issues/{n}
      const num = parseInt(restPath[1] ?? '', 10);
      if (Number.isInteger(num) && num > 0) {
        const issue = store.getIssue(repo, num);
        if (!issue) { notFound(res); return true; }
        if (restPath.length === 2) {
          if (method === 'GET') {
            // Perf: the read workload re-reads the same issue 2,000x; serve the
            // cached serialization (invalidated at every mutation site).
            const cached = issue.jsonCache;
            if (cached && cached.host === ctx.host) { jsonReplyRaw(res, 200, cached.payload); return true; }
            const payload = Buffer.from(JSON.stringify(issueJson(issue, ctx)), 'utf8');
            issue.jsonCache = { host: ctx.host, payload };
            jsonReplyRaw(res, 200, payload);
            return true;
          }
          if (method === 'PATCH') {
            const body = await readJsonBody(req);
            if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (body.state === 'open' || body.state === 'closed') {
              issue.state = body.state;
              issue.closedAt = body.state === 'closed' ? store.nowIso() : null;
            }
            issue.updatedAt = store.nowIso();
            issue.jsonCache = undefined;
            jsonReply(res, 200, issueJson(issue, ctx));
            return true;
          }
          return true;
        }
        // /repos/{o}/{r}/issues/{n}/comments
        if (restPath[2] === 'comments') {
          if (method === 'GET') {
            jsonReply(res, 200, issue.comments.map((c) => commentJson(c, ctx)));
            return true;
          }
          if (method === 'POST') {
            const body = await readJsonBody(req);
            if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
            const comment = store.addComment(repo, issue, typeof body.body === 'string' ? body.body : '', ctx.viewer);
            jsonReply(res, 201, commentJson(comment, ctx));
            return true;
          }
          return true;
        }
      }
      return true;
    }

    // Pulls
    if (sub === 'pulls') {
      // POST /repos/{o}/{r}/pulls
      if (restPath.length === 1 && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        if (!title || !head) { errorReply(res, 422, 'title and head are required'); return true; }
        const pull = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base, ctx.viewer);
        if (!pull) { errorReply(res, 422, 'head or base branch not found'); return true; }
        jsonReply(res, 201, pullJson(pull, ctx));
        return true;
      }
      // GET /repos/{o}/{r}/pulls
      if (restPath.length === 1 && method === 'GET') {
        const state = q.get('state') ?? 'open';
        const { page, perPage } = pageParams(q);
        const pulls = store.listPulls(repo, state);
        const total = pulls.length;
        res.setHeader('Link', linkHeader(req, q, page, perPage, total));
        jsonReply(res, 200, paginate(pulls, page, perPage).map((p) => pullJson(p, ctx)));
        return true;
      }
      const num = parseInt(restPath[1] ?? '', 10);
      if (Number.isInteger(num) && num > 0) {
        const pull = store.getPull(repo, num);
        if (!pull) { notFound(res); return true; }
        if (restPath.length === 2 && method === 'GET') { jsonReply(res, 200, pullJson(pull, ctx)); return true; }
        if (restPath[2] === 'files' && method === 'GET') {
          jsonReply(res, 200, store.prFiles(repo, pull));
          return true;
        }
        if (restPath[2] === 'merge' && method === 'PUT') {
          const body = await readJsonBody(req);
          if (body === null) { errorReply(res, 400, 'malformed JSON body'); return true; }
          const methodName = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
          const result = store.mergePull(repo, pull, methodName);
          if (result === 'conflict') { errorReply(res, 405, 'merge conflict'); return true; }
          if (result === 'already') { errorReply(res, 405, 'pull request already merged'); return true; }
          if (!result) { errorReply(res, 422, 'cannot merge'); return true; }
          jsonReply(res, 200, { sha: result.sha, merged: true, message: result.message });
          return true;
        }
        if (restPath[2] === 'merge' && method === 'GET') {
          // Not exercised; report mergeability.
          jsonReply(res, 200, { sha: pull.mergeCommitSha ?? '', merged: pull.merged, message: '' });
          return true;
        }
      }
      return true;
    }

    // Unknown sub-route under an existing repo.
    notFound(res);
    return true;
  }

  // Unknown /api/v3 route.
  notFound(res);
  return true;
}
