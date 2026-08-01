/**
 * Verifies check_job and list_shots against real data already in the database.
 *
 * Costs nothing — reuses the harbour shot from the acceptance run rather than
 * generating anything. Proves the frames come back as MCP image blocks the
 * model can actually look at, not just URLs it cannot open.
 *
 * Run with: npx tsx scripts/image-block-check.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const PORT = 3997;
const passed: string[] = [];
const failed: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
    (ok ? passed : failed).push(name);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let proc: ChildProcess | undefined;
proc = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
    try {
        if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {
        /* not up */
    }
    await sleep(300);
}

try {
    const client = new Client({ name: 'image-check', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/`), {
            requestInit: { headers: { 'X-Api-Key': cfg.sharedSecret } },
        }),
    );

    // ---------------------------------------------------------- list_shots
    const listRes: any = await client.callTool({ name: 'list_shots', arguments: {} });
    const list = JSON.parse(listRes.content[0].text);

    check('list_shots returns a projects list', Array.isArray(list.projects), `${list.projects?.length} project(s)`);

    const done = list.shots.find((s: any) => s.job_status === 'done');
    check('found a completed shot to inspect', Boolean(done), done ? `shot ${done.shot_number}` : 'none');

    if (done) {
        check(
            'list_shots returns every still variation, not just the approved one',
            Array.isArray(done.stills) && done.stills.length === done.still_count,
            `still_count=${done.still_count}, stills[]=${done.stills?.length}`,
        );
        check(
            'each variation carries its own asset_id',
            done.stills.every((s: any) => s.asset_id && s.url),
            done.stills.map((s: any) => (s.approved ? 'approved' : 'unapproved')).join(', '),
        );

        // ------------------------------------------------------- check_job
        const jobRes: any = await client.callTool({
            name: 'check_job',
            arguments: { job_id: done.job_id },
        });

        const imageBlocks = jobRes.content.filter((c: any) => c.type === 'image');
        check('check_job returns image content blocks', imageBlocks.length === 2, `${imageBlocks.length} image block(s)`);

        if (imageBlocks.length === 2) {
            check(
                'image blocks declare a media type',
                imageBlocks.every((b: any) => b.mimeType === 'image/jpeg'),
                imageBlocks[0].mimeType,
            );
            const sizes = imageBlocks.map((b: any) => Buffer.from(b.data, 'base64').length);
            check(
                'image payloads are real and reasonably sized',
                sizes.every((n: number) => n > 5_000 && n < 300_000),
                sizes.map((n: number) => `${Math.round(n / 1024)}kB`).join(', '),
            );
            // Decode to disk so the frames can be eyeballed as the model sees them.
            await writeFile('blockcheck-first.jpg', Buffer.from(imageBlocks[0].data, 'base64'));
            await writeFile('blockcheck-last.jpg', Buffer.from(imageBlocks[1].data, 'base64'));
            console.log('  [wrote blockcheck-first.jpg / blockcheck-last.jpg]');

            const parsed = JSON.parse(jobRes.content[0].text);
            check(
                'URLs are still returned alongside the images',
                Boolean(parsed.video_url && parsed.first_frame_url && parsed.last_frame_url),
            );
        }

        // include_images:false must suppress them for token control.
        const lean: any = await client.callTool({
            name: 'check_job',
            arguments: { job_id: done.job_id, include_images: false },
        });
        check(
            'include_images:false suppresses the image blocks',
            lean.content.filter((c: any) => c.type === 'image').length === 0,
        );
    }

    await client.close();
} catch (err) {
    failed.push('error');
    console.error('ERROR:', err instanceof Error ? err.message : err);
} finally {
    proc?.kill('SIGKILL');
}

console.log(`\nPASSED: ${passed.length}  FAILED: ${failed.length}`);
process.exitCode = failed.length > 0 ? 1 : 0;
