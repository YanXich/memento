// Fake MCP server for client tests — a real child process speaking the
// wire format over stdio, so McpClient.connect/callTool are tested against
// an actual transport, not a mock.
"use strict";
const readline = require("node:readline");

const tools = [
  {
    name: "echo",
    description: "Echo back whatever you send",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "fail_tool",
    description: "Always reports an error",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow_tool",
    description: "Never responds (for timeout tests)",
    inputSchema: { type: "object", properties: {} },
  },
];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.method === undefined) return;
  if (msg.method.startsWith("notifications/")) return; // no response

  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "0" },
      });
      break;
    case "tools/list":
      respond(msg.id, { tools });
      break;
    case "tools/call": {
      const name = msg.params && msg.params.name;
      if (name === "echo") {
        respond(msg.id, { content: [{ type: "text", text: "echo: " + (msg.params.arguments.text ?? "") }] });
      } else if (name === "fail_tool") {
        respond(msg.id, { content: [{ type: "text", text: "boom" }], isError: true });
      } else if (name === "slow_tool") {
        // deliberately never respond
      } else {
        respond(msg.id, { content: [{ type: "text", text: "unknown tool" }] });
      }
      break;
    }
    default:
      respond(msg.id, {});
  }
});
