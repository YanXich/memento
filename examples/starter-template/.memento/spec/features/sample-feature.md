# Sample Feature

A tiny example feature so the spec pipeline has something to gate against.

## Behavior

- `greet --name <n>` prints `hello, <n>!` to stdout.
- `greet` without `--name` prints `hello, world!`.

## Checkable statements

- The `greet` entry point exists and is executable from the project root.
- Running `greet --name memento` prints exactly `hello, memento!`.
- Running `greet` prints exactly `hello, world!`.

## Out of scope

- i18n, colors, or configuration.
