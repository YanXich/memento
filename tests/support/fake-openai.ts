/**
 * Fake OpenAI-compatible server for end-to-end tests.
 *
 * Speaks the real wire format (SSE chunks, tool_calls deltas, usage) so tests
 * exercise the actual provider code path — not a mock of our own interface.
 * Replies are matched by predicate against the request body, newest rule last.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply {
  /** Applies when this returns true for the parsed request body. */
  match: (body: RequestBody) => boolean;
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface RequestBody {
  model: string;
  messages: { role: string; content: string | null }[];
  tools?: { function: { name: string } }[];
  [key: string]: unknown;
}

export interface FakeServer {
  url: string;
  requests: RequestBody[];
  close(): Promise<void>;
}

export function lastUserText(body: RequestBody): string {
  const users = body.messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return last?.content ?? "";
}

export function systemText(body: RequestBody): string {
  const sys = body.messages.find((m) => m.role === "system");
  return sys?.content ?? "";
}

export function hasToolResult(body: RequestBody): boolean {
  return body.messages.some((m) => m.role === "tool");
}

export async function startFakeOpenAi(replies: FakeReply[]): Promise<FakeServer> {
  const requests: RequestBody[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: RequestBody;
      try {
        body = JSON.parse(raw || "{}") as RequestBody;
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      requests.push(body);

      const reply = replies.find((r) => r.match(body)) ?? replies[replies.length - 1];
      if (!reply) {
        res.writeHead(500).end("no fake reply configured");
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

      if (reply.reasoning) {
        chunk({ choices: [{ delta: { reasoning_content: reply.reasoning } }] });
      }
      if (reply.text) {
        // Two deltas so tests exercise incremental accumulation.
        const mid = Math.floor(reply.text.length / 2);
        chunk({ choices: [{ delta: { content: reply.text.slice(0, mid) } }] });
        chunk({ choices: [{ delta: { content: reply.text.slice(mid) } }] });
      }
      for (const [idx, call] of (reply.toolCalls ?? []).entries()) {
        // Name first, arguments in two chunks — mirrors real OpenAI streaming.
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: idx, id: `call_${idx}`, type: "function", function: { name: call.name, arguments: "" } },
                ],
              },
            },
          ],
        });
        const argsJson = JSON.stringify(call.args);
        const cut = Math.floor(argsJson.length / 2);
        chunk({
          choices: [
            { delta: { tool_calls: [{ index: idx, function: { arguments: argsJson.slice(0, cut) } }] } },
          ],
        });
        chunk({
          choices: [
            { delta: { tool_calls: [{ index: idx, function: { arguments: argsJson.slice(cut) } }] } },
          ],
        });
      }
      chunk({
        choices: [{ finish_reason: reply.finishReason ?? (reply.toolCalls?.length ? "tool_calls" : "stop") }],
        usage: reply.usage ?? { prompt_tokens: 120, completion_tokens: 30 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        // Keep-alive sockets would otherwise keep the server open in tests.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
