/** Confirms the deployed widgets can render from base64 rather than fetching. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const host = (process.argv[2] ?? 'https://shorts-mcp-server.onrender.com').replace(/\/+$/, '');

const client = new Client({ name: 'widget-probe', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${host}/${cfg.sharedSecret}`)));

for (const uri of ['ui://shorts/gallery.html', 'ui://shorts/player.html']) {
    const read = await client.readResource({ uri });
    const item = read.contents[0] as { text?: string; _meta?: any };
    const html = item.text ?? '';
    console.log(
        `  ${uri}\n    inlines data: URIs : ${html.includes('base64,')}\n` +
            `    link fallback      : ${html.includes('blocked by sandbox')}\n` +
            `    csp on read result : ${
                item._meta?.ui?.csp?.resourceDomains?.join(', ') ?? 'MISSING'
            }`,
    );
}
await client.close();
