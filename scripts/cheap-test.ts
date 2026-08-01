/**
 * Cheaper-config test: 480p at 6 seconds.
 *
 * Reuses an already-approved still so no image generation cost is incurred.
 * At the old model's rates this is 6s x $0.05 = ~$0.30, against $0.42 for the
 * same clip at 720p.
 *
 * Verifies that VIDEO_RESOLUTION is genuinely honoured end to end rather than
 * silently ignored upstream — the whole point of making it configurable.
 *
 * Run with: npx tsx scripts/cheap-test.ts
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
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}/`;

const RESOLUTION = process.env.TEST_RESOLUTION ?? '480p';
const DURATION = Number(process.env.TEST_DURATION ?? 6);

const passed: string[] = [];
const failed: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
    (ok ? passed : failed).push(name);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let proc: ChildProcess | undefined;

async function startServer(): Promise<void> {
    proc = spawn(process.execPath, ['dist/index.js'], {
        env: {
            ...process.env,
            PORT: String(PORT),
            VIDEO_RESOLUTION: RESOLUTION,
            JOB_POLL_INTERVAL_MS: '5000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        if (s.includes('listening')) process.stdout.write(`  [server: ${s.trim()}]\n`);
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
        } catch {
            /* not up yet */
        }
        await sleep(300);
    }
    throw new Error('server did not start');
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
    const res: any = await client.callTool({ name, arguments: args });
    const parsed = JSON.parse(res.content?.[0]?.text ?? '{}');
    if (res.isError) throw new Error(`${name}: ${parsed.error ?? 'failed'}`);
    return parsed;
}

const tmp = await mkdtemp(join(tmpdir(), 'cheap-'));

try {
    console.log(`\nTesting VIDEO_RESOLUTION=${RESOLUTION}, duration=${DURATION}s\n`);
    await startServer();

    const client = new Client({ name: 'cheap-test', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(BASE), {
            requestInit: { headers: { 'X-Api-Key': cfg.sharedSecret } },
        }),
    );

    // Reuse an existing approved still — no image generation cost.
    const shots = await callTool(client, 'list_shots', {});
    const reusable = shots.shots.find((s: any) => s.still_approved && s.still_asset_id);
    if (!reusable) throw new Error('no approved still to reuse — run acceptance.ts first');
    console.log(`  reusing approved still from shot ${reusable.shot_number}\n`);

    const t0 = Date.now();
    const anim = await callTool(client, 'animate', {
        asset_id: reusable.still_asset_id,
        motion_instruction:
            'very slow push in, water ripples faintly, coat moves slightly in the breeze',
        duration: DURATION,
    });
    check('animate accepted and returned fast', Boolean(anim.job_id), `${Date.now() - t0}ms`);

    console.log('\n  polling…');
    let job: any = { status: 'submitted' };
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline && !['done', 'failed', 'expired'].includes(job.status)) {
        await sleep(10_000);
        job = await callTool(client, 'check_job', { job_id: anim.job_id });
        console.log(`    …${job.status} (${Math.round((Date.now() - t0) / 1000)}s)`);
    }

    check('job completed', job.status === 'done', job.error ? `error=${job.error}` : job.status);

    if (job.status === 'done') {
        const path = join(tmp, 'out.mp4');
        const bytes = await fetch(job.video_url).then((r) => r.arrayBuffer());
        await writeFile(path, Buffer.from(bytes));

        const probe: any = await execFileAsync(ffmpegStatic as unknown as string, ['-i', path], {
            maxBuffer: 8 * 1024 * 1024,
        }).catch((e: any) => ({ stderr: String(e.stderr ?? '') }));
        const info = probe.stderr || probe.stdout || '';
        const dims = /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(info);
        const w = Number(dims?.[1] ?? 0);
        const h = Number(dims?.[2] ?? 0);
        const dur = /Duration:\s(\d+):(\d+):([\d.]+)/.exec(info);
        const seconds = dur
            ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
            : 0;
        const fps = /,\s([\d.]+)\sfps/.exec(info)?.[1];

        console.log('');
        check('video is 9:16 vertical', h > w, `${w}x${h}`);
        check(
            `resolution honoured (${RESOLUTION} → short side ${RESOLUTION.replace('p', '')})`,
            Math.min(w, h) === Number(RESOLUTION.replace('p', '')),
            `${w}x${h}`,
        );
        check(
            `duration honoured (~${DURATION}s)`,
            Math.abs(seconds - DURATION) <= 1,
            `${seconds}s`,
        );
        check('frames extracted at the new resolution', Boolean(job.first_frame_url && job.last_frame_url));

        const [ff, lf] = await Promise.all([
            fetch(job.first_frame_url).then((r) => r.arrayBuffer()),
            fetch(job.last_frame_url).then((r) => r.arrayBuffer()),
        ]);
        await writeFile(join(process.cwd(), `cheap-${RESOLUTION}-first-frame.png`), Buffer.from(ff));
        await writeFile(join(process.cwd(), `cheap-${RESOLUTION}-last-frame.png`), Buffer.from(lf));

        const cost = (DURATION * (RESOLUTION === '720p' ? 0.07 : 0.05)).toFixed(2);
        console.log(`\n  size: ${Math.round(bytes.byteLength / 1024)}kB, ${fps ?? '?'} fps`);
        console.log(`  cost: ~$${cost} (vs ~$${(DURATION * 0.07).toFixed(2)} at 720p)`);
        console.log(`  saved cheap-${RESOLUTION}-first-frame.png / -last-frame.png`);
    }
} catch (err) {
    failed.push('error');
    console.error('\nERROR:', err instanceof Error ? err.message : err);
} finally {
    proc?.kill('SIGKILL');
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nPASSED: ${passed.length}  FAILED: ${failed.length}`);
process.exitCode = failed.length > 0 ? 1 : 0;
