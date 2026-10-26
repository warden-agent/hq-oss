# HQ progress (2026-10-26)

## What exists
- **M0 spikes passed** on Claude Code 2.1.300 (a pinned, manifest-verified copy at `~/.hq/bin/claude-2.1.300`): the plan gate, mod delivery and the engineer launch recipe.
- **Core loop, end to end.**
  - The user's request → a TPM splits it into tickets → **Start ready** launches engineers (merge-first dependencies, parallel limit).
  - Each plan is held until the user approves it, or until they send it back. Send-backs are capped (`revision_cap`), then the ticket escalates.
  - `open_pr` → HQ pushes the branch and opens the PR as its own GitHub account, or offers **Merge into main** for local repos.
  - The merge watcher → the engineer stops, the worktree is removed, the user and the TPM hear what's ready, and the live preview restarts.
- **UI.** A graph with a box per feature and ticket (Read plan / Approve / Revise, Start ready, Merge, Cancel ✕); a ⚠ menu for everything that needs the user; Agents menu; terminals; Messages and Events tabs; a live preview (Desktop / Phone).
- **Running it.**
  - Cancel a ticket or feature.
  - Start TPM again, briefed from HQ's records.
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
- An `hq doctor` smoke test for Claude Code version bumps.
- A docs panel for FEATURE.md and handoffs, standards suggestions, and OTel.
