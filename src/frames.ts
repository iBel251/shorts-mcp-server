import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * First-frame / last-frame extraction.
 *
 * Claude cannot watch video, but it can compare two stills. The characteristic
 * failure mode of these models is drift — starting in the correct flat style
 * and progressively realism-ifying, or animating something that was meant to
 * stay still. In testing a hand that began as a correct open palm had curled
 * into a fist by the last frame, and only manual screenshotting caught it.
 * Extracting both frames automatically turns that manual loop into something
 * Claude can do unprompted on every shot.
 */

/**
 * Resolve an ffmpeg binary.
 *
 * Locally (Windows dev) this is the one `ffmpeg-static` downloads. In the
 * container it is the apt-installed system binary, because relying on a
 * postinstall script to fetch a binary at image-build time is a needless build
 * dependency — and npm's script-blocking would silently skip it, leaving a
 * path that points at nothing. So: prefer the bundled binary only if it really
 * exists on disk, else fall back to PATH. `FFMPEG_PATH` overrides both.
 */
function resolveFfmpeg(): string {
    const override = process.env.FFMPEG_PATH?.trim();
    if (override) return override;
    const bundled = ffmpegStatic as unknown as string | null;
    if (bundled && existsSync(bundled)) return bundled;
    return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();

export interface ExtractedFrames {
    firstFrame: Uint8Array;
    lastFrame: Uint8Array;
}

export async function extractFirstAndLastFrame(mp4: Uint8Array): Promise<ExtractedFrames> {
    const dir = await mkdtemp(join(tmpdir(), 'shorts-frames-'));
    const videoPath = join(dir, 'input.mp4');
    const firstPath = join(dir, 'first.png');
    const lastPath = join(dir, 'last.png');

    try {
        await writeFile(videoPath, mp4);

        // Frame 1: seek to 0 and take a single frame.
        await run([
            '-y',
            '-i', videoPath,
            '-vf', 'select=eq(n\\,0)',
            '-vsync', '0',
            '-frames:v', '1',
            firstPath,
        ]);

        // Final frame: `-sseof -N` seeks relative to the end of the file. The
        // `-update 1` lets each decoded frame overwrite the last, so what
        // remains on disk is the true final frame rather than a frame near it.
        await run([
            '-y',
            '-sseof', '-1',
            '-i', videoPath,
            '-update', '1',
            '-q:v', '2',
            lastPath,
        ]);

        const [firstFrame, lastFrame] = await Promise.all([
            readFile(firstPath),
            readFile(lastPath),
        ]);
        return {
            firstFrame: new Uint8Array(firstFrame),
            lastFrame: new Uint8Array(lastFrame),
        };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

async function run(args: string[]): Promise<void> {
    try {
        await execFileAsync(FFMPEG, args, {
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
        });
    } catch (err) {
        const stderr =
            err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : '';
        log.error('ffmpeg failed', { args: args.join(' '), stderr: stderr.slice(-1000) });
        throw new Error(
            `Frame extraction failed: ${
                stderr.trim().split('\n').slice(-3).join(' ') ||
                (err instanceof Error ? err.message : 'unknown ffmpeg error')
            }`,
        );
    }
}

/**
 * Width for embedded previews, read per call so it can be changed from a host
 * dashboard and take effect on restart.
 *
 * Doubles as a diagnostic: setting PREVIEW_MAX_WIDTH=64 makes the embedded
 * images trivially small, which separates "the host dislikes the payload size"
 * from "the host dislikes the structure" without generating anything. Clamped
 * and validated so a typo degrades to the default instead of producing an
 * ffmpeg filter that fails and drops the image entirely.
 */
function previewWidth(): number {
    const parsed = Number(process.env.PREVIEW_MAX_WIDTH);
    if (!Number.isFinite(parsed) || parsed < 16) return 640;
    return Math.min(Math.round(parsed), 1920);
}

/**
 * Downscale an image to a JPEG small enough to embed in a tool response.
 *
 * The full-resolution PNGs are 400-600kB each, which is ~1.4MB of base64 for a
 * pair — wasteful to ship on every poll when the job is only to eyeball style
 * drift. A 640px-wide JPEG carries that judgement fine at roughly a tenth the
 * size. The full-resolution PNG stays in storage and its URL is still returned.
 */
export async function makePreview(
    image: Uint8Array,
    maxWidth = previewWidth(),
): Promise<{ data: Uint8Array; mimeType: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'shorts-preview-'));
    const inPath = join(dir, 'in.png');
    const outPath = join(dir, 'out.jpg');
    try {
        await writeFile(inPath, image);
        await run([
            '-y',
            '-i', inPath,
            // -2 keeps the height even and preserves aspect; never upscale.
            '-vf', `scale='min(${maxWidth},iw)':-2`,
            '-q:v', '4',
            outPath,
        ]);
        return { data: new Uint8Array(await readFile(outPath)), mimeType: 'image/jpeg' };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Tile several images into one contact sheet, left to right.
 *
 * Four variations returned as four image blocks is the greediest possible
 * shape: if a host caps how many images a conversation will carry, a single
 * call can exhaust the budget and every later image arrives as an empty slot.
 * One sheet costs one slot regardless of the variation count, and side by side
 * is a better way to compare them anyway.
 */
export async function makeContactSheet(
    images: Uint8Array[],
    cellWidth = 320,
): Promise<{ data: Uint8Array; mimeType: string }> {
    if (images.length === 0) throw new Error('makeContactSheet needs at least one image');
    if (images.length === 1) return makePreview(images[0]!, cellWidth * 2);

    const dir = await mkdtemp(join(tmpdir(), 'shorts-sheet-'));
    try {
        const inputs: string[] = [];
        for (const [i, image] of images.entries()) {
            const path = join(dir, `in${i}.png`);
            await writeFile(path, image);
            inputs.push('-i', path);
        }

        // Scale every cell to identical dimensions first: hstack requires it,
        // and upstream is not guaranteed to return a consistent size.
        const scale = images
            .map((_, i) => `[${i}:v]scale=${cellWidth}:-2,setsar=1[c${i}]`)
            .join(';');
        const stack = `${images.map((_, i) => `[c${i}]`).join('')}hstack=inputs=${images.length}[out]`;

        const outPath = join(dir, 'sheet.jpg');
        await run([
            '-y',
            ...inputs,
            '-filter_complex', `${scale};${stack}`,
            '-map', '[out]',
            '-frames:v', '1',
            '-q:v', '4',
            outPath,
        ]);

        return { data: new Uint8Array(await readFile(outPath)), mimeType: 'image/jpeg' };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Verify the bundled ffmpeg binary is usable. Called once at boot. */
export async function checkFfmpeg(): Promise<string> {
    const { stdout } = await execFileAsync(FFMPEG, ['-version'], { windowsHide: true });
    return stdout.split('\n')[0] ?? 'ffmpeg';
}
