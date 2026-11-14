// app.ts — the HTTP server: routing, auth, and the git smart-HTTP endpoints.
// main.ts owns the lifecycle (bind ephemeral port, register, poll /done); this file owns the app.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestCtx } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { jsonReply, errorReply, notFound, readRawBody, requestIdFor } from './http.ts';
import {
  advertiseV2UploadPack, advertiseV0, handleLsRefs, handleFetchV2, handleFetchV0,
  handleReceivePack, decodePktLines,
} from './gitproto.ts';

function isAuthorized(store: Store, req: IncomingMessage): boolean {
  if (store.token === '') return true; // no token configured (local dev only)
  const header = req.headers.authorization;
  return header === `Bearer ${store.token}`;
}

function unauthorized(res: ServerResponse): void {
  errorReply(res, 401, 'Bad credentials');
}

function gitNotFound(res: ServerResponse): void {
  errorReply(res, 404, 'Not Found');
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void handleRequest(store, req, res).catch((err) => {
      // Never crash the server on a handler error: answer 500 JSON and keep serving.
      try {
        if (!res.headersSent) errorReply(res, 500, err instanceof Error ? err.message : 'internal error');
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  return server;
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Health check: no auth, no request id needed (but harmless to include one).
  if (path === '/healthz') {
    jsonReply(res, 200, { ok: true });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    // The request id rides every REST reply, including 401s (protocol.request-id).
    requestIdFor(store, res);
    if (!isAuthorized(store, req)) { unauthorized(res); return; }
    const host = req.headers.host ?? 'localhost';
    const ctx: RestCtx = { store, viewer: store.viewerLogin(), req, res, host };
    await handleRest(ctx);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    requestIdFor(store, res);
    if (!isAuthorized(store, req)) { unauthorized(res); return; }
    if (method !== 'POST') { errorReply(res, 405, 'Method Not Allowed'); return; }
    const raw = await readRawBody(req);
    if (raw === null) { errorReply(res, 400, 'request body too large'); return; }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      jsonReply(res, 200, { data: null, errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    const payload = executeGraphQL(store, body);
    jsonReply(res, 200, payload);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (!isAuthorized(store, req)) { unauthorized(res); return; }
    if (method !== 'POST') { errorReply(res, 405, 'Method Not Allowed'); return; }
    const raw = await readRawBody(req);
    if (raw === null) { errorReply(res, 400, 'request body too large'); return; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    if (Array.isArray(parsed)) {
      const out = parsed
        .map((item) => handleMcp(store, item as never))
        .filter((r) => r.body !== null)
        .map((r) => r.body);
      jsonReply(res, 200, out);
      return;
    }
    const outcome = handleMcp(store, parsed as never);
    if (outcome.body === null) {
      res.writeHead(outcome.status);
      res.end();
      return;
    }
    res.writeHead(outcome.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(outcome.body));
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const suffix = gitMatch[3]!;
    if (!isAuthorized(store, req)) { unauthorized(res); return; }
    if (owner !== store.viewerLogin()) { gitNotFound(res); return; }
    const repo = store.getRepo(owner, repoName);
    if (!repo) { gitNotFound(res); return; }

    if (method === 'GET' && suffix === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const v2 = req.headers['git-protocol'] === 'version=2';
        const body = v2 ? advertiseV2UploadPack(repo) : advertiseV0(repo, 'git-upload-pack');
        res.writeHead(200, {
          'Content-Type': 'application/x-git-upload-pack-advertisement',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      if (service === 'git-receive-pack') {
        const body = advertiseV0(repo, 'git-receive-pack');
        res.writeHead(200, {
          'Content-Type': 'application/x-git-receive-pack-advertisement',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      gitNotFound(res);
      return;
    }

    if (method === 'POST' && suffix === 'git-upload-pack') {
      const raw = await readRawBody(req);
      if (raw === null) { errorReply(res, 400, 'request body too large'); return; }
      if (process.env.DEBUG_GIT === '1') {
        process.stderr.write(`[git-debug] upload-pack request proto=${req.headers['git-protocol'] ?? ''} bytes=${raw.length}\n${raw.toString('utf8').replace(/[^\x20-\x7e\n]/g, (c) => `<${c.charCodeAt(0).toString(16)}>`)}` + '\n');
      }
      const v2 = req.headers['git-protocol'] === 'version=2';
      let out: Buffer;
      try {
        if (v2) {
          const packets = decodePktLines(raw);
          const first = packets.find((p) => p.kind === 'data');
          const command = first ? first.payload.toString('utf8').replace(/\n$/, '') : '';
          if (command.startsWith('command=ls-refs')) out = handleLsRefs(repo, raw);
          else if (command.startsWith('command=fetch')) out = handleFetchV2(repo, raw);
          else { errorReply(res, 400, 'unknown upload-pack command'); return; }
        } else {
          out = handleFetchV0(repo, raw);
        }
      } catch {
        errorReply(res, 400, 'malformed git request');
        return;
      }
      if (process.env.DEBUG_GIT === '1') {
        process.stderr.write(`[git-debug] upload-pack response bytes=${out.length}\n${out.toString('utf8').replace(/[^\x20-\x7e\n]/g, (c) => `<${c.charCodeAt(0).toString(16)}>`)}` + '\n');
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-git-upload-pack-result',
        'Content-Length': out.length,
      });
      res.end(out);
      return;
    }

    if (method === 'POST' && suffix === 'git-receive-pack') {
      const raw = await readRawBody(req);
      if (raw === null) { errorReply(res, 400, 'request body too large'); return; }
      const { status, body } = handleReceivePack(repo, raw);
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-git-receive-pack-result',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    gitNotFound(res);
    return;
  }

  // Anything else: 404 JSON, never HTML.
  if (path.startsWith('/api/')) requestIdFor(store, res);
  notFound(res);
}
