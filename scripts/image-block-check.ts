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

        // One block, not two: the frame pair is tiled into a single image so a
        // call costs one image slot. Hosts appear to cap images per
        // conversation, and the pair is only ever compared side by side anyway.
        const imageBlocks = jobRes.content.filter((c: any) => c.type === 'image');
        check(
            'check_job returns exactly one image block (tiled frame pair)',
            imageBlocks.length === 1,
            `${imageBlocks.length} image block(s)`,
        );

        if (imageBlocks.length === 1) {
            check(
                'image block declares a media type',
                imageBlocks[0].mimeType === 'image/jpeg',
                imageBlocks[0].mimeType,
            );
            const bytes = Buffer.from(imageBlocks[0].data, 'base64').length;
            check(
                'image payload is real and reasonably sized',
                bytes > 5_000 && bytes < 300_000,
                `${Math.round(bytes / 1024)}kB`,
            );
            // Decode to disk so it can be eyeballed as the model sees it.
            await writeFile('blockcheck-frames.jpg', Buffer.from(imageBlocks[0].data, 'base64'));
            console.log('  [wrote blockcheck-frames.jpg]');

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
