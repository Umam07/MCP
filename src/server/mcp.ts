import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, toolManifest } from "../tools/index.js";
import { auditLog } from "../logger.js";

export { SERVER_NAME, SERVER_VERSION };

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  for (const t of toolManifest()) {
    server.tool(t.name, t.description, t.shape, async (args: Record<string, unknown>) => {
      try {
        const outcome = await t.handler(args);
        auditLog("tool_call", { tool: t.name, ok: true });
        return { content: [{ type: "text" as const, text: outcome.text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        auditLog("tool_call", { tool: t.name, ok: false, error: msg });
        return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
      }
    });
  }
  return server;
}
