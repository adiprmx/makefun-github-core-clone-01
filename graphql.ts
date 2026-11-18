// GitHub GraphQL v4 for exactly the documents gh and github-mcp-server send: a small
// recursive-descent parser for the query language subset in play (operations, variables,
// aliases, inline fragments, object/list/enum arguments) plus a typed resolver over the
// same store REST uses, so a mutation over GraphQL reads back over REST and vice versa.
//
// Introspection is served from a static field table: __type(name) lists the fields the
// suite probes for (Issue, PullRequest, Repository, SearchType).

import {
  diffForPull,
  globalId,
  parseGlobalId,
  planMerge,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface GraphQLContext {
  store: Store;
  token: string;
  body: Buffer;
}

export interface GraphQLReply {
  status: number;
  body: string;
}

// ---------------------------------------------------------------------------------------------
// tokenizer + parser (query language subset)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      if (input.slice(i, i + 2) === '""') {
        // Block string: take it literally, trimming the common indent is unnecessary here.
        const end = input.indexOf('"""', i + 3);
        value = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        i = end < 0 ? input.length : end + 3;
      } else {
        while (i < input.length && input[i] !== '"') {
          if (input[i] === '\\' && i + 1 < input.length) {
            const esc = input[i + 1]!;
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            i += 2;
          } else {
            value += input[i];
            i += 1;
          }
        }
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] };

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') {
          name = this.next().value as string;
        }
        const variables: string[] = [];
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '$') {
              this.next();
              variables.push(this.expectName());
            } else {
              this.next();
            }
            if (this.peek() === undefined) throw new Error('unterminated variable definitions');
          }
        }
        operations.push({ type, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments do not occur in the suite's documents; skip the definition.
        this.next();
        this.expectName();
        if (this.peek()?.kind === 'name' && (this.peek() as { value: string }).value === 'on') this.next();
        this.expectName();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${token.value} at document top level`);
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        let typeCondition: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@include/@skip): accepted and ignored.
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selection: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema: field tables for introspection + validation
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description',
    'isPrivate', 'createdAt', 'updatedAt',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
};

const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type GqlValue =
  | { __type: string; __value: Record<string, unknown> }
  | { __type: string; __list: GqlValue[] }
  | { __type: string; __scalar: unknown };

function obj(type: string, value: Record<string, unknown>): GqlValue {
  return { __type: type, __value: value };
}
function scalar(type: string, value: unknown): GqlValue {
  return { __type: type, __scalar: value };
}

function fieldType(parentType: string, fieldName: string): string {
  switch (parentType) {
    case 'Query':
      if (fieldName === 'viewer') return 'User';
      if (fieldName === 'repository') return 'Repository';
      if (fieldName === 'node') return 'Node';
      if (fieldName === '__type') return '__Type';
      return 'Unknown';
    case 'Repository':
      if (fieldName === 'owner') return 'User';
      if (fieldName === 'defaultBranchRef') return 'Ref';
      if (fieldName === 'issue') return 'Issue';
      if (fieldName === 'issues') return 'IssueConnection';
      if (fieldName === 'pullRequests') return 'PullRequestConnection';
      if (fieldName === 'pullRequest') return 'PullRequest';
      return 'Scalar';
    case 'IssueConnection':
      if (fieldName === 'nodes') return 'Issue[]';
      if (fieldName === 'pageInfo') return 'PageInfo';
      return 'Scalar';
    case 'PullRequestConnection':
      if (fieldName === 'nodes') return 'PullRequest[]';
      if (fieldName === 'pageInfo') return 'PageInfo';
      return 'Scalar';
    case 'PullRequest':
      if (fieldName === 'files') return 'PullRequestChangedFileConnection';
      return 'Scalar';
    case 'PullRequestChangedFileConnection':
      if (fieldName === 'nodes') return 'PullRequestChangedFile[]';
      if (fieldName === 'pageInfo') return 'PageInfo';
      return 'Scalar';
    case 'AddCommentPayload':
      if (fieldName === 'commentEdge') return 'IssueCommentEdge';
      return 'Scalar';
    case 'IssueCommentEdge':
      if (fieldName === 'node') return 'IssueComment';
      return 'Scalar';
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (fieldName === 'issue') return 'Issue';
      return 'Scalar';
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (fieldName === 'pullRequest') return 'PullRequest';
      return 'Scalar';
    case '__Type':
      if (fieldName === 'fields') return '__Field[]';
      if (fieldName === 'enumValues') return '__EnumValue[]';
      return 'Scalar';
    default:
      return 'Scalar';
  }
}

function resolveField(
  ctx: ExecContext,
  parentType: string,
  parent: GqlValue | null,
  field: FieldNode,
): GqlValue | null {
  const fields = TYPE_FIELDS[parentType];
  if (fields !== undefined && !fields.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  }
  const args = argsOf(field, ctx.variables);
  const value = parent !== null && parent.__type === parentType ? (parent as { __value: Record<string, unknown> }).__value : {};
  const nextType = fieldType(parentType, field.name);

  // Root fields.
  if (parentType === 'Query') {
    if (field.name === 'viewer') return obj('User', { login: ctx.store.viewerLogin });
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (!ctx.store.isViewer(owner)) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === null ? null : obj('Repository', { __repo: repo });
    }
    if (field.name === 'node') {
      const id = args.id as string;
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      const repo = ctx.store.getRepoById(parsed.repoId);
      if (repo === null) return null;
      if (parsed.kind === 'Repository') return obj('Repository', { __repo: repo });
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.get(parsed.number);
        return issue ? obj('Issue', { __repo: repo, __issue: issue }) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const pull = repo.pulls.get(parsed.number);
        return pull ? obj('PullRequest', { __repo: repo, __pull: pull }) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      if (typeof name !== 'string') return null;
      return obj('__Type', { __typeName: name });
    }
    return null;
  }

  if (parentType === '__Type') {
    const typeName = value.__typeName as string;
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[typeName] ?? [];
      return { __type: '__Field[]', __list: names.map((n) => obj('__Field', { name: n })) };
    }
    if (field.name === 'enumValues') {
      const names = TYPE_ENUM_VALUES[typeName] ?? [];
      return { __type: '__EnumValue[]', __list: names.map((n) => obj('__EnumValue', { name: n })) };
    }
    if (field.name === 'name') return scalar('String', typeName);
    if (field.name === 'kind') return scalar('String', 'OBJECT');
    return scalar('String', null);
  }

  if (parentType === 'Repository') {
    const repo = value.__repo as Repo;
    switch (field.name) {
      case 'id':
        return scalar('ID', globalId('Repository', repo.id, 0));
      case 'databaseId':
        return scalar('Int', repo.id);
      case 'name':
        return scalar('String', repo.name);
      case 'nameWithOwner':
        return scalar('String', `${ctx.store.viewerLogin}/${repo.name}`);
      case 'owner':
        return obj('User', { login: ctx.store.viewerLogin });
      case 'defaultBranchRef':
        return obj('Ref', { name: repo.defaultBranch });
      case 'viewerPermission':
        return scalar('RepositoryPermission', 'ADMIN');
      case 'hasIssuesEnabled':
        return scalar('Boolean', true);
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? obj('Issue', { __repo: repo, __issue: issue }) : null;
      }
      case 'issues':
        return obj('IssueConnection', { __repo: repo, __issuesArgs: args });
      case 'pullRequests':
        return obj('PullRequestConnection', { __repo: repo, __pullsArgs: args });
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? obj('PullRequest', { __repo: repo, __pull: pull }) : null;
      }
      case 'url':
        return scalar('String', '');
      case 'description':
        return scalar('String', repo.description);
      case 'isPrivate':
        return scalar('Boolean', repo.isPrivate);
      default:
        return scalar('String', null);
    }
  }

  if (parentType === 'IssueConnection') {
    const repo = value.__repo as Repo;
    const connArgs = value.__issuesArgs as Record<string, unknown>;
    if (field.name === 'nodes' || field.name === 'pageInfo') {
      const page = issuesPage(repo, connArgs);
      if (field.name === 'nodes') {
        return { __type: 'Issue[]', __list: page.nodes.map((issue) => obj('Issue', { __repo: repo, __issue: issue })) };
      }
      return obj('PageInfo', { hasNextPage: page.hasNextPage, endCursor: page.endCursor });
    }
    if (field.name === 'totalCount') return scalar('Int', repo.issues.size);
    return scalar('Int', 0);
  }

  if (parentType === 'PullRequestConnection') {
    const repo = value.__repo as Repo;
    const pullsArgs = value.__pullsArgs as Record<string, unknown>;
    const first = typeof pullsArgs.first === 'number' ? pullsArgs.first : 10;
    const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
    if (field.name === 'nodes') {
      return { __type: 'PullRequest[]', __list: pulls.map((pull) => obj('PullRequest', { __repo: repo, __pull: pull })) };
    }
    if (field.name === 'pageInfo') {
      return obj('PageInfo', { hasNextPage: false, endCursor: '' });
    }
    if (field.name === 'totalCount') return scalar('Int', repo.pulls.size);
    return scalar('Int', 0);
  }

  if (parentType === 'Issue') {
    const issue = value.__issue as Issue;
    switch (field.name) {
      case 'id':
        return scalar('ID', globalId('Issue', (value.__repo as Repo).id, issue.number));
      case 'number':
        return scalar('Int', issue.number);
      case 'title':
        return scalar('String', issue.title);
      case 'body':
        return scalar('String', issue.body);
      case 'state':
        return scalar('IssueState', issue.state.toUpperCase());
      default:
        return scalar('String', null);
    }
  }

  if (parentType === 'PullRequest') {
    const pull = value.__pull as Pull;
    const repo = value.__repo as Repo;
    switch (field.name) {
      case 'id':
        return scalar('ID', globalId('PullRequest', repo.id, pull.number));
      case 'number':
        return scalar('Int', pull.number);
      case 'title':
        return scalar('String', pull.title);
      case 'body':
        return scalar('String', pull.body);
      case 'state':
        return scalar('PullRequestState', pull.merged ? 'MERGED' : pull.state.toUpperCase());
      case 'merged':
        return scalar('Boolean', pull.merged);
      case 'headRefName':
        return scalar('String', pull.headRef);
      case 'baseRefName':
        return scalar('String', pull.baseRef);
      case 'mergeable': {
        if (pull.state !== 'open') return scalar('MergeableState', 'UNKNOWN');
        return scalar('MergeableState', planMerge(repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING');
      }
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        const files = diffForPull(repo, baseTip, headTip).slice(0, first);
        return obj('PullRequestChangedFileConnection', { __files: files });
      }
      default:
        return scalar('String', null);
    }
  }

  if (parentType === 'PullRequestChangedFileConnection') {
    const files = value.__files as Array<{ filename: string; additions: number; deletions: number }>;
    if (field.name === 'nodes') {
      return {
        __type: 'PullRequestChangedFile[]',
        __list: files.map((f) => obj('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions })),
      };
    }
    if (field.name === 'pageInfo') return obj('PageInfo', { hasNextPage: false, endCursor: '' });
    return scalar('Int', 0);
  }

  if (parentType === 'PullRequestChangedFile') {
    if (field.name === 'path') return scalar('String', value.path);
    if (field.name === 'additions') return scalar('Int', value.additions);
    if (field.name === 'deletions') return scalar('Int', value.deletions);
    return scalar('String', null);
  }

  if (parentType === 'PageInfo') {
    if (field.name === 'hasNextPage') return scalar('Boolean', value.hasNextPage);
    if (field.name === 'hasPreviousPage') return scalar('Boolean', false);
    if (field.name === 'endCursor') return scalar('String', value.endCursor ?? '');
    if (field.name === 'startCursor') return scalar('String', '');
    return scalar('String', null);
  }

  if (parentType === 'User' || parentType === 'Ref' || parentType === '__Field' || parentType === '__EnumValue') {
    const known = value[field.name];
    if (known !== undefined) return scalar('String', known);
    return scalar('String', null);
  }

  if (parentType === 'IssueComment') {
    if (field.name === 'id') return scalar('ID', value.id);
    if (field.name === 'body') return scalar('String', value.body);
    return scalar('String', null);
  }

  if (parentType === 'IssueCommentEdge') {
    if (field.name === 'node') return obj('IssueComment', { id: value.nodeId, body: value.nodeBody });
    return null;
  }

  // Mutation payloads.
  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const issue = value.issue as Issue | undefined;
      return issue ? obj('Issue', { __repo: value.__repo as Repo, __issue: issue }) : null;
    }
    return null;
  }
  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const pull = value.pullRequest as Pull | undefined;
      return pull ? obj('PullRequest', { __repo: value.__repo as Repo, __pull: pull }) : null;
    }
    return null;
  }
  if (parentType === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      return obj('IssueCommentEdge', { nodeId: value.commentId, nodeBody: value.commentBody });
    }
    return null;
  }

  void nextType;
  return scalar('String', null);
}

interface IssuesPageResult {
  nodes: Issue[];
  hasNextPage: boolean;
  endCursor: string;
}

function issuesPage(repo: Repo, args: Record<string, unknown>): IssuesPageResult {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => (a.number - b.number) * direction);
  const first = typeof args.first === 'number' ? args.first : 10;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) start = Number(match[1]);
    } catch {
      start = 0;
    }
  }
  const nodes = issues.slice(start, start + first);
  const end = start + nodes.length;
  const hasNextPage = end < issues.length;
  const endCursor = Buffer.from(`cursor:${end}`, 'utf8').toString('base64');
  return { nodes, hasNextPage, endCursor };
}

/** Execute one operation's selection set against a root value of `rootType`. */
function executeSelection(
  ctx: ExecContext,
  rootType: string,
  root: GqlValue | null,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      // `... on Repository` narrows the type; our node values already carry their type.
      const sub = executeSelection(ctx, rootType, root, selection.selection);
      Object.assign(out, sub);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const resolved = resolveField(ctx, rootType, root, field);
    if (resolved === null) {
      out[key] = null;
      continue;
    }
    out[key] = materialize(ctx, resolved, field.selection);
  }
  return out;
}

function materialize(ctx: ExecContext, value: GqlValue, selections: SelectionNode[]): unknown {
  if (value.__type.endsWith('[]')) {
    const list = (value as { __list: GqlValue[] }).__list;
    const itemType = value.__type.slice(0, -2);
    return list.map((item) => materialize(ctx, item, selections.length > 0 ? selections : inferLeaf(itemType)));
  }
  if ('__scalar' in value) return value.__scalar;
  if ('__value' in value) {
    if (selections.length === 0) return null;
    return executeSelection(ctx, value.__type, value, selections);
  }
  return null;
}

function inferLeaf(_type: string): SelectionNode[] {
  return [];
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function runMutation(ctx: ExecContext, field: FieldNode): GqlValue | null {
  const args = argsOf(field, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const store = ctx.store;
  if (field.name === 'createIssue') {
    const repoId = parseGlobalId(String(input.repositoryId ?? '') ?? '')?.repoId;
    const repo = repoId !== undefined ? store.getRepoById(repoId) : null;
    if (repo === null || typeof input.title !== 'string') {
      ctx.errors.push({ message: 'createIssue: unknown repository' });
      return null;
    }
    const number = repo.nextNumber++;
    const tick = store.nextTick();
    const issue: Issue = {
      number,
      title: input.title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdAt: new Date((1700000000 + tick) * 1000).toISOString(),
      updatedAt: new Date((1700000000 + tick) * 1000).toISOString(),
      closedAt: null,
      createdSeq: tick,
      jsonCache: null,
    };
    repo.issues.set(number, issue);
    return obj('CreateIssuePayload', { __repo: repo, issue });
  }
  if (field.name === 'closeIssue') {
    const parsed = parseGlobalId(String(input.issueId ?? ''));
    const repo = parsed !== null ? store.getRepoById(parsed.repoId) : null;
    const issue = repo && parsed !== null ? repo.issues.get(parsed.number) : undefined;
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return null;
    }
    issue.state = 'closed';
    issue.closedAt = new Date((1700000000 + store.nextTick()) * 1000).toISOString();
    issue.jsonCache = null;
    return obj('CloseIssuePayload', { __repo: repo, issue });
  }
  if (field.name === 'createPullRequest') {
    const repoId = parseGlobalId(String(input.repositoryId ?? ''))?.repoId;
    const repo = repoId !== undefined ? store.getRepoById(repoId) : null;
    const head = input.headRefName as string;
    const base = input.baseRefName as string;
    if (repo === null || typeof head !== 'string' || typeof base !== 'string') {
      ctx.errors.push({ message: 'createPullRequest: unknown repository or branch' });
      return null;
    }
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined || baseTip === undefined) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    const number = repo.nextNumber++;
    const pull: Pull = {
      number,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      mergeCommitSha: null,
      mergedAt: null,
      createdSeq: store.nextTick(),
      jsonCache: null,
    };
    repo.pulls.set(number, pull);
    return obj('CreatePullRequestPayload', { __repo: repo, pullRequest: pull });
  }
  if (field.name === 'mergePullRequest') {
    const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
    const repo = parsed !== null ? store.getRepoById(parsed.repoId) : null;
    const pull = repo && parsed !== null ? repo.pulls.get(parsed.number) : undefined;
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return null;
    }
    if (pull.state === 'closed') {
      ctx.errors.push({ message: 'mergePullRequest: pull request is already closed' });
      return obj('MergePullRequestPayload', { __repo: repo, pullRequest: pull });
    }
    const outcome = squashMerge(store, repo, pull);
    if (!outcome.ok) {
      ctx.errors.push({ message: `mergePullRequest: ${outcome.reason ?? 'merge conflict'}` });
      return obj('MergePullRequestPayload', { __repo: repo, pullRequest: pull });
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date((1700000000 + store.nextTick()) * 1000).toISOString();
    pull.mergeCommitSha = outcome.commitSha!;
    return obj('MergePullRequestPayload', { __repo: repo, pullRequest: pull });
  }
  if (field.name === 'addComment') {
    const parsed = parseGlobalId(String(input.subjectId ?? ''));
    const repo = parsed !== null ? store.getRepoById(parsed.repoId) : null;
    const issue = repo && parsed !== null ? repo.issues.get(parsed.number) : undefined;
    if (!repo || !issue || typeof input.body !== 'string') {
      ctx.errors.push({ message: 'addComment: unknown subject' });
      return null;
    }
    const commentId = repo.nextCommentId++;
    issue.comments.push({
      id: commentId,
      body: input.body,
      user: store.viewerLogin,
      createdAt: new Date((1700000000 + store.nextTick()) * 1000).toISOString(),
    });
    issue.jsonCache = null;
    return obj('AddCommentPayload', { commentId: globalId('IssueComment', repo.id, commentId), commentBody: input.body });
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

function executeOperation(ctx: ExecContext, operation: Operation): Record<string, unknown> {
  if (operation.type === 'mutation') {
    const out: Record<string, unknown> = {};
    for (const selection of operation.selection) {
      if (selection.kind !== 'field') continue;
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (!['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].includes(field.name)) {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
        out[key] = null;
        continue;
      }
      const payload = runMutation(ctx, field);
      out[key] = payload === null ? null : materialize(ctx, payload, field.selection);
    }
    return out;
  }
  return executeSelection(ctx, 'Query', null, operation.selection);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export function handleGraphQL(ctx: GraphQLContext, authorization: string | null): GraphQLReply {
  const expected = ctx.token;
  if (authorization === null || authorization === '') {
    return { status: 401, body: JSON.stringify({ message: 'Bad credentials' }) };
  }
  if (expected !== '' && authorization !== `Bearer ${expected}`) {
    return { status: 401, body: JSON.stringify({ message: 'Bad credentials' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ message: 'request body is not valid JSON' }) };
  }
  const operations: Array<{ query: string; variables?: Record<string, unknown>; operationName?: string }> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>).map((entry) => ({
        query: typeof entry.query === 'string' ? entry.query : '',
        variables: (entry.variables as Record<string, unknown> | undefined) ?? {},
        operationName: typeof entry.operationName === 'string' ? entry.operationName : undefined,
      }))
    : [
        {
          query: typeof (parsed as Record<string, unknown>).query === 'string' ? ((parsed as Record<string, unknown>).query as string) : '',
          variables: ((parsed as Record<string, unknown>).variables as Record<string, unknown> | undefined) ?? {},
          operationName: typeof (parsed as Record<string, unknown>).operationName === 'string' ? ((parsed as Record<string, unknown>).operationName as string) : undefined,
        },
      ];
  const results = operations.map((entry) => {
    const execCtx: ExecContext = { store: ctx.store, variables: entry.variables ?? {}, errors: [] };
    try {
      const document = new Parser(tokenize(entry.query)).parseDocument();
      let operation = document[0];
      if (entry.operationName !== undefined) {
        operation = document.find((op) => op.name === entry.operationName) ?? operation;
      }
      if (operation === undefined) {
        return { data: null, errors: [{ message: 'no operation in document' }] };
      }
      const data = executeOperation(execCtx, operation);
      if (execCtx.errors.length > 0) return { data, errors: execCtx.errors };
      return { data };
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'query parse failed' }] };
    }
  });
  return { status: 200, body: JSON.stringify(Array.isArray(parsed) ? results : results[0]) };
}
