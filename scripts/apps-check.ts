/** Verifies MCP Apps UI resources on the deployed server. Free to run. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const host = (process.argv[2] ?? 'https://shorts-mcp-server.onrender.com').replace(/\/+$/, '');

const client = new Client({ name: 'apps-check', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${host}/${cfg.sharedSecret}`)));

const { tools } = await client.listTools();
for (const t of tools) {
    const uri = (t._meta as any)?.ui?.resourceUri;
    if (uri) console.log(`  ${t.name.padEnd(16)} -> ${uri}`);
}

const { resources } = await client.listResources();
if (resources.length === 0) {
    console.log('\n  NO UI RESOURCES — old build still serving');
    process.exitCode = 1;
} else {
    for (const r of resources) {
        const read = await client.readResource({ uri: r.uri });
        const item = read.contents[0] as { text?: string; mimeType?: string };
        const csp = (r as any)._meta?.ui?.csp?.resourceDomains ?? [];
        console.log(
            `  ${r.uri}\n    mime: ${item.mimeType}\n    size: ${Math.round(
                (item.text?.length ?? 0) / 1024,
            )}kB\n    csp : ${csp.join(', ') || '(none — media will be blocked)'}`,
        );
    }
    console.log('\n  MCP Apps live.');
}
await client.close();
