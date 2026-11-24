#!/usr/bin/env node
/**
 * Basket MCP server (stdio): a thin client of the running basket service.
 *
 * It answers from the service's saved prices by default and can ask the
 * service for a live run (same queue, same per-site limits). It runs no
 * browser and opens no database itself. Tools live in src/mcp/tools.js.
 *
 *   JHOLA_URL    where the service runs (default http://127.0.0.1:7777; BASKET_URL also works)
 *
 * Register with:
 *   claude mcp add jhola -- node <abs path>/src/mcp-server.js
 *   Kiro: .kiro/settings/mcp.json, see README "Use it from an AI chatbot (MCP)"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS, callTool, makeClient } from './mcp/tools.js';
import { openInBrowser } from './ui-writer.js';

const client = makeClient();

const server = new Server({ name: 'basket', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  callTool(req.params.name, req.params.arguments ?? {}, { client, openUrl: openInBrowser }),
);

await server.connect(new StdioServerTransport());
console.error(`basket MCP server ready (stdio) -> ${client.baseUrl}`);
