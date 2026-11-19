#!/usr/bin/env node
/**
 * Smoke-test the MCP server over stdio without a client:
 * initialize -> tools/list, and print what a client would see.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'mcp-server.js');

const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const seen = [];

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      seen.push(JSON.parse(line));
    } catch {
      /* not a frame */
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  },
});

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
}, 600);

setTimeout(() => {
  const init = seen.find((m) => m.id === 1);
  const tools = seen.find((m) => m.id === 2);

  console.log('initialize :', init?.result ? `ok — ${init.result.serverInfo?.name}` : 'FAILED');
  if (tools?.result?.tools) {
    console.log(`tools/list : ok — ${tools.result.tools.length} tools`);
    for (const t of tools.result.tools) {
      const req = t.inputSchema?.required?.join(', ') || 'none';
      console.log(`  · ${t.name}  (required: ${req})`);
    }
  } else {
    console.log('tools/list : FAILED');
    console.log(JSON.stringify(tools, null, 2)?.slice(0, 400));
  }
  child.kill();
  process.exit(init?.result && tools?.result ? 0 : 1);
}, 2200);
