// Entrypoint: boots the forge, tells the trial environment where it
// listens, then waits until the environment says the trial is over.
//
// The dance, in order:
//   1. Read MAKEFUN_ENV_URL. It points at the environment (for instance
//      http://store:8080 inside a trial container). With no URL there is
//      nobody to talk to, so the process gives up at once with exit 1.
//   2. Build the server (see app.ts) and let the kernel pick a free port
//      with listen(0). Port 8080 is off limits — that one belongs to the env.
//   3. POST the chosen port to $MAKEFUN_ENV_URL/register. The env records
//      the request's origin plus this port as the base URL and starts
//      calling it from then on. A 200 means accepted; a 409 means some
//      other entry registered first, which is fine — this process simply
//      waits along with the rest. 400/405 mean the request itself broke
//      the contract and are fatal; anything else (a network hiccup, the
//      env still booting, an unexpected status) is retried.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      The env replies right away ({"done": false} while the suite is
//      still running), so this is a short poll loop, not a hanging
//      request. A failed or slow poll is retried; the process never
//      leaves before the env says done.
//   5. Shut the server down and exit 0. The harness then stops the env,
//      which writes the export the scorer reads.
//
// Nothing here is what the suite scores — the forge in app.ts is — but
// the lifecycle has to follow exactly this shape for the trial to work.

import { createApp } from './app.ts';

// Where the trial environment lives, with any trailing slashes trimmed.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] no MAKEFUN_ENV_URL in the environment — nothing to register with\n');
  process.exit(1);
}

/** How long one register or done request may run before it is abandoned. */
const HTTP_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause allowed. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pause after `attempt` failed tries: exponential from the first pause, capped. */
function backoffMs(attempt: number): number {
  const growth = 2 ** Math.min(attempt, 8);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * growth);
}

/**
 * Keep calling `step` until it reports success. Each attempt that
 * reports failure is followed by the backoff pause. A step that throws
 * ends the whole program — the throw is not swallowed here.
 */
async function retrying(step: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await step()) return;
    await sleep(backoffMs(attempt));
  }
}

/** POST the bound port until the env accepts the registration. */
async function register(port: number): Promise<void> {
  await retrying(async () => {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      return false;
    } catch (err) {
      // A contract error thrown above must end the program; anything else
      // (network failure, env still starting) is just another retry.
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      return false;
    }
  });
}

/** Poll GET /done until it answers {"done": true}. */
async function waitForDone(): Promise<void> {
  await retrying(async () => {
    try {
      const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!res.ok) return false;
      const body = (await res.json()) as { done?: unknown };
      return body.done === true;
    } catch {
      // The env is not answering yet, or the poll timed out: not done,
      // so the loop tries again after the backoff.
      return false;
    }
  });
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not get an ephemeral TCP port');
  }
  process.stdout.write(`[entry] forge listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered — waiting for the env to finish\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
