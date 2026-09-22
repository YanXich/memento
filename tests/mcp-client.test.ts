/**
 * MCP client tests — connect, tool listing, calls, error paths, timeout —
 * all against a real fake server child process (see support/fake-mcp-server.cjs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.ts";
import { attachMcpServers, createWorkspace } from "../src/cli/workspace.ts";

let dir: string;
const clients: McpClient[] = [];

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "support", "fake-mcp-server.cjs");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-mcp-client-"));
});

afterEach(() => {
  for (const c of clients) c.close();
  clients.length = 0;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connect(timeoutMs?: number): Promise<McpClient> {
  const client = await McpClient.connect({
    name: "fake",
    command: process.execPath,
    args: [serverPath],
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  clients.push(client);
  return client;
}

describe("McpClient", () => {
  it("connects and lists tools from a real child process", async () => {
    const client = await connect();
    const tools = client.tools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "fail_tool", "slow_tool"]);
    expect(tools[0]!.inputSchema.type).toBe("object");
  });

  it("calls a tool and receives the text result", async () => {
    const client = await connect();
    const res = await client.callTool("echo", { text: "hello world" });
    expect(res.text).toBe("echo: hello world");
    expect(res.isError).toBeUndefined();
  });

  it("propagates isError results", async () => {
    const client = await connect();
    const res = await client.callTool("fail_tool", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("boom");
  });

  it("times out when the server never responds", async () => {
    const client = await connect(500);
    await expect(client.callTool("slow_tool", {})).rejects.toThrow(/timed out/);
  });

  it("rejects when the command cannot spawn", async () => {
    await expect(
      McpClient.connect({ name: "broken", command: "definitely-not-a-real-binary-xyz" }),
    ).rejects.toThrow();
  });

  it("close() kills the child and rejects pending calls", async () => {
    const client = await connect();
    const pending = client.callTool("slow_tool", {});
    const closed = (async () => {
      client.close();
      await expect(pending).rejects.toThrow(/closed/);
    })();
    await closed;
  });
});

describe("attachMcpServers (workspace bridging + trust model)", () => {
  const originalUserProfile = process.env.USERPROFILE;
  let userHome: string;

  beforeEach(() => {
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), "memento-user-"));
    process.env.USERPROFILE = userHome;
  });

  afterEach(() => {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  function writeUserConfig(extra: Record<string, unknown>): void {
    fs.mkdirSync(path.join(userHome, ".memento"), { recursive: true });
    fs.writeFileSync(path.join(userHome, ".memento", "config.json"), JSON.stringify(extra), "utf8");
  }

  function writeProjectConfig(extra: Record<string, unknown>): void {
    fs.mkdirSync(path.join(dir, ".memento"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".memento", "config.json"), JSON.stringify(extra), "utf8");
  }

  const serverCfg = { name: "fake", command: process.execPath, args: [serverPath], trustedTools: ["echo"] };

  it("bridges user-configured servers into the registry with mcp_<server>_<tool> names", async () => {
    writeUserConfig({ mcpServers: [serverCfg] });
    const ws = createWorkspace(dir);
    await attachMcpServers(ws);
    try {
      expect(ws.mcpClients).toHaveLength(1);
      const names = ws.tools.names().filter((n) => n.startsWith("mcp_fake_"));
      expect(names).toContain("mcp_fake_echo");
      expect(names).toContain("mcp_fake_fail_tool");
      // Trusted tools are read-only; the rest require approval.
      expect(ws.tools.get("mcp_fake_echo")!.mutating).toBe(false);
      expect(ws.tools.get("mcp_fake_fail_tool")!.mutating).toBe(true);
      // The bridged tool actually works end-to-end.
      const echo = ws.tools.get("mcp_fake_echo")!;
      const res = await echo.execute({ text: "bridged" }, { cwd: dir, progress: () => {}, approve: async () => true });
      expect(res.output).toBe("echo: bridged");
    } finally {
      await ws.close();
    }
  });

  it("ignores project-declared servers unless the user opts in", async () => {
    writeProjectConfig({ mcpServers: [serverCfg] });
    const ws = createWorkspace(dir);
    await attachMcpServers(ws);
    expect(ws.mcpClients).toHaveLength(0);
    expect(ws.tools.names().filter((n) => n.startsWith("mcp_fake_")).length).toBe(0);
    await ws.close();
  });

  it("loads project-declared servers when trustProjectMcp is set in USER config", async () => {
    writeUserConfig({ trustProjectMcp: true });
    writeProjectConfig({ mcpServers: [serverCfg] });
    const ws = createWorkspace(dir);
    await attachMcpServers(ws);
    try {
      expect(ws.mcpClients).toHaveLength(1);
    } finally {
      await ws.close();
    }
  });

  it("survives a broken server (loud warning, session continues)", async () => {
    writeUserConfig({ mcpServers: [{ name: "broken", command: "definitely-not-a-real-binary-xyz" }] });
    const ws = createWorkspace(dir);
    await attachMcpServers(ws);
    expect(ws.mcpClients).toHaveLength(0);
    await ws.close();
  });
});
