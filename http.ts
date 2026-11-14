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
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > cap) return null;
      chunks.push(b);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

export function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
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
