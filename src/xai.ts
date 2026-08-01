import { getConfig, ASPECT_RATIO } from './config.js';
import { log, redact } from './logger.js';

/**
 * Thin client for the xAI Imagine API.
 *
 * The API key is injected here and only here. Nothing in this module puts the
 * key into a return value, and upstream error bodies are redacted before they
 * are allowed to propagate — an error payload that echoes the Authorization
 * header must not leak through a tool response.
 */

// Documented limits: 300 RPM / 10 RPS. Stay under the per-second cap with a
// small token bucket; a `count: 8` still request fires 8 image calls at once.
const MAX_REQUESTS_PER_SECOND = 8;
const queue: Array<() => void> = [];
let windowStart = 0;
let windowCount = 0;

async function rateLimit(): Promise<void> {
    const now = Date.now();
    if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
    }
    if (windowCount < MAX_REQUESTS_PER_SECOND) {
        windowCount++;
        return;
    }
    const waitMs = 1000 - (now - windowStart);
    await new Promise<void>((resolve) => {
        queue.push(resolve);
        setTimeout(() => {
            const next = queue.shift();
            next?.();
        }, Math.max(waitMs, 10));
    });
    return rateLimit();
}

export class XaiError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly retryable = false,
    ) {
        super(message);
        this.name = 'XaiError';
    }
}

async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number },
): Promise<T> {
    const cfg = getConfig();
    const url = `${cfg.xaiBaseUrl}${path}`;
    const maxAttempts = 3;
    let lastError: XaiError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await rateLimit();
        let res: Response;
        try {
            res = await fetch(url, {
                method: init.method,
                headers: {
                    Authorization: `Bearer ${cfg.xaiApiKey}`,
                    'Content-Type': 'application/json',
                },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
                signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
            });
        } catch (err) {
            lastError = new XaiError(
                `Network error calling xAI ${path}: ${
                    err instanceof Error ? redact(err.message) : 'unknown'
                }`,
                undefined,
                true,
            );
            if (attempt < maxAttempts) {
                await backoff(attempt);
                continue;
            }
            throw lastError;
        }

        if (res.ok) {
            return (await res.json()) as T;
        }

        // Redact before the body goes anywhere — it may echo our own request.
        const raw = redact(await res.text().catch(() => ''));
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new XaiError(
            `xAI ${path} returned ${res.status}${raw ? `: ${truncate(raw)}` : ''}`,
            res.status,
            retryable,
        );
        log.warn('xai request failed', { path, status: res.status, attempt, retryable });

        if (retryable && attempt < maxAttempts) {
            await backoff(attempt, res.headers.get('retry-after'));
            continue;
        }
        throw lastError;
    }

    throw lastError ?? new XaiError(`xAI ${path} failed`);
}

function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const headerMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const ms = Number.isFinite(headerMs) ? headerMs : 500 * 2 ** (attempt - 1);
    return new Promise((r) => setTimeout(r, Math.min(ms, 10_000)));
}

function truncate(text: string, max = 500): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ------------------------------------------------------------ image generation

interface ImageResponse {
    data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
}

/**
 * Generate one image. Synchronous upstream — image generation is fast enough
 * that the tool can return the results directly. $0.05 per image.
 */
export async function generateImage(prompt: string): Promise<string> {
    const cfg = getConfig();
    const body = await call<ImageResponse>('/images/generations', {
        method: 'POST',
        body: {
            model: cfg.imageModel,
            prompt,
            n: 1,
            aspect_ratio: ASPECT_RATIO,
            response_format: 'url',
        },
        timeoutMs: 180_000,
    });

    const url = body.data?.[0]?.url;
    if (!url) {
        throw new XaiError('xAI image response contained no URL');
    }
    return url;
}

// ------------------------------------------------------------ video generation

interface VideoSubmitResponse {
    request_id?: string;
    id?: string;
}

/**
 * Submit an image-to-video job. Asynchronous — returns a request_id, not a
 * video. 9:16 is sent natively so nothing is ever reframed in post.
 */
export async function submitVideo(input: {
    prompt: string;
    imageUrl: string;
    duration: number;
}): Promise<string> {
    const cfg = getConfig();
    const body = await call<VideoSubmitResponse>('/videos/generations', {
        method: 'POST',
        body: {
            model: cfg.videoModel,
            prompt: input.prompt,
            image: { url: input.imageUrl },
            duration: input.duration,
            aspect_ratio: ASPECT_RATIO,
            resolution: cfg.videoResolution,
        },
        timeoutMs: 60_000,
    });

    const requestId = body.request_id ?? body.id;
    if (!requestId) {
        throw new XaiError('xAI video submission returned no request_id');
    }
    return requestId;
}

export interface VideoPollResult {
    status: 'pending' | 'done' | 'failed' | 'expired';
    videoUrl?: string;
    error?: string;
}

interface VideoStatusResponse {
    status?: string;
    video?: { url?: string };
    url?: string;
    error?: string | { message?: string };
    failure_reason?: string;
}

/** Poll a submitted video job. */
export async function pollVideo(requestId: string): Promise<VideoPollResult> {
    const body = await call<VideoStatusResponse>(
        `/videos/${encodeURIComponent(requestId)}`,
        { method: 'GET', timeoutMs: 30_000 },
    );

    const status = (body.status ?? '').toLowerCase();
    const errorText =
        typeof body.error === 'string'
            ? body.error
            : (body.error?.message ?? body.failure_reason);

    if (status === 'done' || status === 'completed' || status === 'succeeded') {
        const url = body.video?.url ?? body.url;
        if (!url) {
            return { status: 'failed', error: 'Upstream reported done but returned no video URL' };
        }
        return { status: 'done', videoUrl: url };
    }
    if (status === 'failed' || status === 'error') {
        return { status: 'failed', error: redact(errorText ?? 'Upstream job failed') };
    }
    if (status === 'expired') {
        return { status: 'expired', error: redact(errorText ?? 'Upstream job expired') };
    }
    return { status: 'pending' };
}
