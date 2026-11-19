// http.ts — small shared helpers: JSON body reading, JSON replies, request ids.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';

export function requestIdFor(store: Store, res: ServerResponse): string {
  const id = store.nextRequestId();
  res.setHeader('X-GitHub-Request-Id', id);
  return id;
}

/** Read the request body (cap ~50 MB). Returns null on malformed JSON, {} on an empty body. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const buf = await readRawBody(req, 50 * 1024 * 1024);
  if (buf === null) return null;
  if (buf.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function readRawBody(req: IncomingMessage, cap = 50 * 1024 * 1024): Promise<Buffer | null> {
  // data/end listeners, not `for await`: the async-iterator path costs ~2x the CPU
  // per request on this workload (measured 0.12ms vs 0.05ms per 1KB body).
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let count = 0;
    let settled = false;
    const finish = (result: Buffer | null): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > cap) { finish(null); return; }
      chunks.push(b);
      count += 1;
    };
    const onEnd = (): void => finish(count === 1 ? chunks[0]! : Buffer.concat(chunks));
    const onError = (): void => finish(null);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  jsonReplyRaw(res, status, Buffer.from(JSON.stringify(body), 'utf8'));
}

/** Same headers as jsonReply, but the payload is already serialized (cached bodies). */
export function jsonReplyRaw(res: ServerResponse, status: number, payload: Buffer): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

export function errorReply(res: ServerResponse, status: number, message: string): void {
  jsonReply(res, status, { message });
}

export function notFound(res: ServerResponse): void {
  errorReply(res, 404, 'Not Found');
}
