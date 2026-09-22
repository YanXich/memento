# Constitution

The rules below gate every memento session. They are checked
deterministically by `memento spec verify` — never by an LLM.

- Tests must pass before a session is considered done.
- No dependency may be added without a stated reason in the session log.
- `.memento/` is machine-owned: never edit it by hand, never commit it by force.
- The README stays the entry point: every new top-level directory gets one line.
- Keep changes small: one focused change per session.
