// GitHub REST v3 surface: repositories, branches, commits, contents, issues, comments,
// labels, pull requests, files and merges. Every reply is application/json and carries a
// non-empty X-GitHub-Request-Id; errors carry {"message": string}.
//
// The hot paths (GET one issue, POST one issue) are kept lean on purpose: the benchmark reads
// one issue 2,000 times a round and creates 200 issues a round, so an issue's REST JSON is
// serialised once, cached on the issue, and served as a string until the issue mutates.

import {
  commitFile,
  diffForPull,
  flattenTree,
  globalId,
  isoTime,
  listCommits,
  planMerge,
  squashMerge,
  treeLookup,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_NAME,
  type Issue,
  type IssueComment,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { isObjectId, parseCommit } from './gitobj.ts';

export interface RequestContext {
  store: Store;
  /** The bearer token the entry expects ('' when unset: any non-empty token is the viewer). */
  token: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  host: string;
  body: Buffer;
}

export interface Reply {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

let requestSeq = 0;

function jsonReply(status: number, value: unknown, extra: Record<string, string> = {}): Reply {
  const text = `${JSON.stringify(value)}\n`;
  return { status, body: text, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } };
}

function emptyReply(status: number, extra: Record<string, string> = {}): Reply {
  return { status, body: null, headers: extra };
}

function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

function parseJsonBody(ctx: RequestContext): { ok: true; value: Record<string, unknown> } | { ok: false; reply: Reply } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, reply: errorReply(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, reply: errorReply(400, 'request body is not valid JSON') };
  }
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

function viewerUser(): Record<string, unknown> {
  return { login: '', id: VIEWER_ID, node_id: '', type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export function userJson(store: Store): Record<string, unknown> {
  return {
    login: store.viewerLogin,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
    avatar_url: '',
    type: 'User',
    site_admin: false,
  };
}

export function baseUrlOf(ctx: RequestContext): string {
  return `http://${ctx.host}`;
}

export function repoJson(ctx: RequestContext, repo: Repo): Record<string, unknown> {
  const owner = userJson(ctx.store);
  const fullName = `${ctx.store.viewerLogin}/${repo.name}`;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id, 0),
    name: repo.name,
    full_name: fullName,
    owner,
    private: repo.isPrivate,
    html_url: `${baseUrlOf(ctx)}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}`,
    created_at: isoTime(repo.createdSeq),
    updated_at: isoTime(repo.createdSeq),
    pushed_at: isoTime(repo.createdSeq),
    git_url: `${baseUrlOf(ctx)}/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    clone_url: `${baseUrlOf(ctx)}/${fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return {
    id: 0,
    node_id: Buffer.from(`Label:${label.name}`, 'utf8').toString('base64'),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: '',
  };
}

function issueJson(ctx: RequestContext, repo: Repo, issue: Issue): string {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const fullName = `${ctx.store.viewerLogin}/${repo.name}`;
  const text = JSON.stringify({
    id: repo.id * 100000 + issue.number,
    node_id: globalId('Issue', repo.id, issue.number),
    url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}`,
    labels_url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}/issues/${issue.number}/comments`,
    events_url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}/issues/${issue.number}/events`,
    html_url: `${baseUrlOf(ctx)}/${fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(ctx.store),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  });
  issue.jsonCache = text;
  return text;
}

export function issueObject(ctx: RequestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return JSON.parse(issueJson(ctx, repo, issue)) as Record<string, unknown>;
}

export function pullJson(ctx: RequestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const fullName = `${ctx.store.viewerLogin}/${repo.name}`;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeable = pull.state === 'open' ? planMerge(repo, pull).ok : false;
  return {
    id: repo.id * 100000 + pull.number,
    node_id: globalId('PullRequest', repo.id, pull.number),
    url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}/pulls/${pull.number}`,
    html_url: `${baseUrlOf(ctx)}/${fullName}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(ctx.store),
    created_at: isoTime(pull.createdSeq),
    updated_at: isoTime(pull.createdSeq),
    closed_at: pull.state === 'closed' ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? userJson(ctx.store) : null,
    head: {
      label: `${ctx.store.viewerLogin}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(ctx.store),
      repo: repoJson(ctx, repo),
    },
    base: {
      label: `${ctx.store.viewerLogin}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(ctx.store),
      repo: repoJson(ctx, repo),
    },
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function paginate<T>(items: readonly T[], ctx: RequestContext): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + slice.length < items.length) {
    const nextUrl = new URL(`${baseUrlOf(ctx)}${ctx.path}`);
    nextUrl.searchParams.set('page', String(page + 1));
    nextUrl.searchParams.set('per_page', String(perPage));
    const lastPage = Math.ceil(items.length / perPage);
    const lastUrl = new URL(`${baseUrlOf(ctx)}${ctx.path}`);
    lastUrl.searchParams.set('page', String(lastPage));
    lastUrl.searchParams.set('per_page', String(perPage));
    link = `<${nextUrl.toString()}>; rel="next", <${lastUrl.toString()}>; rel="last"`;
  }
  return { page: [...slice], link };
}

function withLink(reply: Reply, link: string | null): Reply {
  if (link !== null) {
    reply.headers = { ...reply.headers, link };
  }
  return reply;
}

/** Resolve /repos/{owner}/{repo} — 404 when the owner is foreign or the repo is missing. */
function resolveRepo(ctx: RequestContext, owner: string, name: string): { repo: Repo } | { reply: Reply } {
  if (!ctx.store.isViewer(owner)) {
    ctx.store.confirmViewer(owner);
    if (!ctx.store.isViewer(owner)) return { reply: errorReply(404, 'Not Found') };
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === null) return { reply: errorReply(404, 'Not Found') };
  return { repo };
}

function decodePathSegments(rest: string): string[] {
  return rest.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

function b64decodeLoose(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** The REST router: returns a Reply when it handled the request, null to fall through. */
export function handleRest(ctx: RequestContext): Reply | null {
  const { method, path } = ctx;

  // The API root and meta are unauthenticated, as on api.github.com.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return jsonReply(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    return jsonReply(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (!path.startsWith('/api/v3/')) return null;

  // Everything else under /api/v3 requires the trial token.
  if (!isAuthorized(ctx)) return errorReply(401, 'Bad credentials');

  const rest = path.slice('/api/v3/'.length);
  const segments = rest.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  // ---- /user ----------------------------------------------------------------------
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') return jsonReply(200, userJson(ctx.store));
    return errorReply(404, 'Not Found');
  }

  // ---- /user/repos ---------------------------------------------------------------
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.listViewerRepos();
      const { page, link } = paginate(repos, ctx);
      return withLink(jsonReply(200, page.map((r) => repoJson(ctx, r))), link);
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') return errorReply(422, 'name is required');
      const created = ctx.store.createRepo(
        name,
        parsed.value.private === true,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
      );
      if (created === null) return errorReply(422, 'Repository already exists');
      return jsonReply(201, repoJson(ctx, created));
    }
    return errorReply(404, 'Not Found');
  }

  // ---- /repos/{owner}/{name}/... ---------------------------------------------------
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    ctx.store.confirmViewer(owner);
    const resolved = resolveRepo(ctx, owner, name);
    if ('reply' in resolved) return resolved.reply;
    const repo = resolved.repo;
    const tail = segments.slice(3);

    // GET /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') return jsonReply(200, repoJson(ctx, repo));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return parsed.reply;
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
        return jsonReply(200, repoJson(ctx, repo));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(repo);
        return emptyReply(204);
      }
      return errorReply(404, 'Not Found');
    }

    // ---- branches ---------------------------------------------------------------
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      const branches = ctx.store.branches(repo).map((b) => ({
        name: b.name,
        commit: { sha: b.oid, url: '' },
        protected: false,
      }));
      return jsonReply(200, branches);
    }

    // ---- branches/{branch} --------------------------------------------------------
    if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') {
      const oid = repo.refs.get(`refs/heads/${tail[1]}`);
      if (oid === undefined) return errorReply(404, 'Not Found');
      return jsonReply(200, { name: tail[1], commit: { sha: oid, url: '' }, protected: false });
    }

    // ---- commits ------------------------------------------------------------------
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
      let tip: string | null = null;
      if (isObjectId(shaParam)) tip = shaParam;
      else tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? null;
      if (tip === null) return errorReply(404, 'Not Found');
      const commits = listCommits(repo, tip).map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { name: 'Forge', email: 'forge@localhost' }, committer: { name: 'Forge', email: 'forge@localhost' } },
        url: '',
        html_url: '',
      }));
      return jsonReply(200, commits);
    }

    // ---- git/refs -----------------------------------------------------------------
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length > 2 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return errorReply(404, 'Not Found');
      return jsonReply(200, { ref, node_id: '', url: '', object: { sha: oid, type: 'commit', url: '' } });
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || typeof sha !== 'string' || !isObjectId(sha)) {
        return errorReply(422, 'ref and sha are required');
      }
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') return errorReply(422, 'sha does not name a commit in this repository');
      if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      return jsonReply(201, { ref, node_id: '', url: '', object: { sha, type: 'commit', url: '' } });
    }

    // ---- contents ------------------------------------------------------------------
    if (tail[0] === 'contents') {
      const filePath = decodePathSegments(tail.slice(1).join('/')).join('/');
      if (method === 'GET') return handleGetContents(ctx, repo, filePath);
      if (method === 'PUT') return handlePutContents(ctx, repo, filePath);
      if (method === 'DELETE') return handleDeleteContents(ctx, repo, filePath);
      return errorReply(404, 'Not Found');
    }

    // ---- labels ---------------------------------------------------------------------
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return jsonReply(200, [...repo.labels.values()].map(labelJson));
      }
      if (method === 'POST' && tail.length === 1) {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const name = parsed.value.name;
        if (typeof name !== 'string' || name === '') return errorReply(422, 'name is required');
        const existing = repo.labels.get(name.toLowerCase());
        if (existing) return jsonReply(201, labelJson(existing));
        const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
        const label = { name, color };
        repo.labels.set(name.toLowerCase(), label);
        return jsonReply(201, labelJson(label));
      }
      return errorReply(404, 'Not Found');
    }

    // ---- issues ----------------------------------------------------------------------
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') return handleListIssues(ctx, repo);
        if (method === 'POST') return handleCreateIssue(ctx, repo);
        return errorReply(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isSafeInteger(number) || number <= 0) return errorReply(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') {
          const issue = repo.issues.get(number);
          if (!issue) return errorReply(404, 'Not Found');
          return { status: 200, body: `${issueJson(ctx, repo, issue)}\n`, headers: { 'content-type': 'application/json; charset=utf-8' } };
        }
        if (method === 'PATCH') {
          const issue = repo.issues.get(number);
          if (!issue) return errorReply(404, 'Not Found');
          const parsed = parseJsonBody(ctx);
          if (!parsed.ok) return parsed.reply;
          if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
            issue.state = parsed.value.state;
            issue.closedAt = issue.state === 'closed' ? isoTime(ctx.store.nextTick()) : null;
          }
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          issue.updatedAt = isoTime(ctx.store.nextTick());
          issue.jsonCache = null;
          return { status: 200, body: `${issueJson(ctx, repo, issue)}\n`, headers: { 'content-type': 'application/json; charset=utf-8' } };
        }
        return errorReply(404, 'Not Found');
      }
      if (tail[2] === 'comments') {
        if (tail.length !== 3) return errorReply(404, 'Not Found');
        const issue = repo.issues.get(number);
        if (!issue) return errorReply(404, 'Not Found');
        if (method === 'GET') {
          return jsonReply(200, issue.comments.map((c) => commentJson(ctx, repo, issue, c)));
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(ctx);
          if (!parsed.ok) return parsed.reply;
          const body = parsed.value.body;
          if (typeof body !== 'string') return errorReply(422, 'body is required');
          const comment: IssueComment = {
            id: repo.nextCommentId++,
            body,
            user: ctx.store.viewerLogin,
            createdAt: isoTime(ctx.store.nextTick()),
          };
          issue.comments.push(comment);
          issue.jsonCache = null;
          return jsonReply(201, commentJson(ctx, repo, issue, comment));
        }
        return errorReply(404, 'Not Found');
      }
      return errorReply(404, 'Not Found');
    }

    // ---- pulls -----------------------------------------------------------------------
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') return handleListPulls(ctx, repo);
        if (method === 'POST') return handleCreatePull(ctx, repo);
        return errorReply(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isSafeInteger(number) || number <= 0) return errorReply(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') {
          const pull = repo.pulls.get(number);
          if (!pull) return errorReply(404, 'Not Found');
          return jsonReply(200, pullJson(ctx, repo, pull));
        }
        if (method === 'PATCH') {
          const pull = repo.pulls.get(number);
          if (!pull) return errorReply(404, 'Not Found');
          const parsed = parseJsonBody(ctx);
          if (!parsed.ok) return parsed.reply;
          if (parsed.value.state === 'closed' && pull.state === 'open') {
            pull.state = 'closed';
            pull.mergedAt = pull.mergedAt ?? isoTime(ctx.store.nextTick());
          }
          if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
          return jsonReply(200, pullJson(ctx, repo, pull));
        }
        return errorReply(404, 'Not Found');
      }
      if (tail[2] === 'files' && tail.length === 3 && method === 'GET') {
        const pull = repo.pulls.get(number);
        if (!pull) return errorReply(404, 'Not Found');
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        return jsonReply(200, diffForPull(repo, baseTip, headTip));
      }
      if (tail[2] === 'merge' && tail.length === 3 && method === 'PUT') {
        const pull = repo.pulls.get(number);
        if (!pull) return errorReply(404, 'Not Found');
        if (pull.state === 'closed') return errorReply(405, 'Pull request already merged or closed');
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const outcome = squashMerge(ctx.store, repo, pull);
        if (!outcome.ok) return errorReply(405, outcome.reason ?? 'merge conflict');
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = isoTime(ctx.store.nextTick());
        pull.mergeCommitSha = outcome.commitSha!;
        return jsonReply(200, { merged: true, sha: outcome.commitSha, message: `Pull request #${pull.number} merged` });
      }
      return errorReply(404, 'Not Found');
    }

    return errorReply(404, 'Not Found');
  }

  // A /api/v3 path that matched nothing above.
  return errorReply(404, 'Not Found');
}

function commentJson(ctx: RequestContext, repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const fullName = `${ctx.store.viewerLogin}/${repo.name}`;
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, comment.id),
    url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `${baseUrlOf(ctx)}/${fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(ctx.store),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
  };
}

function handleListIssues(ctx: RequestContext, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  else if (state !== 'all') issues = issues.filter((i) => i.state === 'open');
  const direction = ctx.query.get('direction') ?? 'desc';
  const sort = ctx.query.get('sort') ?? 'created';
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  const { page, link } = paginate(issues, ctx);
  const body = `[${page.map((i) => issueJson(ctx, repo, i)).join(',')}]`;
  return withLink({ status: 200, body: `${body}\n`, headers: { 'content-type': 'application/json; charset=utf-8' } }, link);
}

function handleCreateIssue(ctx: RequestContext, repo: Repo): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return parsed.reply;
  const title = parsed.value.title;
  if (typeof title !== 'string' || title === '') return errorReply(422, 'title is required');
  const labels: Issue['labels'] = [];
  const labelNames = parsed.value.labels;
  if (Array.isArray(labelNames)) {
    for (const name of labelNames) {
      if (typeof name !== 'string') return errorReply(422, 'labels must be strings');
      const label = repo.labels.get(name.toLowerCase());
      if (!label) return errorReply(422, `label ${JSON.stringify(name)} does not exist`);
      labels.push(label);
    }
  }
  const number = repo.nextNumber++;
  const tick = ctx.store.nextTick();
  const issue: Issue = {
    number,
    title,
    body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
    state: 'open',
    labels,
    comments: [],
    createdAt: isoTime(tick),
    updatedAt: isoTime(tick),
    closedAt: null,
    createdSeq: tick,
    jsonCache: null,
  };
  repo.issues.set(number, issue);
  return { status: 201, body: `${issueJson(ctx, repo, issue)}\n`, headers: { 'content-type': 'application/json; charset=utf-8' } };
}

function handleListPulls(ctx: RequestContext, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
  else if (state !== 'all') pulls = pulls.filter((p) => p.state === 'open');
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page, link } = paginate(pulls, ctx);
  return withLink(jsonReply(200, page.map((p) => pullJson(ctx, repo, p))), link);
}

function handleCreatePull(ctx: RequestContext, repo: Repo): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return parsed.reply;
  const title = parsed.value.title;
  const head = parsed.value.head;
  const base = parsed.value.base;
  if (typeof title !== 'string' || title === '') return errorReply(422, 'title is required');
  if (typeof head !== 'string' || typeof base !== 'string') return errorReply(422, 'head and base are required');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) return errorReply(422, 'head or base branch does not exist');
  const number = repo.nextNumber++;
  const tick = ctx.store.nextTick();
  const pull: Pull = {
    number,
    title,
    body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
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
  return jsonReply(201, pullJson(ctx, repo, pull));
}

function resolveRefTip(repo: Repo, refParam: string | undefined): string | null {
  if (refParam === undefined) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (isObjectId(refParam)) return refParam;
  return repo.refs.get(`refs/heads/${refParam}`) ?? repo.refs.get(refParam) ?? null;
}

function handleGetContents(ctx: RequestContext, repo: Repo, filePath: string): Reply {
  const refParam = ctx.query.get('ref') ?? undefined;
  const tip = resolveRefTip(repo, refParam);
  if (tip === null) return errorReply(404, 'Not Found');
  const tipObject = repo.objects.get(tip);
  if (!tipObject || tipObject.type !== 'commit') return errorReply(404, 'Not Found');
  const rootTree = parseCommit(tipObject.data).tree;
  const fullName = `${ctx.store.viewerLogin}/${repo.name}`;
  if (filePath === '') {
    const entries = flattenTree(repo, rootTree);
    const top = new Map<string, { type: string; oid: string }>();
    for (const [path, entry] of entries) {
      const first = path.split('/')[0]!;
      if (!top.has(first)) top.set(first, { type: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid });
      if (entry.mode === '40000') top.set(first, { type: 'dir', oid: entry.oid });
    }
    const list = [...top.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, entry]) => ({ type: entry.type, name, path: name, sha: entry.oid, size: 0 }));
    return jsonReply(200, list);
  }
  const found = treeLookup(repo, rootTree, filePath);
  if (found === null) return errorReply(404, 'Not Found');
  if (found.mode === '40000') {
    const flat = flattenTree(repo, rootTree);
    const prefix = `${filePath}/`;
    const children = new Map<string, { type: string; oid: string; size: number }>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        children.set(first, { type: 'dir', oid: entry.oid, size: 0 });
      } else if (!children.has(first)) {
        const blob = repo.objects.get(entry.oid);
        children.set(first, { type: 'file', oid: entry.oid, size: blob?.data.length ?? 0 });
      }
    }
    const list = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, entry]) => ({ type: entry.type, name, path: `${filePath}/${name}`, sha: entry.oid, size: entry.size }));
    return jsonReply(200, list);
  }
  const blob = repo.objects.get(found.oid);
  if (!blob || blob.type !== 'blob') return errorReply(404, 'Not Found');
  return jsonReply(200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: filePath.split('/').pop() ?? filePath,
    path: filePath,
    content: blob.data.toString('base64'),
    sha: found.oid,
    url: `${baseUrlOf(ctx)}/api/v3/repos/${fullName}/contents/${filePath}`,
    html_url: `${baseUrlOf(ctx)}/${fullName}/blob/${repo.defaultBranch}/${filePath}`,
  });
}

function handlePutContents(ctx: RequestContext, repo: Repo, filePath: string): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return parsed.reply;
  const message = parsed.value.message;
  const content = parsed.value.content;
  if (typeof message !== 'string' || typeof content !== 'string') return errorReply(422, 'message and content are required');
  const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
  const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : null;
  const bytes = b64decodeLoose(content);
  try {
    const result = commitFile(ctx.store, repo, branch, filePath, bytes, message, sha);
    return jsonReply(result.isCreate ? 201 : 200, {
      content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'stale-sha') return errorReply(409, 'sha does not match the current blob');
    if (err instanceof Error && err.message === 'not-found') return errorReply(404, 'Not Found');
    return errorReply(422, err instanceof Error ? err.message : 'cannot commit this file');
  }
}

function handleDeleteContents(ctx: RequestContext, repo: Repo, filePath: string): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return parsed.reply;
  const message = parsed.value.message;
  const sha = parsed.value.sha;
  if (typeof message !== 'string' || typeof sha !== 'string') return errorReply(422, 'message and sha are required');
  try {
    const result = commitFile(ctx.store, repo, repo.defaultBranch, filePath, null, message, sha);
    return jsonReply(200, { commit: { sha: result.commitSha, message } });
  } catch (err) {
    if (err instanceof Error && err.message === 'stale-sha') return errorReply(409, 'sha does not match the current blob');
    if (err instanceof Error && err.message === 'not-found') return errorReply(404, 'Not Found');
    return errorReply(422, err instanceof Error ? err.message : 'cannot delete this file');
  }
}

/** Wrap a REST reply with the request id the wire contract requires on every reply. */
export function withRequestId(reply: Reply): Reply {
  requestSeq += 1;
  const id = `req-${requestSeq.toString(16).padStart(8, '0')}`;
  reply.headers = { 'x-github-request-id': id, ...reply.headers };
  return reply;
}
