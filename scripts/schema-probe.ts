/** Prints the deployed server's live tool schemas. Free to run. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const host = (process.argv[2] ?? 'https://shorts-mcp-server.onrender.com').replace(/\/+$/, '');

const client = new Client({ name: 'schema-probe', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${host}/${cfg.sharedSecret}`)));

const { tools } = await client.listTools();
for (const tool of tools) {
    const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    console.log(`  ${tool.name.padEnd(16)} ${props.join(', ')}`);
}
await client.close();
