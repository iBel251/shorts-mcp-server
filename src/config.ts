import 'dotenv/config';

/**
 * The style constant. Owned by the server, versioned here, appended to every
 * prompt that goes upstream.
 *
 * The xAI endpoints are stateless — nothing carries over between calls. In
 * testing, omitting this block produced fully photorealistic output (total
 * style collapse) and the model repeatedly tried to make characters face
 * camera and speak. Keeping it server-side means neither the user nor Claude
 * can forget it, and there is deliberately no `style` tool parameter.
 */
export const STYLE_BLOCK =
    'Stylized 2D cinematic editorial illustration, graphic novel aesthetic, ' +
    'dramatic noir lighting, exaggerated editorial cartoon caricature character ' +
    'design, angular faces, oversized expressive eyes, exaggerated noses, brows, ' +
    'jaws and ears, simplified non-realistic skin, painterly textures, strong ' +
    'silhouettes, deep shadows, atmospheric smoke or haze, limited dark green, ' +
    'burnt orange, red and black color palette, cinematic composition, ' +
    'foreground-midground-background depth, moving illustrated graphic novel feel.';

export const NEGATIVE_BLOCK =
    'Nobody speaks or talks. No text, no captions, no promotional banners, ' +
    'no watermark, no logo, no unrelated extra characters, no fast motion, ' +
    'no photorealism, no 3D plastic render, no corporate vector art, ' +
    'no realistic handsome faces, no naturalistic human proportions, no pores, ' +
    'no stubble, no realistic hair strands, no realistic eyes or lips, no morphing, ' +
    'no scene transformation, no face morphing, no body distortion.';

/**
 * Appended when reference images are supplied. Like the style block, this is
 * server-owned: the point of a reference is continuity, so the instruction to
 * honour it should not be something the caller can forget to include.
 */
export const REFERENCE_BLOCK =
    'Match the character design, facial features, costume and colour palette of ' +
    'the reference image exactly. Keep the same subject; change only the ' +
    'described action, framing and setting.';

/** Bump when STYLE_BLOCK / NEGATIVE_BLOCK change, so old shots stay traceable. */
export const STYLE_VERSION = 4;

/** Max reference images per request, per the upstream limit. */
export const MAX_REFERENCE_IMAGES = 3;

/**
 * Assemble a full upstream prompt. The palette override slots in after the
 * base style because palette shifts per story beat while the base style never
 * does.
 */
export function buildPrompt(parts: {
    shotDescription: string;
    motionInstruction?: string | undefined;
    paletteOverride?: string | undefined;
    hasReferences?: boolean | undefined;
}): string {
    return [
        parts.shotDescription.trim(),
        parts.motionInstruction?.trim(),
        STYLE_BLOCK,
        parts.paletteOverride?.trim(),
        parts.hasReferences ? REFERENCE_BLOCK : undefined,
        NEGATIVE_BLOCK,
    ]
        .filter((s): s is string => Boolean(s && s.length > 0))
        .join(' ');
}

// ------------------------------------------------------------------- env

function required(name: string): string {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        throw new Error(
            `Missing required environment variable ${name}. ` +
                'Copy .env.example to .env and fill it in.',
        );
    }
    return value.trim();
}

function optional(name: string, fallback: string): string {
    const value = process.env[name];
    return value && value.trim() !== '' ? value.trim() : fallback;
}

function boolean(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numeric(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Environment variable ${name} must be a number, got "${raw}".`);
    }
    return parsed;
}

export interface Config {
    xaiApiKey: string;
    xaiBaseUrl: string;
    supabaseUrl: string;
    supabaseServiceKey: string;
    supabaseBucket: string;
    sharedSecret: string;
    authHeader: string;
    /** Configurable so swapping models is a config change, not a refactor. */
    videoModel: string;
    videoResolution: string;
    imageModel: string;
    port: number;
    jobPollIntervalMs: number;
    jobTimeoutMs: number;
    logLevel: string;
    /**
     * Whether to advertise MCP Apps UI widgets.
     *
     * A kill switch rather than a preference. Declaring a UI resource on a tool
     * appears to change how some hosts handle that tool's result — the result
     * is routed to the widget, and the image content blocks may stop reaching
     * the model. That trade is bad: the model comparing frames is the
     * load-bearing quality check, and a widget the human looks at does not
     * replace it. Being able to turn widgets off from the dashboard, without a
     * code change or redeploy, makes that an experiment instead of a guess.
     */
    enableMcpApps: boolean;
    /**
     * Vision model used for the server-side critique pass, which returns a
     * structured judgement as text. Text reaches the model reliably; image
     * blocks currently do not.
     */
    visionModel: string;
    enableVisionCritique: boolean;
}

let cached: Config | undefined;

/** Drop the memoised config so a changed env var takes effect. Tests only. */
export function resetConfigCache(): void {
    cached = undefined;
}

export function getConfig(): Config {
    if (cached) return cached;
    cached = {
        xaiApiKey: required('XAI_API_KEY'),
        xaiBaseUrl: optional('XAI_BASE_URL', 'https://api.x.ai/v1').replace(/\/+$/, ''),
        supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
        supabaseServiceKey: required('SUPABASE_SERVICE_KEY'),
        supabaseBucket: optional('SUPABASE_BUCKET', 'shorts'),
        sharedSecret: required('SHORTS_SHARED_SECRET'),
        // Defaults to an allowlisted name: claude.ai only forwards connector
        // headers from a fixed list (authorization, x-api-key, x-auth-token),
        // so a bespoke name would never reach us.
        authHeader: optional('AUTH_HEADER', 'x-api-key').toLowerCase(),
        videoModel: optional('VIDEO_MODEL', 'grok-imagine-video'),
        videoResolution: optional('VIDEO_RESOLUTION', '720p'),
        imageModel: optional('IMAGE_MODEL', 'grok-imagine-image-quality'),
        port: numeric('PORT', 3000),
        jobPollIntervalMs: numeric('JOB_POLL_INTERVAL_MS', 10_000),
        jobTimeoutMs: numeric('JOB_TIMEOUT_MS', 30 * 60 * 1000),
        logLevel: optional('LOG_LEVEL', 'info'),
        enableMcpApps: boolean('ENABLE_MCP_APPS', true),
        visionModel: optional('VISION_MODEL', 'grok-4.5'),
        enableVisionCritique: boolean('ENABLE_VISION_CRITIQUE', true),
    };
    return cached;
}

/** Aspect ratio is always 9:16 — vertical is native upstream, never reframe in post. */
export const ASPECT_RATIO = '9:16';

export const MIN_DURATION = 1;
export const MAX_DURATION = 15;
export const MAX_STILL_COUNT = 8;
export const DEFAULT_STILL_COUNT = 4;
export const DEFAULT_DURATION = 5;
export const DEFAULT_PROJECT_NAME = 'Default Project';
