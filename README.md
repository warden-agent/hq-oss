# HQ — local multi-agent coding control room

HQ runs real, interactive Claude Code sessions on your machine and coordinates them from one web page: a **TPM** per project, which turns each request into a feature split into tickets, and an **engineer** per ticket, which plans, builds and opens a PR. You review every plan and merge every PR. Each session lives in its own tmux session, so you can watch or type into any of them. It runs locally for one user on one Claude subscription: no API keys, no cloud VMs.

## How work flows

1. **Ask the TPM** (the box always at the top of the graph): write what you want, worded however you like. The project's TPM starts with your first message and stays; each new request becomes a feature (a branch of the graph), which it splits into tickets, each with a size, a spec, a list of acceptance criteria (A1, A2…, each marked as something on the screen or behind it), expected files, dependencies and a merge order. Criteria are written to be checked from outside the code ("when X happens, Y is true"): `ui` for what the user sees, `backend` for stored records and how the API answers. HQ refuses one that names a file, a path or a function, or is too vague to check ("works well", "is intuitive"), and tells the TPM why. They show on the ticket's box (**Criteria** opens them), in its Ticket tab and in `features/F-N.md`, split by kind; with auto mode off, read them there before you start a ticket. Engineers can't change them: they ask the TPM.
2. **Start ready** (on the feature's box): every ticket whose dependencies are merged starts, up to the parallel limit. Merge comes first: a ticket never starts before the tickets it depends on are merged.
3. **Plan review.** Each engineer starts in plan mode in its own git worktree. When it calls `ExitPlanMode`, HQ holds that call (a `PermissionRequest` hook) until you answer on the ticket's box. You can **Approve**, or **Revise** with the blocking issues. After `revision_cap` send-backs (default 2) the next round escalates the ticket, and at that point it can only be approved or cancelled. If you approve from the engineer's own terminal menu instead, HQ notices and flags it.
4. **Finished** (`open_pr`). A ticket with acceptance criteria names, for each one, the test that proves it (its file and its name), or says why nothing can test it. HQ checks that with git and refuses the call until each named test is on the branch and the branch adds or changes at least one of them. Then:
   - For a GitHub repo, HQ pushes the branch and opens the PR as its own GitHub account, and you merge it on GitHub.
   - For a local-only repo, you click **Merge into main** in HQ.
5. **Merged.** HQ notices merges without being told: it asks GitHub every 2 minutes and on every Sync, and checks git directly for local repos. It then stops the engineer, removes the merged worktree, tells you and the TPM which tickets are ready now, and restarts the repo's live preview on the new main.

The schema and an Architect role prompt (`backend/roles/architect.prompt.md`) are in place, but HQ doesn't launch Architect sessions. With auto mode off, you are the plan reviewer; with it on, HQ's plan check is (see Key decisions).

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
- Both `npm test` and `npm run e2e` (in `backend/`) take test files and node's test options after `--`: `npm run e2e -- e2e/auto.test.ts --test-name-pattern 'Bug 70'` runs that file only, `npm test -- src/heavy.test.ts` that unit file. With no files they run the whole suite.
- `cd backend && npm run e2e`: end to end with no tokens. It runs a real backend against a fake Claude Code (`backend/e2e/fake-claude.mjs`) with its own `HOME`, `HQ_HOME`, ports and tmux socket, and the tests act as the agents through hooks and MCP.
- A scenario's recorder runs for real in `backend/src/recorder.test.ts` and `testsetup.test.ts` (HQ's sandbox, a small app, no browser: `backend/e2e/fake-scenario.mjs` stands in for it).
- The readers and the browser have stand-ins in those tests: the fake Claude Code answers a one-shot call (`-p`) with whatever a `FAKE-CHECK:` line in its prompt says, and `backend/e2e/fake-look.mjs` "sees" whatever the checkout's `look.json` says. The real browser, in the real sandbox, is `backend/src/smoke.test.ts`, `backend/src/testermcp.test.ts` and `backend/src/uitester.test.ts` (the UI tester's host, and its browser in its sandbox, driven by an MCP client): they run when HQ's browser is already on the machine, or with `HQ_TEST_BROWSER=1`, which downloads it.
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
- **On auto, passing tests aren't the only thing between an engineer's code and main.** Plain code decides what it can, and model tokens are spent only where judgment is needed:
  - *Criteria and their tests (no tokens).* As HQ tests a finished ticket, it looks in the run's output for each test the ticket named. One that was skipped, or never ran, sends the ticket back. A runner that prints no test names (`pytest -q`, plain `go test`) can't be checked by name, and the run's summary says so. From git alone HQ also lists deleted tests, lines taken out of existing tests and files changed outside the ticket's expected files.
  - *A look at the app (no tokens).* Once the tests pass, HQ starts the app in the same throwaway checkout, from the start steps the preview uses, and opens its pages in a headless browser inside the test sandbox: the start page and what it links to, 8 pages at most. An app that doesn't start, a page that is blank or doesn't load, an error on the page or in the console and a failed request each count, but only if main doesn't already have them: when something is wrong, HQ looks at main alone too. What HQ can't look at (no start steps yet, a hard-wired port in use, no browser, an app that doesn't start on main either) is never held against a ticket, and the summary says it wasn't opened. A page that loads from another site isn't judged by what it logs: the browser in the sandbox has no internet. HQ downloads the browser once (Playwright's Chromium headless shell, about 180 MB, into Playwright's own cache folder).
  - *A plan check (about 2,000 tokens).* Before a plan is approved, a fresh reader sees the ticket's criteria and the plan, nothing else, and says whether the plan covers every criterion and builds anything not asked for. It is one headless Claude Code call with no tools, not an agent.
  - *A diff check (about 3,000 tokens), only when triggered.* Before a size M or L ticket merges, or one that the checks above flagged, a fresh reader sees its criteria, its changes and the test output, never the engineer's plan or reasoning, and looks for a criterion that isn't met or a concrete bug.
  - *A UI tester, once as a run ends (macOS for now; about $1–2 a run on Sonnet).* A tester that never sees the code uses the whole app in a real browser the way a person would. One call writes about 30 scenarios (everyday tasks, odd ones like empty input, doubles and the back button, and a few multi-step ones) from the project's feature map and the run's screen criteria, written out as a plain "what's new" list. They run five to a fresh session. Before each one HQ resets the app to its first state; each step is stamped on HQ's clock, and the steps are kept as code a script can replay. When the project has a test setup, the app runs under HQ's recorder for the whole run (its production start, on the setup's seed), and each scenario's API calls, server output, console errors and data changes are kept as a recording for the backend checker; with no test setup the run isn't recorded, and the summary says so. The tester's only tools are Playwright MCP (no running JavaScript in the page, no files, no network or console logs) and two of HQ's for starting and finishing a scenario; it has no Bash, Read, Edit or Write. Its browser runs in a sandbox that reaches only the app's port and can't read the project, and it starts in an empty folder with only the app's address. It reports every hesitation, wrong click and backtrack, and says "no verdict" where neither the map nor the criteria say what should happen. What it finds goes in the summary under "Tried in a browser", each finding with its steps; nothing is fixed or sent back. The scenarios, logs and findings are kept in HQ's own folder for the project (`~/.hq/projects/<repo>/uitest/<run>/`). A project can turn it off in its Auto box.
  - Both readers are held to the same rules, in code: at most three findings, each about a criterion or (for a diff) a concrete bug, and one send-back per ticket. A reader that can't be asked never holds work up: the plan is approved or the ticket merged without it, and the summary says so.
  - Engineers can't run a real browser themselves: Claude Code's sandbox on a Mac refuses what Chromium needs to start. So the look at the app is HQ's, and a criterion that only a browser could check is recorded as having no test.
  - *The findings loop (Part 5 of the tester & checker spec).* After the UI tester's scenarios, a backend checker (Opus, one headless call per batch of eight scenarios, only Read/Grep/Glob, no MCP servers, in a throwaway checkout of main plus the scenarios' recording folders) judges HQ's recordings against the project's backend criteria: clean scenarios get one line, problems become findings marked *on the screen*, *behind the screen* or *no criterion covers it*, each with its steps and the timeline rows that show it. Under the run's summary the user marks each finding Fix or Ignore (or, where no criterion covers it, Make it a rule / Fine as is), can reword it, and presses Send: the TPM makes one fix ticket per finding with `create_fix_ticket`, which carries the steps and evidence. When the fix merges, the next run replays the steps as a plain script and decides in code whether it's fixed (the flag gone from that endpoint, or the page as expected); only a replay that no longer fits the app goes back to the tester, and only a backend finding no flag shows goes to the checker. Ignored findings never come back; one still broken after two fix tickets is flagged to the user, and HQ makes no third. Findings live in HQ's own store (docs scope `findings:<repo>`), never in the repo. It reads the recorder (Part 3) and the UI tester (Part 4) through `backend/src/loopinputs.ts`; the real ones, and the translation between their shapes and the loop's, are in `backend/src/loopparts.ts`, which HQ plugs in as it starts. A finding whose old steps no longer fit the app, or that has nothing a script could look for, goes to the next run's tester as a scenario of its own, to try again by its goal.
  - Each can be turned off through the settings API (`app_look`, `plan_check`, `diff_check`, `tester`: `on` or `off`). The readers use the `architect` model setting, the UI tester its own (`tester`, Sonnet).
- **A feature map instead of code.** Each project has a short map of its app in a user's words: each screen (`## Reading (tab)`), and a line per control saying what it does. The map is all the tester knows of the app; it never sees code. HQ keeps it in its own records, never in the repo, so it can't conflict with a merge, and copies it to `FEATURE-MAP.md` in the TPM's workspace. The **Map** button in the top bar shows it.
  - An engineer whose ticket has screen criteria calls `update_feature_map` with edits for each screen it changed: lines to add, lines to remove (copied from the map, and refused if they aren't on it), or `gone` for a whole screen. Otherwise it tells `open_pr` that nothing a user sees changed (`feature_map_unchanged`). `open_pr` asks until it does one or the other. The change waits with the ticket and goes into the map when the ticket merges. Because they are edits, two tickets that change the same screen at once both land, and Undo of an auto run takes its changes back out.
  - HQ refuses a map with file names, paths or code terms in it, and one that a change would push over 5,000 characters. The refusal says what to fix. Labels shown on the screen go in quotes, and code words inside quotes are allowed (`"Export JSON"`).
  - An app that already exists gets its first map from a one-time session (**Write the first map** in the Map box). It runs under the same lockdown as the tester: HQ's browser tools in the test sandbox, a throwaway checkout, no code, 40 actions. It clicks through the running app and writes the map, which HQ checks with the same rules before it takes it. On a small sample app it took about a minute.
  - With the `tester` setting off, nothing asks for the map.
- **Scenarios run on a clean seed, and HQ writes down what happened (Tester & Checker, Part 3).** Each project gets a test setup, worked out once from the code by an Opus helper (⚙ in the preview → Set up testing):
  - How each part of the app runs as a production build (a dev server hands out the source), the paths that hold its state, a seed command that writes a small clean set of test data (never yours), and what kind of work each API endpoint does (instant, normal, heavy). It is kept in HQ's folder for the project, not in the repo. The helper's sandbox reaches localhost only.
  - HQ checks it for real before using it: seed, start, open the page, reset, open it again, and the state after the reset must equal the seed. A reset is HQ's own: stop the app, put the seed back, start it again (an app that reads its files at start ignores files swapped under it). You see the setup once; engineers change it with `update_test_setup` when a ticket changes the backend, and HQ applies that only after the ticket merges and the check passes.
  - A scenario (`POST /api/previews/<repo>/scenario` with steps; the UI tester uses the same recorder) runs in a throwaway checkout in the test sandbox. A proxy in front of the app records every API call, the app's output is stamped, the browser's console errors and failed requests are kept, and the state is copied after every step. HQ then puts it on one clock as a timeline with data diffs ("library: +Dune, +Dune") and flags it computes itself, no tokens: the same write twice in one step, a call far slower than its endpoint's own normal or its label, any 4xx/5xx, console errors, failed requests. A clean scenario is one line. The raw logs stay next to the timeline in `~/.hq/projects/<repo>/scenarios/`.
- **A project whose own tests fail repairs itself on auto.** HQ opens a repair ticket with the full output and what the sandbox can't do. Other engineers keep building, but nothing merges until the repair is in:
  - If the repair can't be finished, or a run needs more than two, the project stops and asks you.
  - If the test command itself can't work in the sandbox, the engineer proposes another. HQ tries it first, takes it, and lists it in the run's summary with what it leaves out. HQ can prove a command passes, not that it's a good test, so read that line. A second change in one run stops and asks.
  - HQ only takes a command the engineer has run in its own session first. Every engineer has to run it there, and Claude Code refuses some commands that HQ's sandbox would run, such as `node --test $(ls test/*.js)`.
  - A command you typed in the Auto box is never run by an engineer first. If Claude Code refuses it in an engineer's session (`node --test $(git ls-files test)`, for one), HQ says so once: ⚠ "Engineers can't run the test command". On auto it also opens a ticket that moves the refused part into a script in the repo and proposes the new command. Nothing merges until that's in. If it can't be done, that ticket is parked and the rest carries on, because HQ's own test runs still work.
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
  - a command held at its `PreToolUse` hook starts when the hook answers, and runs anyway when the hook times out. For engineers' Bash commands that hook is a script Claude Code runs (`turnwait.mjs`, which waits out a backend that is down before a build or full test run); Claude Code ends it when the turn is interrupted or the session goes
  - a Bash `timeout` moves the command to the background instead of stopping it: what the hook then carries (`backgroundTaskId`, `timedOutAfterMs`), where its output goes, its process group, and the `<task-notification>` that wakes the agent
  - helpers: their hooks carry `agent_id`, the Agent tool's result carries `isAsync` and `agentId`, and Claude Code's own helper fires `SubagentStop` after the turn has ended
  - the mod: its calls are async, and `$.prompt.submit` delivers a message once the session is idle (not after an Escape, until a normal turn ends)
  - an interrupted turn: the mod's `turn.complete` says `isAborted` and no `Stop` hook comes; HQ then types messages into the prompt, where a first `!` or `/` makes a command and more than 800 characters arriving at once count as a paste
  - the trust rule and the `~/.claude.json` lock HQ shares with live sessions
  - the session file in `~/.claude/sessions/` that says `waiting` while a dialog is open, which is how a "waiting on a dialog" alert clears itself
  - the screen: the idle prompt's footer and the menus (`backend/src/screen.ts` is tested on real captures)
  - `CLAUDE_CODE_TMPDIR` is ignored when longer than about 30 bytes
  - a whole run with real agents: a request, plans approved and sent back, tickets built in the sandbox and merged, an urgent message, a fresh start, auto mode

What's built and what's next: [`docs/PROGRESS.md`](docs/PROGRESS.md). The original design notes are kept outside this repo.

## License

MIT. See [`LICENSE`](LICENSE).
