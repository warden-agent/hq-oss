# HQ — local multi-agent coding control room

HQ runs real, interactive Claude Code sessions on your machine and coordinates them from one web page: a **TPM** per feature, which splits a request into tickets, and an **engineer** per ticket, which plans, builds and opens a PR. You review every plan and merge every PR. Each session lives in its own tmux session, so you can watch or type into any of them. It runs locally for one user on one Claude subscription: no API keys, no cloud VMs.

## How work flows

1. **New feature** (on your box in the graph): HQ starts a TPM with your request, worded however you like. The TPM splits it into tickets, each with a size, a spec with acceptance criteria, expected files, dependencies and a merge order.
2. **Start ready** (on the feature's box): every ticket whose dependencies are merged starts, up to the parallel limit. Merge comes first: a ticket never starts before the tickets it depends on are merged.
3. **Plan review.** Each engineer starts in plan mode in its own git worktree. When it calls `ExitPlanMode`, HQ holds that call (a `PermissionRequest` hook) until you answer on the ticket's box. You can **Approve**, or **Revise** with the blocking issues. After `revision_cap` send-backs (default 2) the next round escalates the ticket, and at that point it can only be approved or cancelled. If you approve from the engineer's own terminal menu instead, HQ notices and flags it.
4. **Finished** (`open_pr`):
   - For a GitHub repo, HQ pushes the branch and opens the PR as its own GitHub account, and you merge it on GitHub.
   - For a local-only repo, you click **Merge into main** in HQ.
5. **Merged.** HQ notices merges without being told: it asks GitHub every 2 minutes and on every Sync, and checks git directly for local repos. It then stops the engineer, removes the merged worktree, tells you and the TPM which tickets are ready now, and restarts the repo's live preview on the new main.

The schema and an Architect role prompt (`backend/roles/architect.prompt.md`) are in place, but HQ doesn't launch Architect sessions yet. For now, you are the plan reviewer.

## Layout

- `backend/`: Node 25 + TypeScript, run directly with `--experimental-strip-types`. Uses `node:sqlite`, `node-pty`, `ws` and the MCP SDK.
  - `agents.ts` launches sessions (settings, MCP config and a launch script per agent, in `~/.hq/agents/<id>/`)
  - `gate.ts` is the plan gate
  - `tickets.ts`, `records.ts`, `repos.ts`, `slots.ts`, `mergewatch.ts` and `handover.ts` handle features, tickets, repos, parallel slots, PRs and merges
  - `delivery.ts` carries messages between you, the TPM and engineers
  - `preview.ts` is the live preview
  - `trust.ts` pre-accepts Claude Code's trust dialog
  - `listeners.ts` holds what happens on events, wired once at startup
- `frontend/`: Vite + React + Tailwind. A React Flow graph with a box per feature and ticket, xterm.js terminals, and the live preview pane.
- `plugin/`: the `hq` Claude Code mod loaded into every agent (`--plugin-dir`). It handles message delivery (`$.prompt.submit` when the session is idle), telemetry and the model guard.
- `backend/roles/`: the role prompts appended to each agent's system prompt. They are copied to `~/.hq/roles/` on every start.
- State lives in `~/.hq/`: the SQLite DB, per-agent files, TPM workspaces, logs, and the pinned binary `~/.hq/bin/claude-2.1.300`.

## Run

Prerequisites: Node 25, tmux, `gh`, and the pinned Claude Code binary at `~/.hq/bin/claude-2.1.300`.

```bash
npm install
npm --workspace frontend run build      # the backend serves frontend/dist from disk
tmux new-session -d -s hq-backend -c backend "npm run start 2>&1 | tee ~/.hq/logs/backend.log"
```

Start it outside any sandbox. Agents run under that tmux server and inherit its environment. The backend prints `http://127.0.0.1:4780/?token=…`; open that once and the page keeps a cookie.

Ports, all bound to 127.0.0.1:
- 4780: UI, API and WebSocket (the token and a matching Origin are required)
- 4781: hook ingress
- 4782: the MCP server `hq`

## Tests

- `npm --workspace @hq/backend test`: unit tests, using a real SQLite DB in a temp `HQ_HOME`.
- `cd backend && npm run e2e`: end to end with no tokens. It runs a real backend against a fake Claude Code (`backend/e2e/fake-claude.mjs`) with its own `HOME`, `HQ_HOME`, ports and tmux socket, and the tests act as the agents through hooks and MCP.
- CI (`.github/workflows/ci.yml`) runs the backend typecheck and unit tests, the frontend typecheck and lint, and a check that the number of lines over 200 characters doesn't go up (`scripts/long-lines.mjs`).

## Key decisions

- **Engineers hold no GitHub token.** The backend pushes and opens PRs as a separate account, and only you merge.
- **Engineers are boxed in:**
  - `--worktree`, `--restricted`, a strict sandbox and plan mode until their plan is approved
  - they can't edit `CLAUDE.md` or `.github/workflows` unless the TPM asks for an override and you approve it
  - the TPM runs read-only in its own workspace
- **Messages** reach an agent through the `hq` mod when the session is idle. An agent can also pull them with `read_inbox`. Real typing in HQ's terminal holds delivery for a while.
- **Plan gate:**
  - the hook is held for up to 30 minutes
  - a re-sent plan re-attaches to its review by hash, and a changed plan replaces the open review
  - every round, verdict and send-back is recorded
- **Model guard:** when a session drifts off its model, HQ alerts you and pauses that role, and never aborts by default. When a TPM's context grows past 300k tokens, HQ tells you to start a fresh TPM briefed from its records.
- **Claude Code is pinned to 2.1.300.** Several things HQ relies on were checked on that exact version:
  - the hook answer that skips the plan menu
  - mod calls being async
  - the trust rule and the `~/.claude.json` lock HQ shares with live sessions

  Re-check them before any version bump.

What's built and what's next: [`docs/PROGRESS.md`](docs/PROGRESS.md). The original design notes are kept outside this repo.

## License

MIT. See [`LICENSE`](LICENSE).
