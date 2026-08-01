/**
 * Live acceptance tests â€” spec section 10. THIS SPENDS MONEY.
 *
 * ~$0.20 for 4 stills + ~$0.35 for one 5s 720p video.
 *
 * Spawns the built server as a real subprocess so it can be killed and
 * restarted mid-job, which is the only honest way to test that a job survives
 * a restart. Run with: npx tsx scripts/acceptance.ts
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);
const cfg = getConfig();
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}/`;

const passed: string[] = [];
const failed: string[] = [];
/** Everything the server wrote, so we can prove the key never appears. */
let capturedLogs = '';

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        passed.push(name);
        console.log(`  ok    ${name}${detail ? ` â€” ${detail}` : ''}`);
    } else {
        failed.push(name);
        console.error(`  FAIL  ${name}${detail ? ` â€” ${detail}` : ''}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ server

let proc: ChildProcess | undefined;

async function startServer(label: string): Promise<void> {
    proc = spawn(process.execPath, ['dist/index.js'], {
        env: { ...process.env, PORT: String(PORT), JOB_POLL_INTERVAL_MS: '5000' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => (capturedLogs += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (capturedLogs += d.toString()));

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
            if (res.ok) {
                console.log(`\n[server ${label} up, pid ${proc.pid}]`);
                return;
            }
        } catch {
            /* not listening yet */
        }
        await sleep(300);
    }
    throw new Error(`server did not become healthy (${label})`);
}

async function killServer(): Promise<void> {
    if (!proc) return;
    const dead = new Promise<void>((r) => proc!.once('exit', () => r()));
    // SIGKILL, not SIGTERM: no graceful shutdown, to prove durability rather
    // than testing a clean drain path.
    proc.kill('SIGKILL');
    await dead;
    proc = undefined;
}

async function connect(): Promise<Client> {
    const client = new Client({ name: 'acceptance', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(BASE), {
            requestInit: { headers: { 'X-Api-Key': cfg.sharedSecret } },
        }),
    );
    return client;
}

async function callTool(
    client: Client,
    name: string,
    args: Record<string, unknown>,
): Promise<any> {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text);
    if (res.isError) throw new Error(`${name} failed: ${parsed.error ?? text}`);
    return parsed;
}

// -------------------------------------------------------------------- main

const tmp = await mkdtemp(join(tmpdir(), 'accept-'));
let allResponses = '';

try {
    await startServer('initial');

    // --- test 6: a request without the shared-secret header gets 401 -------
    {
        const res = await fetch(BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        check('6. request without shared secret â†’ 401', res.status === 401, `got ${res.status}`);
    }

    let client = await connect();

    // --- test 1: generate_still returns 4 stills, all in Supabase Storage --
    console.log('\n[generating 4 stills â€” this costs ~$0.20]');
    const still = await callTool(client, 'generate_still', {
        shot_description:
            'A lone figure in a long coat stands at the edge of a quiet harbour at dusk, seen from behind, boats still in the water',
    });
    allResponses += JSON.stringify(still);
    const shotId: string = still.shot_id;
    const stills: Array<{ asset_id: string; url: string }> = still.stills ?? [];

    check('1a. generate_still returned 4 stills', stills.length === 4, `got ${stills.length}`);
    check(
        '1b. all still URLs are our own Supabase Storage, not upstream xAI',
        stills.length > 0 && stills.every((s) => s.url.includes(cfg.supabaseUrl)),
        stills[0]?.url.slice(0, 60),
    );

    const fetched = await Promise.all(
        stills.map(async (s) => {
            const res = await fetch(s.url);
            return { ok: res.ok, bytes: (await res.arrayBuffer()).byteLength };
        }),
    );
    check(
        '1c. every still is actually retrievable from storage',
        fetched.every((f) => f.ok && f.bytes > 1000),
        fetched.map((f) => `${Math.round(f.bytes / 1024)}kB`).join(', '),
    );

    // Save one still so the style can be eyeballed afterwards.
    const sample = await fetch(stills[0]!.url).then((r) => r.arrayBuffer());
    const samplePath = join(process.cwd(), 'acceptance-still.png');
    await writeFile(samplePath, Buffer.from(sample));
    console.log(`  [saved a still for visual style check: ${samplePath}]`);

    // --- test 2: approve_still marks one, list_shots reflects it ----------
    const approved = await callTool(client, 'approve_still', { asset_id: stills[0]!.asset_id });
    allResponses += JSON.stringify(approved);

    const afterApprove = await callTool(client, 'list_shots', {});
    allResponses += JSON.stringify(afterApprove);
    const rowAfterApprove = afterApprove.shots.find((s: any) => s.shot_id === shotId);
    check(
        '2. approve_still marks one and list_shots reflects it',
        rowAfterApprove?.status === 'approved' &&
            rowAfterApprove?.still_approved === true &&
            rowAfterApprove?.still_asset_id === stills[0]!.asset_id,
        `status=${rowAfterApprove?.status} approved=${rowAfterApprove?.still_approved}`,
    );

    // --- test 3: animate returns a job id in under 2 seconds ---------------
    console.log('\n[submitting animate â€” this costs ~$0.35]');
    const t0 = Date.now();
    const anim = await callTool(client, 'animate', {
        asset_id: stills[0]!.asset_id,
        motion_instruction: 'very slow push in, water ripples faintly, coat moves slightly in the breeze',
        duration: 5,
    });
    const animMs = Date.now() - t0;
    allResponses += JSON.stringify(anim);
    const jobId: string = anim.job_id;

    check('3. animate returned a job id in under 2s', Boolean(jobId) && animMs < 2000, `${animMs}ms`);
    check('3b. animate reported status submitted', anim.status === 'submitted');

    // --- test 5: killing and restarting mid-job does not lose the job ------
    await sleep(3000); // let the job get genuinely in flight
    const beforeKill = await callTool(client, 'check_job', { job_id: jobId });
    console.log(`\n[killing server mid-job, job status was "${beforeKill.status}"]`);
    await client.close().catch(() => {});
    await killServer();

    await startServer('restarted');
    client = await connect();

    const afterRestart = await callTool(client, 'check_job', { job_id: jobId });
    allResponses += JSON.stringify(afterRestart);
    check(
        '5a. job still exists after a hard kill and restart',
        ['submitted', 'processing', 'done'].includes(afterRestart.status),
        `status=${afterRestart.status}`,
    );

    // --- test 4: check_job eventually returns MP4 + first/last frame PNGs --
    console.log('\n[polling for video completion, up to 10 minutes]');
    let job = afterRestart;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline && job.status !== 'done' && job.status !== 'failed' && job.status !== 'expired') {
        await sleep(10_000);
        job = await callTool(client, 'check_job', { job_id: jobId });
        process.stdout.write(`  â€¦${job.status} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
    }
    allResponses += JSON.stringify(job);

    check('5b. the job completed after the restart', job.status === 'done', `status=${job.status}${job.error ? ` error=${job.error}` : ''}`);

    if (job.status === 'done') {
        check(
            '4a. check_job returned video + first-frame + last-frame URLs',
            Boolean(job.video_url && job.first_frame_url && job.last_frame_url),
        );
        check(
            '4b. all three URLs are our own storage',
            [job.video_url, job.first_frame_url, job.last_frame_url].every((u: string) =>
                u?.includes(cfg.supabaseUrl),
            ),
        );

        const videoPath = join(tmp, 'out.mp4');
        const videoBytes = await fetch(job.video_url).then((r) => r.arrayBuffer());
        await writeFile(videoPath, Buffer.from(videoBytes));

        const probe = await execFileAsync(ffmpegStatic as unknown as string, ['-i', videoPath], {
            maxBuffer: 8 * 1024 * 1024,
        }).catch((e: any) => ({ stdout: '', stderr: String(e.stderr ?? '') }));
        const info = (probe as any).stderr || (probe as any).stdout;
        const dims = /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(info);
        const w = Number(dims?.[1] ?? 0);
        const h = Number(dims?.[2] ?? 0);

        check('4c. video is a real MP4', videoBytes.byteLength > 10_000, `${Math.round(videoBytes.byteLength / 1024)}kB`);
        check('4d. video is 9:16 vertical', h > w, `${w}x${h}`);
        check('4e. video is 720p (short side 720)', Math.min(w, h) === 720, `${w}x${h}`);

        const [ff, lf] = await Promise.all([
            fetch(job.first_frame_url).then((r) => r.arrayBuffer()),
            fetch(job.last_frame_url).then((r) => r.arrayBuffer()),
        ]);
        const isPng = (b: ArrayBuffer) => {
            const v = new Uint8Array(b);
            return v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47;
        };
        check('4f. first and last frames are valid PNGs', isPng(ff) && isPng(lf));
        check(
            '4g. first and last frames actually differ',
            ff.byteLength !== lf.byteLength ||
                Buffer.compare(Buffer.from(ff), Buffer.from(lf)) !== 0,
        );

        // Save both frames so the drift check can be done by eye too.
        await writeFile(join(process.cwd(), 'acceptance-first-frame.png'), Buffer.from(ff));
        await writeFile(join(process.cwd(), 'acceptance-last-frame.png'), Buffer.from(lf));
        console.log('  [saved acceptance-first-frame.png and acceptance-last-frame.png]');
    }

    // --- test 7: list_shots is enough to resume cold -----------------------
    await client.close().catch(() => {});
    const coldClient = await connect();
    const cold = await callTool(coldClient, 'list_shots', {});
    allResponses += JSON.stringify(cold);
    const coldRow = cold.shots.find((s: any) => s.shot_id === shotId);
    check(
        '7. list_shots returns enough to resume cold',
        Boolean(
            coldRow?.shot_number &&
                coldRow?.description &&
                coldRow?.status &&
                coldRow?.still_url &&
                (job.status !== 'done' ||
                    (coldRow.video_url && coldRow.first_frame_url && coldRow.last_frame_url)),
        ),
        `fields: ${Object.keys(coldRow ?? {}).join(', ')}`,
    );
    await coldClient.close().catch(() => {});

    // --- test 8: the xAI key appears nowhere ------------------------------
    check(
        '8a. xAI key appears in no tool response',
        !allResponses.includes(cfg.xaiApiKey),
    );
    check(
        '8b. xAI key appears in no server log line',
        !capturedLogs.includes(cfg.xaiApiKey),
        `${capturedLogs.length} bytes of logs scanned`,
    );
    check(
        '8c. Supabase service key appears in no log line',
        !capturedLogs.includes(cfg.supabaseServiceKey),
    );
} catch (err) {
    failed.push('unexpected error');
    console.error('\nERROR:', err instanceof Error ? err.stack : err);
} finally {
    await killServer();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(60)}`);
console.log(`PASSED: ${passed.length}   FAILED: ${failed.length}`);
if (failed.length > 0) console.log(`Failures:\n  - ${failed.join('\n  - ')}`);
process.exitCode = failed.length > 0 ? 1 : 0;
