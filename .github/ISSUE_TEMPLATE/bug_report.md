---
name: Bug report
about: Something is broken — help us reproduce it
title: "[bug] "
labels: bug
assignees: ""
---

## What happened

A clear description of the unexpected behavior.

## What you expected

## Reproduction

```console
$ memento version
$ memento run "…"
```

If the failure depends on a repository layout, describe the tree (or attach a
minimal repro).

## Session transcript

If a session produced the bug, share the relevant excerpt:

```console
$ memento show <session-id>
```

## Environment

- OS: <!-- e.g. Windows 11, macOS 15, Ubuntu 24.04 -->
- Node: <!-- `node -v` -->
- memento: <!-- `memento version` -->
- Provider / model: <!-- e.g. deepseek-chat, local ollama -->

## Anything else

Logs, screenshots, config redactions — whatever helps.
