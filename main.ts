// Forge entry point: lifecycle only, no graded behaviour lives here.
//
// app.ts implements the GitHub-compatible server that the trial grades.
// This file performs the harness handshake around it:
//   1. bind the server to an ephemeral port (never 8080 — the harness owns it),
//   2. POST the port to the harness /register endpoint,
//   3. poll the harness /done endpoint until the trial is over, then shut down.
// The process must stay alive for the whole trial and exit 0 only after
// the harness says done.

import { createApp } from './app.ts';

// Harness base URL, taken from the environment and normalised once.
const harnessUrl = (() => {
  const value = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (value === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is unset, nothing to register with\n');
    process.exit(1);
  }
  return value;
})();

// Retry timing for harness calls: exponential waits, capped, with a
// fixed per-request timeout so a hung harness call cannot stall us.
const RETRY = {
  perRequestMs: 30_000,
  startMs: 250,
  ceilingMs: 2_000,
  doublings: 8,
} as const;

const pause = (ms: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, ms));

function delayFor(attempt: number): number {
  const steps = Math.min(attempt, RETRY.doublings);
  return Math.min(RETRY.ceilingMs, RETRY.startMs * 2 ** steps);
}

// One fetch against the harness, always bounded by the per-request
// timeout so a hung harness call cannot stall the retry loop.
function harnessFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${harnessUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(RETRY.perRequestMs),
  });
}

// Marker prefix on the error registerPort() throws for a contract rejection
// (HTTP 400/405). repeatUntil treats that as fatal and stops retrying.
const REJECTED_PREFIX = 'registration rejected: HTTP ';

// Call `check` again and again until it resolves true. A throwing check
// is retried like a false one, except a registration rejection, which
// aborts the process by propagating out.
async function repeatUntil(check: () => Promise<boolean>): Promise<void> {
  let attempts = 0;
  for (;;) {
    try {
      if (await check()) return;
    } catch (err) {
      const rejected = err instanceof Error && err.message.startsWith(REJECTED_PREFIX);
      if (rejected) throw err;
    }
    await pause(delayFor(attempts));
    attempts += 1;
  }
}

// Register this forge's port with the harness. HTTP 200 means registered;
// 409 means another entry got there first and we simply wait alongside
// it. 400/405 mean our request broke the contract — fatal. Anything else
// (5xx, network error, timeout) is retried by repeatUntil.
async function registerPort(port: number): Promise<void> {
  await repeatUntil(async () => {
    const res = await harnessFetch('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    const code = res.status;
    if (code === 200 || code === 409) return true;
    if (code === 400 || code === 405) {
      const detail = await res.text();
      throw new Error(`${REJECTED_PREFIX}${code}: ${detail}`);
    }
    return false;
  });
}

// Keep asking the harness whether the trial finished; resolve only once
// it answers {"done": true}. A non-OK answer just means "not yet".
async function waitForFinish(): Promise<void> {
  await repeatUntil(async () => {
    const res = await harnessFetch('/done');
    if (!res.ok) return false;
    const payload = (await res.json()) as { done?: unknown };
    return payload.done === true;
  });
}

// Bind the server to a free ephemeral port and report which one it got.
function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server failed to bind an ephemeral TCP port'));
        return;
      }
      resolve(addr.port);
    });
  });
}

async function boot(): Promise<void> {
  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`[entry] forge listening on ${port}\n`);
  await registerPort(port);
  process.stdout.write('[entry] registered with harness, waiting for trial to finish\n');
  await waitForFinish();
  server.close();
  process.stdout.write('[entry] trial finished, shutting down\n');
}

boot().then(
  () => process.exit(0),
  (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[entry] ${text}\n`);
    process.exit(1);
  },
);
