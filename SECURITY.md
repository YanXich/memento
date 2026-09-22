# Security Policy

Memento is a coding agent — it runs tools on your machine. Security is not a
feature here; it is the default posture. This document explains the model and
how to report problems.

## Reporting a vulnerability

**Do not open a public issue.** Email the maintainers directly at
`security@memento-agent.dev` with:

- affected version(s),
- a minimal reproduction,
- impact and any mitigations you know.

We treat every report as urgent, respond within 72 hours, and credit reporters
in the release notes (unless you prefer anonymity).

## The security model at a glance

- **Read-only commands run directly** — recognized by a fail-safe classifier
  (unrecognized = gated, never allowed).
- **Everything mutating requires approval.** In non-interactive sessions
  (no TTY, no `--yes`), mutations are **denied by default**.
- **Protected paths** — `.git/`, `node_modules/`, and secret files
  (`.env*`, `id_rsa`, `id_ed25519`) are unreachable by file tools.
- **Catastrophic patterns are hard-blocked** regardless of approvals
  (`rm -rf /`, fork bombs, disk writes, credential exfiltration shapes).
- **MCP servers load from user config only** (`~/.memento/config.json`).
  A cloned repo cannot spawn processes on your machine unless you explicitly
  set `trustProjectMcp: true`. Bridged mutating tools go through the same
  approval + write-serialization as built-ins.
- **Write tools snapshot before writing** (`.memento/undo/`) — `memento undo`
  restores the previous state.
- **No shell interpolation by default** — git tools use `execFileSync`
  (argument vectors, not shell strings).

## What is out of scope

The model cannot protect you from everything. If you approve a `bash` command
that deletes your files, the agent will delete your files — the approval gate
is the boundary. If you point memento at a hostile LLM provider that emits
malicious tool calls, the approval gate is the only wall left. **Review what
you approve.**
