# HQ — local multi-agent coding control room

HQ runs real, interactive Claude Code sessions on your machine and coordinates them from one web page: a **TPM** per project, which turns each request into a feature split into tickets, and an **engineer** per ticket, which plans, builds and opens a PR. You review every plan and merge every PR. Each session lives in its own tmux session, so you can watch or type into any of them. It runs locally for one user on one Claude subscription: no API keys, no cloud VMs.

## How work flows

1. **Ask the TPM** (the box always at the top of the graph): write what you want, worded however you like. The project's TPM starts with your first message and stays; each new request becomes a feature (a branch of the graph), which it splits into tickets, each with a size, a spec with acceptance criteria, expected files, dependencies and a merge order.
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
  - `mcp.ts` serves HQ's tools to agents. Each agent reaches it through its own `mcprelay.mjs`, which Claude Code starts and which waits out a backend that is down
  - `preview.ts` is the live preview: it runs a repo's launch recipe (`apprun.ts`) with `supervise.mjs` in a tmux pane
  - `launchhelper.ts` is the Launch helper: a one-off Claude session that works out a repo's recipe, which you OK once
  - `trust.ts` pre-accepts Claude Code's trust dialog
  - `listeners.ts` holds what happens on events, wired once at startup
- `frontend/`: Vite + React + Tailwind. A React Flow graph with the project's TPM on top and a box per feature and ticket, xterm.js terminals, and the live preview pane.
- `plugin/`: the `hq` Claude Code mod loaded into every agent (`--plugin-dir`). It handles message delivery (`$.prompt.submit` when the session is idle), telemetry and the model guard.
- `backend/roles/`: the role prompts appended to each agent's system prompt. They are copied to `~/.hq/roles/` on every start.
- State lives in `~/.hq/`: the SQLite DB, per-agent files, TPM workspaces, logs, and HQ's own copy of Claude Code, `~/.hq/bin/claude-2.1.322`.

## Run

Prerequisites: Node 25, tmux, `lsof`, `gh`, and Claude Code 2.1.322 on this computer. HQ takes its own copy of it on first start (see [Key decisions](#key-decisions)).

HQ runs on macOS and Linux:
- **macOS** needs nothing else, and is where HQ gets its everyday use.
- **Linux** also needs `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`): engineers and auto mode's tests are sandboxed with them. The folder picker is macOS-only, so type a project's path by hand. HQ's automated tests pass on Ubuntu and Debian with a fake Claude Code, but HQ hasn't been run with real engineers on Linux yet.

If bubblewrap can't run, auto mode won't turn on and says why. Some systems block what it needs:
- **Ubuntu:** if you see a permission error, `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` lifts the block. It loosens a setting for the whole machine, so it's your call; HQ never changes it. Ubuntu 26.04 didn't need it in our tests.
- **Docker:** start the container with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`. These weaken the container's own protection, so only use them on a container you trust.

```bash
npm install
npm --workspace frontend run build      # the backend serves frontend/dist from disk
tmux new-session -d -s hq-backend -c backend "node --experimental-strip-types src/index.ts 2>&1 | tee ~/.hq/logs/backend.log"
```

Start it outside any sandbox. Agents run under that tmux server and inherit its environment. It is started with `node` itself: under `npm run start`, npm would stay in memory (about 50 MB) only to wait for it. The backend prints `http://127.0.0.1:4780/?token=…`; open that once and the page keeps a cookie.

Ports, all bound to 127.0.0.1:
- 4780: UI, API and WebSocket (the token and a matching Origin are required)
- 4781: hook ingress
- 4782: the MCP server `hq`

## Tests

- `npm --workspace @hq/backend test`: unit tests, using a real SQLite DB in a temp `HQ_HOME`.
- `cd backend && npm run e2e`: end to end with no tokens. It runs a real backend against a fake Claude Code (`backend/e2e/fake-claude.mjs`) with its own `HOME`, `HQ_HOME`, ports and tmux socket, and the tests act as the agents through hooks and MCP.
- CI (`.github/workflows/ci.yml`) runs the backend typecheck and unit tests, auto mode's end-to-end tests on Linux, the sandbox tests on macOS, the frontend typecheck and lint, and a check that the number of lines over 200 characters doesn't go up (`scripts/long-lines.mjs`).

## Key decisions

- **Engineers hold no GitHub token.** The backend pushes and opens PRs as a separate account, and only you merge.
- **Engineers are boxed in:**
  - `--worktree`, `--restricted`, a strict sandbox and plan mode until their plan is approved
  - they can't edit `CLAUDE.md` or `.github/workflows` unless the TPM asks for an override and you approve it
  - the TPM runs read-only in its own workspace
- **Auto mode tests code nobody has read,** so each ticket's tests run sandboxed with no credentials, in a throwaway checkout of main plus that ticket:
  - The run can't write outside its checkout and package caches, can't read `~/.ssh`, cloud or package-manager logins or HQ's own files, and can't reach other programs' sockets in the usual places.
  - The test step has no network beyond localhost. The install step has open network, because neither sandbox can filter by site, so a package's install script can reach the internet (with no credentials to send).
  - A test's Unix sockets must live in its own checkout.
- **A project whose own tests fail repairs itself on auto.** HQ opens a repair ticket with the full output and what the sandbox can't do. Other engineers keep building, but nothing merges until the repair is in:
  - If the repair can't be finished, or a run needs more than two, the project stops and asks you.
  - If the test command itself can't work in the sandbox, the engineer proposes another. HQ tries it first, takes it, and lists it in the run's summary with what it leaves out. HQ can prove a command passes, not that it's a good test, so read that line. A second change in one run stops and asks.
  - HQ only takes a command the engineer has run in its own session first. Every engineer has to run it there, and Claude Code refuses some commands that HQ's sandbox would run, such as `node --test $(ls test/*.js)`.
  - With auto mode off, HQ opens no repair of its own, and a proposed command waits for your OK.
  - Each run tests main once as it starts, alongside the first tickets, so a broken main or a test command that can't work in the sandbox opens its repair straight away. A failure is run once more before a repair opens, so one flaky run can't spend one.
  - This protects your machine from accidents and careless code. It isn't a security boundary against a determined attacker.
- **Messages** reach an agent through the `hq` mod when the session is idle. An agent can also pull them with `read_inbox`. Real typing in HQ's terminal holds delivery for a while.
- **Plan gate:**
  - the hook is held for up to 30 minutes
  - a re-sent plan re-attaches to its review by hash, and a changed plan replaces the open review
  - every round, verdict and send-back is recorded
- **Model guard:** when a session drifts off its model, HQ alerts you and pauses that role, and never aborts by default. When a TPM's context grows past 300k tokens, HQ tells you to start a fresh TPM briefed from its records.
- **HQ runs its own copy of Claude Code 2.1.322, the version it was checked on.** HQ leans on things Claude Code doesn't promise (listed below), and an update can change any of them without a word. So an update never reaches HQ's agents by itself:
  - On first start HQ copies that version to `~/.hq/bin/claude-2.1.322` from this computer's install: `~/.local/share/claude/versions/2.1.322`, or the `claude` on your PATH if it is that version. If neither is there, HQ doesn't start and says so.
  - Updating your own Claude Code later changes nothing for HQ's agents. The ⚠ menu notes, as information, that a newer one is installed.
  - `HQ_CLAUDE_BIN=<a claude binary>` runs another one (`HQ_CLAUDE_VERSION=<version>` picks another copy in `~/.hq/bin/`). HQ then raises **Claude Code not checked**, once per version; it looks again at every launch and every few minutes, so an update of that binary can't slip past.
  - The Agents menu always says which version the agents run. Agents already running keep the version they started with.

  **Moving HQ to a new Claude Code:** run these on the new binary, fix what differs, then raise `CHECKED_VERSION` in `backend/src/claudeversion.ts`. Checked on 2.1.322:
  - the hook answer that skips the plan menu, and the plan menu's own approval being noticed
  - a command held at its `PreToolUse` hook starts when the hook answers, and runs anyway when the hook times out
  - a Bash `timeout` moves the command to the background instead of stopping it: what the hook then carries (`backgroundTaskId`, `timedOutAfterMs`), where its output goes, its process group, and the `<task-notification>` that wakes the agent
  - helpers: their hooks carry `agent_id`, the Agent tool's result carries `isAsync` and `agentId`, and Claude Code's own helper fires `SubagentStop` after the turn has ended
  - the mod: its calls are async, and `$.prompt.submit` delivers a message once the session is idle (not after an Escape, until a normal turn ends)
  - the trust rule and the `~/.claude.json` lock HQ shares with live sessions
  - the session file in `~/.claude/sessions/` that says `waiting` while a dialog is open, which is how a "waiting on a dialog" alert clears itself
  - the screen: the idle prompt's footer and the menus (`backend/src/screen.ts` is tested on real captures)
  - `CLAUDE_CODE_TMPDIR` is ignored when longer than about 30 bytes
  - a whole run with real agents: a request, plans approved and sent back, tickets built in the sandbox and merged, an urgent message, a fresh start, auto mode

What's built and what's next: [`docs/PROGRESS.md`](docs/PROGRESS.md). The original design notes are kept outside this repo.

## License

MIT. See [`LICENSE`](LICENSE).
