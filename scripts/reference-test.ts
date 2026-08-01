/**
 * Live test of reference-image continuity. Costs ~$0.10 (2 images).
 *
 * Takes the approved still from an existing shot and generates a NEW shot in a
 * different setting using it as a reference, so the question "did the character
 * survive?" can be answered by looking rather than assumed.
 *
 * Run with: npx tsx scripts/reference-test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const PORT = 3996;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc: ChildProcess = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
    try {
        if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {
        /* waiting */
    }
    await sleep(300);
}

try {
    const client = new Client({ name: 'reference-test', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/`), {
            requestInit: { headers: { 'X-Api-Key': cfg.sharedSecret } },
        }),
    );

    const listRes: any = await client.callTool({ name: 'list_shots', arguments: {} });
    const list = JSON.parse(listRes.content[0].text);
    const source = list.shots.find((s: any) => s.still_approved);
    if (!source) throw new Error('no approved still to reference');
    console.log(`Referencing the approved still from shot ${source.shot_number}.\n`);

    // Deliberately a different setting, so anything that carries over is the
    // reference doing its job rather than the prompt repeating itself.
    const res: any = await client.callTool({
        name: 'generate_still',
        arguments: {
            shot_description:
                'The same man in the long coat now stands alone on a narrow cobbled ' +
                'street between tall terraced houses at night, seen from behind, ' +
                'a single street lamp ahead of him',
            reference_asset_ids: [source.still_asset_id],
            count: 2,
            project_name: 'reference-test',
        },
    });

    const payload = JSON.parse(res.content[0].text);
    if (res.isError) throw new Error(payload.error);

    console.log(`  generated ${payload.stills.length} still(s) in project "reference-test"`);
    const images = res.content.filter((c: any) => c.type === 'image');
    console.log(`  ${images.length} image block(s) returned`);

    for (const [i, block] of images.entries()) {
        const file = `reftest-${i + 1}.jpg`;
        await writeFile(file, Buffer.from(block.data, 'base64'));
        console.log(`  wrote ${file}`);
    }
    console.log('\nCompare reftest-*.jpg against the harbour still for character continuity.');
} catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
} finally {
    proc.kill('SIGKILL');
}
