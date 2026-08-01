import { getConfig, NEGATIVE_BLOCK, STYLE_BLOCK } from './config.js';
import { errorMessage, log, redact } from './logger.js';

/**
 * Server-side vision pass.
 *
 * Image content blocks are unreliable — hosts appear to cap how many images a
 * conversation will carry, after which they arrive as empty slots and the model
 * is silently blind. Text always gets through. So the server looks at the image
 * itself and returns a structured critique as text, letting the model accept,
 * reject and regenerate on its own even when it cannot see.
 *
 * This is not a substitute for seeing the picture and should never be presented
 * as one: it is a description, and the model is judging a description. But the
 * checks this pipeline actually runs — did it obey no-people, no-lettering,
 * flat-2D, the requested framing — are exactly the checks a vision pass can
 * carry.
 *
 * The image blocks are still returned. This is a floor, not a replacement.
 */

export interface Critique {
    /** Overall call: is this usable as-is? */
    verdict: 'accept' | 'regenerate';
    /** One line, why. */
    reason: string;
    /** Holds the flat 2D look: even black outlines, flat fills, no photorealism. */
    style_ok: boolean;
    /** How many people are visible. The pipeline usually wants 0 or 1. */
    people: number;
    /** Any face turned toward camera — an explicit negative-prompt violation. */
    faces_to_camera: boolean;
    /** Any lettering, captions, signage or watermark — also explicitly banned. */
    visible_text: boolean;
    /** Palette reads muted and desaturated rather than saturated or warm. */
    palette_ok: boolean;
    /** Framing and camera position match what was asked for. */
    framing_ok: boolean;
    /** Broken hands, faces, perspective, or impossible geometry. */
    anatomy_issues: string | null;
    /** Concrete prompt change to try if regenerating. */
    fix_suggestion: string | null;
}

const SCHEMA_HINT = `Reply with ONLY a JSON object, no prose and no code fences, with exactly these keys:
{
  "verdict": "accept" | "regenerate",
  "reason": "<one short sentence>",
  "style_ok": <boolean>,
  "people": <integer>,
  "faces_to_camera": <boolean>,
  "visible_text": <boolean>,
  "palette_ok": <boolean>,
  "framing_ok": <boolean>,
  "anatomy_issues": <string or null>,
  "fix_suggestion": <string or null>
}`;

function rubric(shotDescription: string, paletteOverride?: string): string {
    return [
        'You are a quality checker for a stylised 2D animation pipeline. Judge the image strictly.',
        '',
        `REQUIRED STYLE: ${STYLE_BLOCK}`,
        paletteOverride ? `REQUIRED PALETTE: ${paletteOverride}` : '',
        `MUST NOT CONTAIN: ${NEGATIVE_BLOCK}`,
        `INTENDED SHOT: ${shotDescription}`,
        '',
        'Judge only what is actually visible. Do not be generous: this exists to catch',
        'failures, and a wrong "accept" is far more costly than a wrong "regenerate".',
        'Set style_ok false for any gradient shading, photographic texture, soft lighting',
        'or realistic skin. Set verdict to "regenerate" if style_ok, palette_ok or',
        'framing_ok is false, if visible_text is true, if faces_to_camera is true, or if',
        'anatomy_issues is non-null.',
        '',
        SCHEMA_HINT,
    ]
        .filter(Boolean)
        .join('\n');
}

interface ChatResponse {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function chat(content: unknown[], maxTokens: number): Promise<string> {
    const cfg = getConfig();
    const res = await fetch(`${cfg.xaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.xaiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: cfg.visionModel,
            messages: [{ role: 'user', content }],
            max_tokens: maxTokens,
            temperature: 0,
        }),
        signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
        throw new Error(
            `vision ${res.status}: ${redact(await res.text().catch(() => '')).slice(0, 200)}`,
        );
    }
    const body = (await res.json()) as ChatResponse;
    return body.choices?.[0]?.message?.content?.trim() ?? '';
}

/** Models sometimes wrap JSON in fences or prose despite instructions. */
function parseJson<T>(raw: string): T | undefined {
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
        return undefined;
    }
}

function coerce(raw: Record<string, unknown>): Critique {
    const bool = (v: unknown, fallback = false): boolean =>
        typeof v === 'boolean' ? v : fallback;
    const str = (v: unknown): string | null =>
        typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null;

    const critique: Critique = {
        verdict: raw.verdict === 'accept' ? 'accept' : 'regenerate',
        reason: str(raw.reason) ?? 'No reason given.',
        style_ok: bool(raw.style_ok),
        people: Number.isFinite(Number(raw.people)) ? Number(raw.people) : -1,
        faces_to_camera: bool(raw.faces_to_camera),
        visible_text: bool(raw.visible_text),
        palette_ok: bool(raw.palette_ok),
        framing_ok: bool(raw.framing_ok),
        anatomy_issues: str(raw.anatomy_issues),
        fix_suggestion: str(raw.fix_suggestion),
    };

    // Enforce the rubric server-side rather than trusting the model to apply
    // its own rule: a self-contradictory "accept" is exactly the failure this
    // whole mechanism exists to prevent.
    if (
        !critique.style_ok ||
        !critique.palette_ok ||
        !critique.framing_ok ||
        critique.visible_text ||
        critique.faces_to_camera ||
        critique.anatomy_issues
    ) {
        critique.verdict = 'regenerate';
    }
    return critique;
}

/** Critique one generated still against the pipeline's rules. */
export async function critiqueStill(
    imageUrl: string,
    shotDescription: string,
    paletteOverride?: string,
): Promise<Critique | { error: string }> {
    try {
        const raw = await chat(
            [
                { type: 'image_url', image_url: { url: imageUrl } },
                { type: 'text', text: rubric(shotDescription, paletteOverride) },
            ],
            400,
        );
        const parsed = parseJson<Record<string, unknown>>(raw);
        if (!parsed) return { error: `unparseable critique: ${raw.slice(0, 120)}` };
        return coerce(parsed);
    } catch (err) {
        log.warn('critique failed', { error: errorMessage(err) });
        return { error: errorMessage(err) };
    }
}

export interface DriftReport {
    /** Did the style hold from first frame to last? */
    drift: boolean;
    /** What changed, or a statement that nothing did. */
    summary: string;
    /** Verdict for the clip as a whole. */
    verdict: 'accept' | 'regenerate';
}

/**
 * Compare a clip's first and last frame in a single call.
 *
 * This is the drift check as text. The characteristic failure is starting in
 * the correct flat style and progressively turning photorealistic, or animating
 * something that was meant to stay still.
 */
export async function critiqueDrift(
    firstFrameUrl: string,
    lastFrameUrl: string,
    shotDescription: string,
): Promise<DriftReport | { error: string }> {
    try {
        const raw = await chat(
            [
                { type: 'image_url', image_url: { url: firstFrameUrl } },
                { type: 'image_url', image_url: { url: lastFrameUrl } },
                {
                    type: 'text',
                    text: [
                        'These are the FIRST and LAST frames of one short animated clip.',
                        `The intended shot was: ${shotDescription}`,
                        `The required style throughout is: ${STYLE_BLOCK}`,
                        '',
                        'Compare them. Report style drift (flat 2D becoming photorealistic,',
                        'gradients or texture appearing, outlines thinning or vanishing,',
                        'palette warming or saturating), and any object or body part that',
                        'changed shape when it should have stayed still — a hand closing, a',
                        'face turning toward camera, geometry morphing.',
                        '',
                        'Reply with ONLY a JSON object, no prose and no code fences:',
                        '{ "drift": <boolean>, "summary": "<one or two sentences>",',
                        '  "verdict": "accept" | "regenerate" }',
                    ].join('\n'),
                },
            ],
            400,
        );
        const parsed = parseJson<Record<string, unknown>>(raw);
        if (!parsed) return { error: `unparseable drift report: ${raw.slice(0, 120)}` };

        const drift = parsed.drift === true;
        return {
            drift,
            summary:
                typeof parsed.summary === 'string' && parsed.summary.trim()
                    ? parsed.summary.trim()
                    : 'No summary given.',
            verdict: drift || parsed.verdict !== 'accept' ? 'regenerate' : 'accept',
        };
    } catch (err) {
        log.warn('drift critique failed', { error: errorMessage(err) });
        return { error: errorMessage(err) };
    }
}
