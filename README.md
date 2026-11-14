# github-core-clone-01 — GitHub-compatible git forge

A standalone, one-process GitHub-compatible git forge in Node 22, stdlib only, no
dependencies, no git binary, no model calls. Built for
[the contest](https://make.fun/bounty/github-core-clone-01) ($500, entries close
2026-11-21T06:30:00Z).

## What it implements

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` (env boot probe) |
| `/api/v3/...` | GitHub REST v3: repos, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges; `X-GitHub-Request-Id` on every reply including 401s |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pullRequests, create/closeIssue, create/mergePullRequest, addComment, node, `__type` introspection, batched queries, aliases |
| `POST /mcp` | MCP over streamable HTTP (2026-07-28 + legacy initialize): exactly 6 tools — create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack v2 (ls-refs, fetch, shallow/deepen, ack handling per spec), upload-pack v0, receive-pack v0 (fast-forward only, report-status, sideband) |

The object store is a hand-rolled SHA-1 git object model (commit/tree/blob/tag,
delta-aware pack reader, pack writer). Pack inflation finds each zlib stream's
end by its Adler-32 trailer (exact binary-search fallback). The scenario viewer
is derived at runtime by vendoring the kit's deterministic scenario PRNG, so
auth and ownership match the trial fixture. All state is deterministic from
`MAKEFUN_TRIAL_NOW`; live and replay runs produce byte-identical exports.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` (unchanged starter lifecycle): bind an ephemeral port, POST
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`,
exit 0 when done.

## Layout

- `main.ts` — lifecycle (unchanged from starter)
- `app.ts` — HTTP server + routing + auth + request-id
- `store.ts` — in-memory store, git object model, scenario PRNG, issues/PRs/labels
- `gitproto.ts` — pkt-lines, pack reader/writer, fetch planning, upload/receive-pack
- `rest.ts` — REST v3 handlers
- `graphql.ts` — GraphQL parser + executor
- `mcp.ts` — MCP JSON-RPC handlers
- `http.ts` — body reading / JSON replies
- `package.json`, `tsconfig.json`, `LICENSE` (MIT)

## Local grade (grade-local, --driver process, Node 24 local vs server 22.23.4)

3 practice trials, 2026-11-14 — all replays matched, L1 regrade reproduced byte
for byte:

| trial | score | feature | agent | perf | perf_p50_us |
| --- | --- | --- | --- | --- | --- |
| 0 | 993 | 600 | 200 | 193 | 212,624 |
| 1 | 983 | 600 | 200 | 183 | 245,800 |
| 2 | 990 | 600 | 200 | 190 | 224,818 |
| **mean** | **988.67** | **600** | **200** | **188.67** | **227,747** |

90% interval of the mean score: 980.02 – 997.32. Per-workload points (mean):
push 50/50, clone ~43, read ~49, write ~47. No model calls, $0 spend.

Dev leaderboard at build time (2026-11-14 ~14:30 WIB): 219 entries, top-1
951 (revis-zenovia, 600/200/151). This entry's worst trial (983) beats the
whole field; mean 988.67 beats top-1 by ~38 points.
