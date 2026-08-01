/**
 * Verifies the DEPLOYED server the same way Claude's connector will:
 * OAuth discovery must disclaim itself, then a full MCP handshake over the
 * secret-in-URL route with no headers at all.
 *
 * Free of charge — lists tools, never generates anything.
 *
 * Run with: npx tsx scripts/live-check.ts [https://host]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const host = (process.argv[2] ?? 'https://shorts-mcp-server.onrender.com').replace(/\/+$/, '');
const connectorUrl = `${host}/${cfg.sharedSecret}`;

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log(`\nChecking ${host}\n`);

// Cold start on a sleeping free instance can take ~1 minute.
const health = await fetch(`${host}/healthz`, { signal: AbortSignal.timeout(120_000) });
check('health probe', health.ok, `HTTP ${health.status}`);

for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
]) {
    const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(60_000) });
    check(`${path} disclaims OAuth`, res.status === 404, `HTTP ${res.status}`);
}

// The bare URL must still be refused — the secret is what grants access.
const bare = await fetch(host, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    signal: AbortSignal.timeout(60_000),
});
check('bare URL is still rejected', bare.status === 401, `HTTP ${bare.status}`);

// Exactly what the connector does: no headers, credential in the URL.
try {
    const client = new Client({ name: 'live-check', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(connectorUrl)));
    const { tools } = await client.listTools();
    check(
        'MCP handshake over the connector URL',
        tools.length === 5,
        `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`,
    );
    await client.close();
} catch (err) {
    check('MCP handshake over the connector URL', false, err instanceof Error ? err.message : String(err));
}

console.log(failed === 0 ? '\nReady to connect from Claude.\n' : `\n${failed} check(s) failed.\n`);
process.exitCode = failed === 0 ? 0 : 1;
