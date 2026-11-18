// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0) and
// receive-pack (v0). The wire shapes mirror the suite's git client exactly:
//   - v2 advertisement opens with "version 2"; v0 opens with "# service=..." + flush.
//   - v2 fetch answers named sections (acknowledgments, shallow-info, wanted-refs, packfile)
//     separated by delim, the packfile carried in sideband band-1 packets.
//   - v0 fetch answers plain NAK/ACK/shallow lines, then the sideband pack.
//   - receive-pack answers a report-status pkt-line stream inside sideband band-1.
// A malformed request never crashes the server: it answers 400 and stays up.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  encodeSideband,
  encodeSidebandData,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { objectsForFetch, type Repo, type Store } from './store.ts';

export interface GitContext {
  store: Store;
  token: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitReply {
  status: number;
  body: Buffer | null;
  headers?: Record<string, string>;
}

const AGENT = 'forge/1.0';
const UPLOAD_V2_CAPS = ['ls-refs=unborn', 'fetch=shallow wait-for-done filter', 'object-format=sha1', `agent=${AGENT}`];
const UPLOAD_V0_CAPS = `side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs agent=${AGENT}`;

function gitReply(status: number, body: Buffer | null, contentType: string): GitReply {
  return { status, body, headers: { 'content-type': contentType } };
}

function bearerToken(ctx: GitContext): string | null {
  const header = ctx.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function isAuthorized(ctx: GitContext): boolean {
  const presented = bearerToken(ctx);
  if (presented === null || presented === '') return false;
  if (ctx.token === '') return true;
  return presented === ctx.token;
}

/** The repo for a /{owner}/{name}.git path, or null (unknown owner or repo). */
function resolveGitRepo(ctx: GitContext, owner: string, name: string): Repo | null {
  if (!ctx.store.isViewer(owner)) return null;
  return ctx.store.getRepo(owner, name);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** All refs as advertisement lines, HEAD first (with symref), then heads, then tags (+peeled). */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const heads = repo.refs.get('refs/heads/main');
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) {
    out.push({ oid: defaultTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else if (heads !== undefined) {
    out.push({ oid: heads, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        line.peeled = parseTag(object.data).object;
      }
    }
    out.push(line);
  }
  return out;
}

function advertisementUploadV2(): Buffer {
  const lines: Array<string | 'flush'> = ['version 2\n', ...UPLOAD_V2_CAPS.map((c) => `${c}\n`), 'flush'];
  return encodePktLines(lines);
}

function advertisementUploadV0(repo: Repo): Buffer {
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      const caps = index === 0 ? `\0${UPLOAD_V0_CAPS}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${caps}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function advertisementReceiveV0(repo: Repo): Buffer {
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), Buffer.from('0000', 'ascii')];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_V0_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      const caps = index === 0 ? `\0${RECEIVE_V0_CAPS}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${caps}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
  filter: string | null;
}

/** Commits reachable from `roots` within `maxDepth` parent steps (want = depth 0). */
function commitsWithinDepth(repo: Repo, roots: readonly string[], maxDepth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    const parents = parseCommit(object.data).parents;
    if (depth + 1 > maxDepth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { included, boundary };
}

/** Objects for a fetch: commits within depth + their trees/blobs, minus the client's haves. */
function fetchObjects(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Objects the client already has. A have that is also a client shallow boundary is only
  // the commit and its tree — its parents are NOT on the client, so a deepen past it must
  // still send them. Other haves are full-history: the whole ancestry is present.
  const onClient = new Set<string>();
  const shallowSet = new Set(args.shallows);
  for (const have of args.haves) {
    if (shallowSet.has(have)) {
      const object = lookup(have);
      if (!object) continue;
      onClient.add(have);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        onClient.add(commit.tree);
        const stack = [commit.tree];
        while (stack.length) {
          const treeOid = stack.pop()!;
          const treeObject = repo.objects.get(treeOid);
          if (!treeObject || treeObject.type !== 'tree') continue;
          onClient.add(treeOid);
          for (const entry of parseTree(treeObject.data)) {
            onClient.add(entry.oid);
            if (entry.mode === '40000') stack.push(entry.oid);
          }
        }
      }
    } else {
      for (const oid of collectReachable([have], lookup, { allowMissing: true })) onClient.add(oid);
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  let wanted: Set<string>;
  if (args.depth !== null) {
    const { included, boundary } = commitsWithinDepth(repo, args.wants, args.depth - 1);
    wanted = new Set<string>();
    for (const oid of included) {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      wanted.add(oid);
      wanted.add(commit.tree);
      const stack = [commit.tree];
      while (stack.length) {
        const treeOid = stack.pop()!;
        const treeObject = repo.objects.get(treeOid);
        if (!treeObject || treeObject.type !== 'tree') continue;
        wanted.add(treeOid);
        for (const entry of parseTree(treeObject.data)) {
          wanted.add(entry.oid);
          if (entry.mode === '40000') stack.push(entry.oid);
        }
      }
    }
    for (const oid of boundary) shallow.push(oid);
    // A client shallow boundary that is now fully included (its parents are too) is unshallow.
    for (const oid of args.shallows) {
      if (included.has(oid)) {
        const commit = repo.objects.get(oid);
        if (commit && commit.type === 'commit') {
          const parents = parseCommit(commit.data).parents;
          if (parents.every((p) => included.has(p))) unshallow.push(oid);
        }
      }
    }
  } else {
    wanted = collectReachable(args.wants, lookup);
  }
  if (args.filter === 'blob:none') {
    for (const oid of [...wanted]) {
      const object = lookup(oid);
      if (object && object.type === 'blob') wanted.delete(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (onClient.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

function handleLsRefsV2(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD' && !symrefs) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.symrefTarget !== undefined && symrefs) line += ` symref-target:${ref.symrefTarget}`;
      if (ref.peeled !== undefined && peel) line += ` peeled:${ref.peeled}`;
      parts.push(encodePktLine(`${line}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  // Acknowledgments: NAK when the client has nothing in common; otherwise one ACK + ready.
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const ackLines: string[] = [];
  let nak = true;
  if (args.haves.length > 0) {
    const wanted = collectReachable(args.wants, lookup, { allowMissing: true });
    for (const have of args.haves) {
      if (wanted.has(have)) {
        ackLines.push(`ACK ${have}\n`);
        nak = false;
        break;
      }
    }
  }
  const cacheKey = `${repo.id}|${[...args.wants].sort().join(',')}|${args.depth ?? ''}|${[...args.haves].sort().join(',')}|${args.filter ?? ''}`;
  const cached = repo.packCache.get(cacheKey);
  let pack: Buffer;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (cached === undefined) {
    const result = fetchObjects(repo, args);
    shallow = result.shallow;
    unshallow = result.unshallow;
    pack = writePack(result.objects, 1);
    repo.packCache.set(cacheKey, { pack, shallow, unshallow });
  } else {
    pack = cached.pack;
    shallow = cached.shallow;
    unshallow = cached.unshallow;
  }
  const wantedRefs: string[] = [];
  for (const want of args.wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedRefs.push(`${want} ${name}\n`);
    }
  }
  const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
  if (nak) parts.push(encodePktLine('NAK\n'));
  else {
    for (const line of ackLines) parts.push(encodePktLine(line));
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (wantedRefs.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(encodePktLine(line));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSidebandData(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  let command: string | null = null;
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    args.push(line.replace(/\n$/, ''));
  }
  if (command === 'ls-refs') return handleLsRefsV2(repo, args);
  if (command === 'fetch') {
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallows: [], depth: null, filter: null };
    for (const arg of args) {
      if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) fetchArgs.shallows.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) fetchArgs.depth = Number(arg.slice(7).trim());
      else if (arg.startsWith('filter ')) fetchArgs.filter = arg.slice(7).trim();
    }
    fetchArgs.wants = [...new Set(fetchArgs.wants)];
    return handleFetchV2(repo, fetchArgs);
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0
// ---------------------------------------------------------------------------------------------

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decodePktLines(body, { allowTrailing: true });
  void rest;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenFlush) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const parts: Buffer[] = [];
  let nak = true;
  if (haves.length > 0) {
    const wanted = collectReachable(wants, lookup, { allowMissing: true });
    for (const have of haves) {
      if (wanted.has(have)) {
        parts.push(encodePktLine(`ACK ${have}\n`));
        nak = false;
        break;
      }
    }
  }
  if (nak) parts.push(encodePktLine('NAK\n'));
  const args: FetchArgs = { wants: [...new Set(wants)], haves, shallows, depth, filter: null };
  const cacheKey = `v0|${repo.id}|${[...args.wants].sort().join(',')}|${args.depth ?? ''}|${[...args.haves].sort().join(',')}`;
  const cached = repo.packCache.get(cacheKey);
  let pack: Buffer;
  let shallow: string[] = [];
  if (cached === undefined) {
    const result = fetchObjects(repo, args);
    shallow = result.shallow;
    pack = writePack(result.objects, 1);
    repo.packCache.set(cacheKey, { pack, shallow, unshallow: result.unshallow });
  } else {
    pack = cached.pack;
    shallow = cached.shallow;
  }
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  parts.push(encodeSidebandData(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decodePktLines(body, { allowTrailing: true });
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) throw new Error('receive-pack got no commands');

  const reportLines: string[] = [];
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = 'empty pack';
    } else {
      try {
        const read = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
        if (!read.checksumOk) throw new Error('pack checksum mismatch');
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (repo.refs.has(command.ref)) {
          repo.refs.delete(command.ref);
          repo.packCache.clear();
          reportLines.push(`ok ${command.ref}\n`);
        } else {
          reportLines.push(`ng ${command.ref} no such ref\n`);
        }
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      const isTagRef = command.ref.startsWith('refs/tags/');
      if (!newObject || (isTagRef ? newObject.type !== 'commit' && newObject.type !== 'tag' : newObject.type !== 'commit')) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        repo.packCache.clear();
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} no such ref\n`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      // Fast-forward: the old tip must be an ancestor of the new tip.
      let ff = false;
      if (current === command.newOid) ff = true;
      else {
        // Peel annotated tags to their target commit before walking ancestry.
        let walkStart = command.newOid;
        for (let hops = 0; hops < 10; hops++) {
          const obj = repo.objects.get(walkStart);
          if (!obj || obj.type !== 'tag') break;
          walkStart = parseTag(obj.data).object;
        }
        const seen = new Set<string>();
        const queue: string[] = [walkStart];
        while (queue.length) {
          const oid = queue.pop()!;
          if (oid === current) {
            ff = true;
            break;
          }
          if (seen.has(oid)) continue;
          seen.add(oid);
          const object = repo.objects.get(oid);
          if (!object || object.type !== 'commit') continue;
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      }
      if (!ff) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      repo.packCache.clear();
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  const report = encodePktLines([...reportLines, 'flush']);
  // The report stream is pkt-framed inside band 1; chunk it like any sideband payload.
  const chunked: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += 65515) {
    chunked.push(encodeSideband(1, report.subarray(offset, Math.min(report.length, offset + 65515))));
  }
  if (chunked.length === 0) chunked.push(encodeSideband(1, Buffer.alloc(0)));
  chunked.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(chunked);
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/** The git router: returns a reply when it handled the request, null to fall through. */
export function handleGit(ctx: GitContext): GitReply | null {
  const { method, path } = ctx;
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (match === null) return null;
  const owner = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[2]!);
  const servicePath = match[3]!;

  if (!isAuthorized(ctx)) {
    return gitReply(401, Buffer.from('Unauthorized', 'utf8'), 'text/plain; charset=utf-8');
  }
  ctx.store.confirmViewer(owner);
  const repo = resolveGitRepo(ctx, owner, name);
  if (repo === null) {
    return gitReply(404, Buffer.from('Not Found', 'utf8'), 'text/plain; charset=utf-8');
  }

  try {
    if (method === 'GET' && servicePath === 'info/refs') {
      const service = ctx.query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
        const body = v2 ? advertisementUploadV2() : advertisementUploadV0(repo);
        return gitReply(200, body, 'application/x-git-upload-pack-advertisement');
      }
      if (service === 'git-receive-pack') {
        return gitReply(200, advertisementReceiveV0(repo), 'application/x-git-receive-pack-advertisement');
      }
      return gitReply(404, Buffer.from('Not Found', 'utf8'), 'text/plain; charset=utf-8');
    }
    if (method === 'POST' && servicePath === 'git-upload-pack') {
      const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? handleUploadPackV2(repo, ctx.body) : handleUploadPackV0(repo, ctx.body);
      return gitReply(200, body, 'application/x-git-upload-pack-result');
    }
    if (method === 'POST' && servicePath === 'git-receive-pack') {
      const body = handleReceivePack(repo, ctx.body);
      return gitReply(200, body, 'application/x-git-receive-pack-result');
    }
  } catch (err) {
    // A malformed pkt-line or pack must not take the server down: answer 400, stay up.
    const detail = err instanceof Error ? err.message : 'bad request';
    return gitReply(400, Buffer.from(`Bad Request: ${detail}`, 'utf8'), 'text/plain; charset=utf-8');
  }
  return gitReply(404, Buffer.from('Not Found', 'utf8'), 'text/plain; charset=utf-8');
}