import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GameEngine } from "./engine.js";
import { startWebServer } from "./web-server.js";
import { createMcpServer } from "./mcp-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.DM_DATA_FILE ?? path.join(__dirname, "..", "data", "game.json");
const port = Number(process.env.PORT ?? 8765);

const engine = new GameEngine({ dataFile });
const { broadcast } = startWebServer({ engine, port });
const mcpServer = createMcpServer({ engine, broadcast });

await mcpServer.connect(new StdioServerTransport());
console.error(`[dungeon-master] MCP server up (stdio), game board at http://localhost:${port}`);
