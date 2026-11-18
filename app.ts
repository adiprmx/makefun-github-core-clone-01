// The entry's HTTP server: one Node process, one in-memory Store, four surfaces.
//
//   GET  /healthz        the env's boot probe: 200 {"ok":true}, no auth.
//   POST /mcp            MCP (JSON-RPC 2.0 over Streamable HTTP, modern era 2026-07-28).
//   POST /api/graphql    GraphQL v4.
//   /{owner}/{repo}.git  git smart HTTP (info/refs, upload-pack v2+v0, receive-pack v0).
//   /api/v3/...          REST v3.
//   anything else        JSON 404 with a string message.
//
// Every reply carries a non-empty X-GitHub-Request-Id (the REST wire contract) and is
// application/json unless the surface says otherwise (git advertisements/results).
// A handler never throws out of a request: a bug answers 500 JSON and the server stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest, withRequestId, type RequestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** Largest request body accepted (packs in the suite are far below this). */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(16).padStart(8, '0')}`;
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && value.length > 0) out[key] = value[0];
  }
  return out;
}

function send(res: ServerResponse, status: number, body: string | Buffer | null, headers: Record<string, string> = {}): void {
  const payload = body === null ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const finalHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    ...headers,
    'x-github-request-id': nextRequestId(),
    'content-length': String(payload.length),
  };
  res.writeHead(status, finalHeaders);
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, `${JSON.stringify(value)}\n`, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    void (async () => {
      let body: Buffer;
      try {
        body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'request body too large' });
        return;
      }

      try {
        const headers = headersOf(req);
        const query = queryOf(req);
        const host = headers.host ?? 'localhost';

        // ---- MCP -----------------------------------------------------------------
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const ctx: RequestContext = { store, token, method, path, query, headers, host, body };
          const reply = withRequestId(handleMcp(ctx));
          send(res, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        // ---- GraphQL -------------------------------------------------------------
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const reply = handleGraphQL({ store, token, body }, headers.authorization ?? null);
          send(res, reply.status, reply.body, { 'content-type': JSON_TYPE });
          return;
        }

        // ---- git smart HTTP --------------------------------------------------------
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          const reply = handleGit({ store, token, method, path, query, headers, body });
          if (reply !== null) {
            send(res, reply.status, reply.body, reply.headers ?? {});
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // ---- REST v3 ---------------------------------------------------------------
        if (path.startsWith('/api/v3')) {
          const ctx: RequestContext = { store, token, method, path, query, headers, host, body };
          const reply = handleRest(ctx);
          if (reply !== null) {
            const withId = withRequestId(reply);
            send(res, withId.status, withId.body, withId.headers ?? {});
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler bug must never take the server down.
        const detail = err instanceof Error ? err.message : 'internal error';
        try {
          sendJson(res, 500, { message: detail });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
}
