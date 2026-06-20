# Built-in actions

The engine ships a few actions under the reserved **`work/`** scheme — common
setup steps you'd otherwise hand-write. They behave like any [action](./actions),
with one convenience: they're always available (no `.workflows/actions/` package
to author). Jobs reach the network freely, so these — which need a git/download
host — work without any egress setup.

| `uses:` | What it does |
|---|---|
| [`work/agent`](./agent-steps) | Run a Pi agent with a prompt (the agent primitive). |
| [`work/checkout`](#work-checkout) | Clone a git repo into the workspace. |
| [`work/install-node`](#work-install-node) | Install a specific Node version. |

## `work/checkout`

Clone a **public** git repository into the job's workspace. Git isn't in the guest
image, so the action installs it (`apk add git`) on demand, then clones over the
sandbox's mediated egress.

```yaml
steps:
  - uses: work/checkout
    with:
      repo: octocat/Hello-World    # owner/name (→ github.com) or a full clone URL
      ref: main                    # branch/tag; omit for the default branch
      path: src                    # destination dir (default: the workspace root)
      depth: 1                     # shallow depth; 0 for full history
  - run: ls src
```

| Input | Default | Notes |
|---|---|---|
| `repo` | — (**required**) | `owner/name` resolves to `https://github.com/owner/name`; a URL is used as-is. |
| `ref` | the default branch | Branch or tag to check out. |
| `path` | `.` | Destination directory under the workspace. |
| `depth` | `1` | Shallow-clone depth; `0` clones full history. |

Outputs: `ref` (the checked-out ref) and `sha` (HEAD's commit SHA).

::: info Public repos for now
v1 targets public repositories. Private-repo tokens (a host-scoped secret) are a
follow-on.
:::

## `work/install-node`

Install a specific Node.js version, **shadowing** the one the Alpine guest ships so
that `node`/`npm` in later steps of the same job resolve to it.

```yaml
steps:
  - uses: work/install-node
    with:
      version: 24.9.0
  - run: node --version          # v24.9.0
```

| Input | Default | Notes |
|---|---|---|
| `version` | — (**required**) | Node version, no leading `v` (e.g. `24.9.0`). |

Output: `version` (the installed `node --version`).

::: warning arm64 needs v24+
`work/install-node` uses musl Node builds. Upstream publishes **arm64** musl builds
only for recent versions (**v24+**); **x64** has every version. On an arm64 guest,
pick a v24+ version.
:::

::: tip Runnable examples
[`test/e2e/checkout`](https://github.com/nullbytelabs/work/tree/main/test/e2e/checkout)
and
[`test/e2e/install-node`](https://github.com/nullbytelabs/work/tree/main/test/e2e/install-node).
:::
