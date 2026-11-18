// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, modern era 2026-07-28.
//
// The suite's client (mcp-client.ts) probes `server/discover` first; a result makes the
// connection modern (no initialize handshake, no session). Every request declares the revision
// in `_meta` and in the `Mcp-Protocol-Version` header, and mirrors its method in `Mcp-Method`
// (and the tool name in `Mcp-Name` for tools/call). Plain JSON answers are enough — the client
// also reads request-scoped SSE, but never requires it.
//
// The six tools act on the same Store as REST/GraphQL, so ids and objects are identical across
// surfaces. Tool results carry the JSON payload both as a text block and as structuredContent:
// the suite reads structuredContent first, else parses the text.

import {
  isoTime,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  issueObject,
  pullJson,
  repoJson,
  type Reply,
  type RequestContext,
} from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const PREFERRED_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/** The tool list, built once: two tools/list calls must answer byte-identical JSON. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner+repo).' },
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
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner+repo).' },
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
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner+repo).' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
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
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner+repo).' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner+repo).' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
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
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner+repo).' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] satisfies readonly ToolDef[];

function rpcReply(status: number, id: unknown, result: Record<string, unknown> | null, error: { code: number; message: string; data?: unknown } | null): Reply {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id: id ?? null };
  if (error !== null) body.error = error;
  else body.result = result;
  return {
    status,
    body: `${JSON.stringify(body)}\n`,
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-protocol-version': PREFERRED_VERSION },
  };
}

function bearerToken(ctx: RequestContext): string | null {
  const header = ctx.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function isAuthorized(ctx: RequestContext): boolean {
  const presented = bearerToken(ctx);
  if (presented === null || presented === '') return false;
  if (ctx.token === '') return true;
  return presented === ctx.token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON-RPC id of a parsed request body (null when absent/unparseable). */
function requestId(parsed: unknown): unknown {
  if (!isRecord(parsed)) return null;
  const id = parsed.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** Split a "owner/repo" full name, or null. */
function splitFullName(value: unknown): [string, string] | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return [parts[0]!, parts[1]!];
}

function resolveToolRepo(store: Store, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  let owner = typeof args.owner === 'string' ? args.owner : null;
  let name = typeof args.repo === 'string' ? args.repo : null;
  if ((owner === null || name === null) && typeof args.full_name === 'string') {
    const split = splitFullName(args.full_name);
    if (split !== null) {
      owner = owner ?? split[0];
      name = name ?? split[1];
    }
  }
  if (owner === null || owner === '' || name === null || name === '') return { error: 'owner and repo are required' };
  store.confirmViewer(owner);
  const repo = store.getRepo(owner, name);
  if (repo === null) return { error: `repository ${owner}/${name} not found` };
  return { repo };
}

type ToolOutcome =
  | { kind: 'result'; value: Record<string, unknown> }
  | { kind: 'rpcError'; code: number; message: string };

function toolOk(payload: unknown): ToolOutcome {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { kind: 'result', value: { content: [{ type: 'text', text }], structuredContent: payload, isError: false } };
}

function toolError(message: string): ToolOutcome {
  return { kind: 'result', value: { content: [{ type: 'text', text: message }], isError: true } };
}

function createIssueRecord(store: Store, repo: Repo, title: string, body: string): Issue {
  const number = repo.nextNumber++;
  const tick = store.nextTick();
  const issue: Issue = {
    number,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdAt: isoTime(tick),
    updatedAt: isoTime(tick),
    closedAt: null,
    createdSeq: tick,
    jsonCache: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

function createPullRecord(store: Store, repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) return { error: 'head or base branch does not exist' };
  const number = repo.nextNumber++;
  const tick = store.nextTick();
  const pull: Pull = {
    number,
    title,
    body,
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    mergeCommitSha: null,
    mergedAt: null,
    createdSeq: tick,
    jsonCache: null,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Run one tool; returns a tool result object (never throws for bad arguments). */
function runTool(ctx: RequestContext, name: string, args: Record<string, unknown>): ToolOutcome {
  const store = ctx.store;
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return toolError('name is required');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(repoName, isPrivate, description);
      if (repo === null) return toolError(`repository ${repoName} already exists`);
      return toolOk(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const resolved = resolveToolRepo(store, args);
      if ('error' in resolved) return toolError(resolved.error);
      return toolOk(repoJson(ctx, resolved.repo));
    }
    case 'create_issue': {
      const resolved = resolveToolRepo(store, args);
      if ('error' in resolved) return toolError(resolved.error);
      const title = args.title;
      if (typeof title !== 'string' || title === '') return toolError('title is required');
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = createIssueRecord(store, resolved.repo, title, body);
      return toolOk(issueObject(ctx, resolved.repo, issue));
    }
    case 'list_issues': {
      const resolved = resolveToolRepo(store, args);
      if ('error' in resolved) return toolError(resolved.error);
      const repo = resolved.repo;
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      const list = issues.map((i) => issueObject(ctx, repo, i));
      return toolOk(list);
    }
    case 'create_pull_request': {
      const resolved = resolveToolRepo(store, args);
      if ('error' in resolved) return toolError(resolved.error);
      const title = args.title;
      const head = args.head;
      const base = args.base;
      if (typeof title !== 'string' || title === '') return toolError('title is required');
      if (typeof head !== 'string' || typeof base !== 'string') return toolError('head and base are required');
      const body = typeof args.body === 'string' ? args.body : '';
      const pull = createPullRecord(store, resolved.repo, title, body, head, base);
      if ('error' in pull) return toolError(pull.error);
      return toolOk(pullJson(ctx, resolved.repo, pull));
    }
    case 'merge_pull_request': {
      const resolved = resolveToolRepo(store, args);
      if ('error' in resolved) return toolError(resolved.error);
      const repo = resolved.repo;
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(number) || number <= 0) return toolError('pull_number is required');
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`pull request #${number} not found`);
      if (pull.state === 'closed') return toolError('pull request already merged or closed');
      const outcome = squashMerge(store, repo, pull);
      if (!outcome.ok) return toolError(outcome.reason ?? 'merge conflict');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = isoTime(store.nextTick());
      pull.mergeCommitSha = outcome.commitSha!;
      return toolOk({ merged: true, sha: outcome.commitSha, number: pull.number, state: 'closed', message: `Pull request #${pull.number} merged` });
    }
    default:
      return { kind: 'rpcError', code: -32602, message: `unknown tool: ${name}` };
  }
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Handle one parsed JSON-RPC request object (not a batch element, not a notification). */
function handleRequest(ctx: RequestContext, req: Record<string, unknown>): Reply {
  const id = requestId(req);
  const method = req.method;
  if (typeof method !== 'string' || method === '') {
    return rpcReply(200, id, null, { code: -32600, message: 'Invalid Request' });
  }
  const params = isRecord(req.params) ? req.params : {};

  if (method === 'server/discover') {
    return rpcReply(
      200,
      id,
      {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      },
      null,
    );
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : PREFERRED_VERSION;
    return rpcReply(200, id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: serverInfo() }, null);
  }

  if (method === 'ping') {
    return rpcReply(200, id, {}, null);
  }

  if (method === 'tools/list') {
    return rpcReply(200, id, { tools: TOOLS }, null);
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (typeof name !== 'string' || name === '') {
      return rpcReply(200, id, null, { code: -32602, message: 'tool name is required' });
    }
    const outcome = runTool(ctx, name, args);
    if (outcome.kind === 'rpcError') return rpcReply(200, id, null, { code: outcome.code, message: outcome.message });
    return rpcReply(200, id, outcome.value, null);
  }

  return rpcReply(200, id, null, { code: -32601, message: `method not found: ${method}` });
}

/**
 * The MCP router: POST /mcp only. Returns a Reply when it handled the request.
 * A notification (no id) is answered 202 with no body; a malformed JSON body is
 * HTTP 400 with JSON-RPC -32700; a missing/invalid bearer token is HTTP 401 with a
 * JSON-RPC error body that still echoes the request id.
 */
export function handleMcp(ctx: RequestContext): Reply {
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    return rpcReply(400, null, null, { code: -32700, message: 'Parse error' });
  }

  if (!isAuthorized(ctx)) {
    return rpcReply(401, requestId(parsed), null, { code: -32000, message: 'Unauthorized' });
  }

  if (parsed === null || typeof parsed !== 'object') {
    return rpcReply(200, null, null, { code: -32600, message: 'Invalid Request' });
  }

  // Batch: answer an array, in order, skipping notifications (no id).
  if (Array.isArray(parsed)) {
    const answers: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      if (requestId(entry) === null) {
        // Notification inside a batch: process known ones, answer nothing.
        continue;
      }
      const reply = handleRequest(ctx, entry);
      answers.push(JSON.parse(reply.body ?? '{}') as Record<string, unknown>);
    }
    return {
      status: 200,
      body: `${JSON.stringify(answers)}\n`,
      headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-protocol-version': PREFERRED_VERSION },
    };
  }

  // Notification (no id): accept silently, 202, no body.
  if (requestId(parsed) === null) {
    return { status: 202, body: null, headers: { 'mcp-protocol-version': PREFERRED_VERSION } };
  }
  if (!isRecord(parsed)) {
    return rpcReply(200, null, null, { code: -32600, message: 'Invalid Request' });
  }

  return handleRequest(ctx, parsed);
}
