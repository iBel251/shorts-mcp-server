/**
 * Inspects what the DEPLOYED server actually returns from a tool call.
 *
 * Free: calls list_shots and check_job on an already-finished job, so nothing
 * is generated. Distinguishes "the server stopped sending images" from "the
 * host stopped rendering them", which is otherwise guesswork.
 *
 * Run with: npx tsx scripts/live-tool-check.ts [https://host]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const host = (process.argv[2] ?? 'https://shorts-mcp-server.onrender.com').replace(/\/+$/, '');

const client = new Client({ name: 'live-tool-check', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${host}/${cfg.sharedSecret}`)));

function describe(label: string, res: any): void {
    console.log(`\n--- ${label} ---`);
    console.log(`  isError: ${Boolean(res.isError)}`);
    console.log(`  content blocks: ${res.content?.length ?? 0}`);
    for (const [i, block] of (res.content ?? []).entries()) {
        if (block.type === 'image') {
            const bytes = Buffer.from(block.data ?? '', 'base64');
            const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
            const png = bytes[0] === 0x89 && bytes[1] === 0x50;
            console.log(
                `    [${i}] image  mime=${block.mimeType}  ${Math.round(bytes.length / 1024)}kB  ` +
                    `valid=${jpeg ? 'JPEG' : png ? 'PNG' : 'NO — CORRUPT'}`,
            );
        } else if (block.type === 'text') {
            console.log(`    [${i}] text   ${String(block.text).length} chars`);
        } else {
            console.log(`    [${i}] ${block.type}`);
        }
    }
    console.log(`  structuredContent: ${res.structuredContent ? 'present' : 'absent'}`);
}

const listRes: any = await client.callTool({ name: 'list_shots', arguments: {} });
describe('list_shots', listRes);

const list = JSON.parse(listRes.content[0].text);
const done = list.shots.find((s: any) => s.job_status === 'done');
if (!done) {
    console.log('\nNo completed job to inspect.');
} else {
    const jobRes: any = await client.callTool({
        name: 'check_job',
        arguments: { job_id: done.job_id },
    });
    describe(`check_job (shot ${done.shot_number})`, jobRes);

    const images = (jobRes.content ?? []).filter((c: any) => c.type === 'image');
    console.log(
        images.length === 2
            ? '\n  SERVER IS SENDING IMAGES CORRECTLY — any blankness is host-side rendering.'
            : `\n  SERVER PROBLEM: expected 2 image blocks, got ${images.length}.`,
    );
}

await client.close();
