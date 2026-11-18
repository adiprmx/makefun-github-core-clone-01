// In-memory forge store: repositories, git objects, refs, issues, pull requests, labels.
//
// Design notes:
// - Everything lives in Maps; no disk, no git binary. Deterministic timestamps come from a
//   monotonic counter (1700000000 + seq) so two runs of the same request sequence produce the
//   same bytes — the trial replays its export byte for byte.
// - The viewer login is the scenario's deterministic one ("adaiversen"); it is confirmed (or,
//   defensively, learned) from the first owner-bearing request that carries a valid token, so
//   the suite's owner routing works even if the scenario seed ever changed.
// - Issue and pull-request numbers share one per-repo counter, as on GitHub.

import {
  buildCommit,
  buildTree,
  collectReachable,
  compareTreeNames,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN_DEFAULT = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
const EPOCH_SEC = 1700000000;

export interface IssueLabel {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: IssueLabel[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdSeq: number;
  jsonCache: string | null;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
  jsonCache: string | null;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, IssueLabel>;
  nextNumber: number;
  nextCommentId: number;
  commitSeq: number;
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

export function isoTime(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

/** Opaque, stable global id (Relay-style): base64 of "<Kind>:<repoId>:<number>". */
export function globalId(kind: string, repoId: number, number: number): string {
  return Buffer.from(`${kind}:${repoId}:${number}`, 'utf8').toString('base64');
}

export function globalIdRepo(repoId: number): string {
  return Buffer.from(`Repository:${repoId}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repoId = Number(parts[1]);
    if (!Number.isSafeInteger(repoId)) return null;
    const number = parts.length >= 3 ? Number(parts[2]) : 0;
    return { kind, repoId, number: Number.isSafeInteger(number) ? number : 0 };
  } catch {
    return null;
  }
}

export class Store {
  viewerLogin: string = VIEWER_LOGIN_DEFAULT;
  viewerConfirmed = false;
  reposByName: Map<string, Repo> = new Map();
  reposById: Map<number, Repo> = new Map();
  repoSeq = 1;
  clock = 0;

  nextTick(): number {
    this.clock += 1;
    return this.clock;
  }

  /** Confirm (or, before any repo exists, learn) the viewer login from an owner segment. */
  confirmViewer(owner: string): void {
    if (this.viewerConfirmed) return;
    this.viewerLogin = owner;
    this.viewerConfirmed = true;
  }

  /** True when `owner` names the token holder (case-insensitive, as GitHub treats logins). */
  isViewer(owner: string): boolean {
    return owner.toLowerCase() === this.viewerLogin.toLowerCase();
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = name.toLowerCase();
    if (this.reposByName.has(key)) return null;
    const repo: Repo = {
      id: this.repoSeq++,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextTick(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitSeq: 0,
      packCache: new Map(),
    };
    this.reposByName.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (!this.isViewer(owner)) return null;
    return this.reposByName.get(name.toLowerCase()) ?? null;
  }

  getRepoById(id: number): Repo | null {
    return this.reposById.get(id) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.reposByName.delete(repo.name.toLowerCase());
    this.reposById.delete(repo.id);
  }

  listViewerRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.packCache.clear();
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const had = repo.refs.delete(ref);
    if (had) repo.packCache.clear();
    return had;
  }

  /** All refs, sorted by name (refs/heads/* first in git's order — plain lexicographic sort). */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  branches(repo: Repo): Array<{ name: string; oid: string }> {
    return this.listRefs(repo)
      .filter((r) => r.name.startsWith('refs/heads/'))
      .map((r) => ({ name: r.name.slice('refs/heads/'.length), oid: r.oid }));
  }
}

// ---------------------------------------------------------------------------------------------
// trees: read a path, update a path (nested), flatten
// ---------------------------------------------------------------------------------------------

export interface PathEntry {
  oid: string;
  mode: string;
}

/** The blob (or subtree) at `path` in the tree `rootOid`, or null when absent. */
export function treeLookup(repo: Repo, rootOid: string | null, path: string): PathEntry | null {
  if (rootOid === null || rootOid === ZERO_OID) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let currentOid = rootOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentOid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  return null;
}

/** Flatten a tree into path -> entry (files and subtrees; gitlinks skipped). */
export function flattenTree(repo: Repo, rootOid: string | null, prefix = ''): Map<string, PathEntry> {
  const out = new Map<string, PathEntry>();
  if (rootOid === null || rootOid === ZERO_OID) return out;
  const walk = (treeOid: string, base: string): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') {
        out.set(path, { oid: entry.oid, mode: entry.mode });
        walk(entry.oid, path);
      } else if (entry.mode !== '160000') {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  };
  walk(rootOid, prefix);
  return out;
}

/**
 * Return a new root tree with `path` set to `blobOid` (or deleted when `blobOid` is null).
 * Intermediate trees are created/stored as needed; empty directories are pruned.
 */
export function updateTreePath(repo: Repo, rootOid: string | null, path: string, blobOid: string | null, mode = '100644'): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new Error('empty path');
  const build = (treeOid: string | null, depth: number): string | null => {
    const entries: TreeEntry[] = treeOid !== null && treeOid !== ZERO_OID ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
    const name = segments[depth]!;
    const idx = entries.findIndex((e) => e.name === name);
    if (depth === segments.length - 1) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode, name, oid: blobOid };
      } else {
        entries.push({ mode, name, oid: blobOid });
      }
    } else {
      const childOid = idx >= 0 ? entries[idx]!.oid : null;
      const next = build(childOid, depth + 1);
      if (next === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, oid: next };
      } else {
        entries.push({ mode: '40000', name, oid: next });
      }
    }
    if (entries.length === 0) return null;
    const data = buildTree(entries);
    return hashObject('tree', data) === treeOid
      ? treeOid
      : (() => {
          const oid = hashObject('tree', data);
          if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
          return oid;
        })();
  };
  const result = build(rootOid, 0);
  if (result === null) {
    // An empty tree object (git's well-known empty tree).
    const empty = buildTree([]);
    const oid = hashObject('tree', empty);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data: empty });
    return oid;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// commits: list, create via contents, merge base, diff
// ---------------------------------------------------------------------------------------------

/** Commits reachable from `tip`, newest first (parents after the commit itself, BFS by depth). */
export function listCommits(repo: Repo, tip: string | null): Array<{ sha: string; message: string; tree: string; parents: string[] }> {
  const out: Array<{ sha: string; message: string; tree: string; parents: string[] }> = [];
  if (tip === null || tip === ZERO_OID) return out;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, tree: commit.tree, parents: commit.parents });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

export interface ContentsCommit {
  commitSha: string;
  blobSha: string;
  isCreate: boolean;
}

/**
 * Create (or update) one file on `branch` through the contents API's semantics: a new blob,
 * an updated tree, a commit on top of the branch tip (or a root commit on an unborn branch),
 * and the ref moved. `expectedBlobSha` enforces the 409 stale-sha rule (null = no check).
 * Throws Error('not-found' | 'stale-sha' | 'empty-branch') for the API to translate.
 */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  expectedBlobSha: string | null,
): ContentsCommit {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  let baseTree: string | null = null;
  let parents: string[] = [];
  if (tip !== null && tip !== ZERO_OID) {
    const tipObject = repo.objects.get(tip);
    if (!tipObject || tipObject.type !== 'commit') throw new Error('bad-tip');
    const tipCommit = parseCommit(tipObject.data);
    baseTree = tipCommit.tree;
    parents = [tip];
  }
  const current = baseTree === null ? null : treeLookup(repo, baseTree, path);
  if (expectedBlobSha !== null) {
    if (current === null || current.oid.toLowerCase() !== expectedBlobSha.toLowerCase()) throw new Error('stale-sha');
  }
  if (content === null) {
    if (current === null) throw new Error('not-found');
  }
  let blobSha = '';
  if (content !== null) {
    blobSha = hashObject('blob', content);
    if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: content });
  } else {
    blobSha = current!.oid;
  }
  const isCreate = current === null;
  const newTree = updateTreePath(repo, baseTree, path, content === null ? null : blobSha);
  repo.commitSeq += 1;
  const timestamp = EPOCH_SEC + repo.commitSeq;
  const commitData = buildCommit({ tree: newTree, parents, message, timestamp });
  const commitSha = hashObject('commit', commitData);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commitData });
  repo.refs.set(ref, commitSha);
  repo.packCache.clear();
  return { commitSha, blobSha, isCreate };
}

/** The nearest common ancestor of `a` and `b` (first found walking `b`'s ancestry), or null. */
export function mergeBase(repo: Repo, a: string | null, b: string | null): string | null {
  if (a === null || b === null || a === ZERO_OID || b === ZERO_OID) return null;
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** A small line diff: additions/deletions between two texts (LCS on lines, files here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 0 && oldText.endsWith('\n')) a.pop();
  if (b.length > 0 && newText.endsWith('\n')) b.pop();
  const n = a.length;
  const m = b.length;
  // LCS length via a single-row DP.
  const dp = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    let prev = 0;
    for (let j = 1; j <= m; j += 1) {
      const temp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = temp;
    }
  }
  const common = dp[m]!;
  return { additions: m - common, deletions: n - common };
}

/** Files changed between the trees at `baseOid` and `headOid` (base -> head). */
export function diffTrees(repo: Repo, baseOid: string | null, headOid: string | null): FileChange[] {
  const base = flattenTree(repo, baseOid);
  const head = flattenTree(repo, headOid);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && b.mode === '40000') continue;
    if (h && h.mode === '40000') continue;
    if (!b && h) {
      const text = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const additions = countLines(text);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const text = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const deletions = countLines(text);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Files changed between the merge-base of two tips and the head tip (what a PR shows). */
export function diffForPull(repo: Repo, baseTip: string | null, headTip: string | null): FileChange[] {
  const base = mergeBase(repo, baseTip, headTip);
  const headObject = headTip !== null ? repo.objects.get(headTip) : undefined;
  const headTree = headObject && headObject.type === 'commit' ? parseCommit(headObject.data).tree : null;
  const baseObject = base !== null ? repo.objects.get(base) : undefined;
  const baseTree = baseObject && baseObject.type === 'commit' ? parseCommit(baseObject.data).tree : null;
  return diffTrees(repo, baseTree, headTree);
}

// ---------------------------------------------------------------------------------------------
// pull-request merge (squash)
// ---------------------------------------------------------------------------------------------

export interface MergePlan {
  ok: boolean;
  reason?: string;
  baseTip: string;
  headTip: string;
  newTree: string;
}

/** Plan a squash-merge without applying it: conflict test + resulting tree. */
export function planMerge(repo: Repo, pull: Pull): MergePlan {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef) ?? null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (baseTip === null || baseTip === ZERO_OID) return { ok: false, reason: 'base branch has no commits', baseTip: '', headTip, newTree: '' };
  const base = mergeBase(repo, baseTip, headTip);
  const baseObject = base !== null ? repo.objects.get(base) : undefined;
  const baseTree = baseObject && baseObject.type === 'commit' ? parseCommit(baseObject.data).tree : null;
  const headObject = repo.objects.get(headTip);
  if (!headObject || headObject.type !== 'commit') return { ok: false, reason: 'head branch has no commits', baseTip, headTip, newTree: '' };
  const headTree = parseCommit(headObject.data).tree;
  const baseTipObject = repo.objects.get(baseTip);
  const baseTipTree = baseTipObject && baseTipObject.type === 'commit' ? parseCommit(baseTipObject.data).tree : null;
  if (baseTipTree === null) return { ok: false, reason: 'base branch has no commits', baseTip, headTip, newTree: '' };

  const changes = diffTrees(repo, baseTree, headTree);
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headTree);
  const tipFlat = flattenTree(repo, baseTipTree);
  for (const change of changes) {
    const baseEntry = baseFlat.get(change.filename);
    const headEntry = headFlat.get(change.filename);
    const tipEntry = tipFlat.get(change.filename);
    const baseOid = baseEntry?.oid ?? null;
    const headOid = headEntry?.oid ?? null;
    const tipOid = tipEntry?.oid ?? null;
    // The base side moved this file away from the merge-base, and not to the head's version.
    if (tipOid !== baseOid && tipOid !== headOid) {
      return { ok: false, reason: 'merge conflict', baseTip, headTip, newTree: '' };
    }
  }
  // Apply the head's tree over the base tip's tree, file by file.
  let newTree = baseTipTree;
  for (const change of changes) {
    const headEntry = headFlat.get(change.filename);
    if (headEntry && headEntry.mode !== '40000') {
      newTree = updateTreePath(repo, newTree, change.filename, headEntry.oid, headEntry.mode);
    } else {
      newTree = updateTreePath(repo, newTree, change.filename, null);
    }
  }
  return { ok: true, baseTip, headTip, newTree };
}

export interface MergeOutcome {
  ok: boolean;
  reason?: string;
  commitSha?: string;
}

/**
 * Squash-merge `pull` onto its base branch. Conflict when a file the head changed (vs the
 * merge-base) was also changed on the base tip to different bytes.
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  const plan = planMerge(repo, pull);
  if (!plan.ok) return { ok: false, reason: plan.reason ?? 'merge conflict' };
  const baseRef = `refs/heads/${pull.baseRef}`;
  repo.commitSeq += 1;
  const timestamp = EPOCH_SEC + repo.commitSeq;
  const message = `${pull.title}\n\nSquash-merge of pull request #${pull.number}.`;
  const commitData = buildCommit({ tree: plan.newTree, parents: [plan.baseTip], message, timestamp });
  const commitSha = hashObject('commit', commitData);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commitData });
  repo.refs.set(baseRef, commitSha);
  repo.packCache.clear();
  return { ok: true, commitSha };
}

/** True when `oid` is an ancestor of (or equal to) `tip` — the fast-forward test for pushes. */
export function isFastForward(repo: Repo, oldTip: string, newTip: string): boolean {
  if (oldTip === ZERO_OID) return true;
  return isAncestor((oid) => repo.objects.get(oid), oldTip, newTip);
}

/** Objects the server must send for wants, given the client's haves (upload-pack). */
export function objectsForFetch(repo: Repo, wants: readonly string[], haves: readonly string[]): GitObject[] {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const onClient = collectReachable(haves, lookup, { allowMissing: true });
  const wanted = collectReachable(wants, lookup);
  const send: GitObject[] = [];
  for (const oid of wanted) {
    if (onClient.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push(object);
  }
  return send;
}
