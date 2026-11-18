# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/adiprmx/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/adiprmx/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only, no dependencies: git smart HTTP (upload-pack protocol v2 and v0 with shallow fetch, receive-pack with fast-forward enforcement), REST v3 (repositories, branches, commits, contents, labels, issues, comments, pull requests, files, squash merges), GraphQL v4 (the documents `gh` and `github-mcp-server` send), and an MCP endpoint (server/discover, tools/list, tools/call) — all over one in-memory object store, so every surface reads the same objects.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. The trial env's origin is in `MAKEFUN_ENV_URL` and the bearer token in `MAKEFUN_SHOP_TOKEN`. There is nothing to install: the program imports `node:http` and its own modules only.

## Layout

- `main.ts` — entry ↔ env lifecycle (bind an ephemeral port, register, wait for done, exit 0).
- `app.ts` — the HTTP server and routing.
- `gitobj.ts` — git object model: SHA-1 hashing, tree/commit/tag codecs, pack read/write (OFS/REF deltas), pkt-line and sideband codecs.
- `store.ts` — the in-memory store: repos, objects, refs, issues, pull requests, labels, comments; tree updates, diffs, merge planning and squash merges.
- `gitproto.ts` — git smart HTTP: info/refs advertisements, upload-pack v2/v0, receive-pack v0.
- `rest.ts` — GitHub REST v3.
- `graphql.ts` — GraphQL v4: tokenizer, parser, typed resolver, introspection, cursor pagination, mutations.
- `mcp.ts` — MCP over streamable HTTP: server/discover, initialize, tools/list, tools/call (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request).

---

<sub>Entered on [make.fun](https://make.fun/?ref=1c6jcmp6&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
