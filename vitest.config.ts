import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Real `git` subprocess tests take ~20s+ on loaded CI machines; 20s
    // produced intermittent timeouts. 90s keeps the suite deterministic even
    // when all 26 files run in parallel and the CPU is oversubscribed; the
    // heaviest bench tests pin their own higher budget explicitly.
    testTimeout: 90000,
  },
});
