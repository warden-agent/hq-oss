# HQ progress (2026-10-26)

## What exists
- **M0 spikes passed** on Claude Code 2.1.300: the plan gate, mod delivery and the engineer launch recipe. HQ has since moved to 2.1.322, with every check rerun (README, "Moving HQ to a new Claude Code"); it runs its own copy at `~/.hq/bin/claude-2.1.322` and says so when agents run anything else.
- **Core loop, end to end.**
  - The user writes to the project's TPM (its box is always on the graph) → it starts a feature and splits it into tickets → **Start ready** launches engineers (merge-first dependencies, parallel limit).
  - Each plan is held until the user approves it, or until they send it back. Send-backs are capped (`revision_cap`), then the ticket escalates.
  - `open_pr` → HQ pushes the branch and opens the PR as its own GitHub account, or offers **Merge into main** for local repos.
  - The merge watcher → the engineer stops, the worktree is removed, the user and the TPM hear what's ready, and the live preview restarts.
- **UI.** A graph with the project's TPM on top (a box to write to it, Your turn, Chat) and a box per feature and ticket (Read plan / Approve / Revise, Start ready, Merge, Cancel ✕); a ⚠ menu for everything that needs the user; Agents menu; terminals; Messages and Events tabs; a live preview (Desktop / Phone).
- **Running it.**
  - Cancel a ticket or feature.
  - One TPM per project (Bug 52): it starts with the user's message and comes back from its note (resume, fresh start, after a Clear), briefed from HQ's records and PROJECT.md.
  - Stuck detection.
  - Model guard: alert and pause the role.
  - TPM context warning at 300k tokens; auto-compaction is blocked.
  - Usage-limit pausing.
  - DM rate limits.
  - Event retention.
  - Stale worktree locks cleared.
  - Trust pre-accepted under Claude Code's own `~/.claude.json` lock.
- **Tests.** Unit tests, a zero-token e2e suite against a fake Claude Code (`backend/e2e/`), and GitHub Actions CI.

## Not built yet
- Architect sessions: a fresh Architect per review request, with convergence rules and escalation records. The user reviews plans themselves for now.
- The agent-hq docs repo (not started).
- An `hq doctor` that reruns the Claude Code checks by itself. Today they're run by hand before the checked version is raised, and HQ warns when agents run any other version.
- A docs panel for FEATURE.md and handoffs, standards suggestions, and OTel.
