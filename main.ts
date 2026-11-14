// Trial lifecycle for the forge entry point. The suite grades the server
// built by app.ts; this file only runs the handshake with the trial env:
// bind a port, register it, then wait until the env says the trial is done.
// It must not exit early, and it must not bind 8080, which the env owns.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;
const BACKOFF_DOUBLINGS = 8;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(failures: number): number {
  const doublings = Math.min(failures, BACKOFF_DOUBLINGS);
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** doublings);
}

// Keep calling `probe` until it reports true. A probe that throws is a
// retryable failure, unless it throws the fatal contract error from
// register, which is rethrown to end the program.
async function pollUntilTrue(probe: () => Promise<boolean>): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

// Tell the env which port the forge listens on. 200 registers it; 409 means
// another entry registered first and this one just waits. 400/405 are
// contract errors and end the program; anything else is retried.
async function register(port: number): Promise<void> {
  await pollUntilTrue(async () => {
    const response = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const status = response.status;
    if (status === 200 || status === 409) return true;
    if (status === 400 || status === 405) {
      throw new Error(`register answered HTTP ${status}: ${await response.text()}`);
    }
    return false;
  });
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  await pollUntilTrue(async () => {
    const response = await fetch(`${envOrigin}/done`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { done?: unknown };
    return body.done === true;
  });
}

async function main(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[entry] listening on port ${port}\n`);
  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
