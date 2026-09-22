/**
 * Plugin tests — "everything is a plugin" only holds if registration is
 * reversible. These tests prove the disposer contract.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlugins, unloadAll, dispatchPluginEvent } from "../src/plugins/loader.ts";
import type { PluginHost } from "../src/plugins/loader.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { z } from "zod";
import type { SpecChecker } from "../src/spec/verify.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-plugins-"));
  fs.mkdirSync(path.join(dir, ".memento/plugins"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeHost(): PluginHost & { tools: ToolRegistry } {
  return {
    tools: new ToolRegistry(),
    specCheckers: [],
    eventHandlers: new Map(),
    cwd: dir,
    log: () => {},
  };
}

describe("plugin loader", () => {
  it("loads a TS plugin, registers its tool, and reverses registration on unload", async () => {
    fs.writeFileSync(
      path.join(dir, ".memento/plugins/hello.ts"),
      `
      export default {
        name: "hello-plugin",
        setup(ctx) {
          ctx.registerTool({
            name: "hello_tool",
            description: "says hello",
            schema: { safeParse: (v) => ({ success: true, data: v }) },
            execute: async () => ({ output: "hello" }),
          });
          ctx.on("session_end", () => {});
        },
      };
      `,
    );

    const host = makeHost();
    const loaded = await loadPlugins(host, { cwd: dir, extraDirs: [] });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.error).toBeUndefined();
    expect(loaded[0]!.name).toBe("hello-plugin");
    expect(host.tools.names()).toContain("hello_tool");
    expect(host.eventHandlers.get("session_end")).toHaveLength(1);

    await unloadAll(loaded);
    expect(host.tools.names()).not.toContain("hello_tool");
    expect(host.eventHandlers.get("session_end")).toHaveLength(0);
  });

  it("isolates broken plugins: an error in one does not stop the others", async () => {
    fs.writeFileSync(path.join(dir, ".memento/plugins/a-broken.ts"), `throw new Error("boom at import time");`);
    fs.writeFileSync(
      path.join(dir, ".memento/plugins/b-fine.ts"),
      `
      export default function (ctx) {
        ctx.registerSpecChecker({ name: "extra", run: () => [] });
      }
      `,
    );

    const host = makeHost();
    const loaded = await loadPlugins(host, { cwd: dir, extraDirs: [] });

    const broken = loaded.find((p) => p.name === "a-broken");
    const fine = loaded.find((p) => p.name === "b-fine");
    expect(broken?.error).toContain("boom");
    expect(fine?.error).toBeUndefined();
    expect(host.specCheckers.map((c: SpecChecker) => c.name)).toContain("extra");
  });

  it("dispatches events to handlers and collects patches", async () => {
    fs.writeFileSync(
      path.join(dir, ".memento/plugins/patchy.ts"),
      `
      export default (ctx) => {
        ctx.on("before_tool", (event) => {
          if (event.type === "before_tool" && event.tool === "bash") return { block: "bash is off today" };
        });
        ctx.on("before_tool", () => { throw new Error("handler error is isolated"); });
      };
      `,
    );

    const host = makeHost();
    await loadPlugins(host, { cwd: dir, extraDirs: [] });
    const patches = await dispatchPluginEvent(host, { type: "before_tool", tool: "bash", args: {} });
    const verdict = patches.find((p) => p && typeof p === "object" && "block" in (p as object)) as { block: string };
    expect(verdict.block).toBe("bash is off today");
  });

  it("respects the disposer contract for spec checkers", async () => {
    fs.writeFileSync(
      path.join(dir, ".memento/plugins/checker.ts"),
      `
      export default (ctx) => {
        const dispose = ctx.registerSpecChecker({ name: "temp", run: () => [] });
        // plugin may undo early — unload must not double-remove
        dispose();
      };
      `,
    );
    const host = makeHost();
    const loaded = await loadPlugins(host, { cwd: dir, extraDirs: [] });
    await unloadAll(loaded);
    expect(host.specCheckers).toHaveLength(0);
  });
});

describe("tool registry disposal", () => {
  it("refuses duplicate names and restores availability after dispose", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "custom",
      description: "x",
      schema: z.object({}),
      execute: async () => ({ output: "" }),
    };
    const dispose = registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
    dispose();
    expect(registry.names()).not.toContain("custom");
  });
});
