import { getConfig } from './config.js';
import { redact } from './logger.js';

/**
 * Low-level xAI chat/completions call.
 *
 * Split out of vision.ts because two callers now need it: the vision critique
 * that judges a generated image, and the studio's story assistant that pitches
 * hooks and breaks a story into beats. Both want the same redaction and timeout
 * behaviour, and neither should be re-implementing the request.
 *
 * As in xai.ts, the API key is injected here and error bodies are redacted
 * before they can propagate — an upstream error that echoes our own
 * Authorization header must not reach a client.
 */

interface ChatResponse {
    choices?: Array<{ message?: { content?: string } }>;
}

export interface ChatOptions {
    /** Defaults to VISION_MODEL. */
    model?: string;
    maxTokens: number;
    /** Deterministic by default — both callers want repeatable structure. */
    temperature?: number;
    timeoutMs?: number;
}

/** Send one user turn (text and/or image parts) and return the reply text. */
export async function chatText(content: unknown[], options: ChatOptions): Promise<string> {
    const cfg = getConfig();
    const res = await fetch(`${cfg.xaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.xaiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: options.model ?? cfg.visionModel,
            messages: [{ role: 'user', content }],
            max_tokens: options.maxTokens,
            temperature: options.temperature ?? 0,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });

    if (!res.ok) {
        throw new Error(
            `chat ${res.status}: ${redact(await res.text().catch(() => '')).slice(0, 200)}`,
        );
    }
    const body = (await res.json()) as ChatResponse;
    return body.choices?.[0]?.message?.content?.trim() ?? '';
}

/**
 * Pull a JSON value out of a reply.
 *
 * Models wrap JSON in fences or prose despite instructions, so scanning for
 * the outermost braces or brackets is more reliable than trusting the shape.
 */
export function parseJson<T>(raw: string): T | undefined {
    const cleaned = raw
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
    const candidates: Array<[number, number]> = [
        [cleaned.indexOf('{'), cleaned.lastIndexOf('}')],
        [cleaned.indexOf('['), cleaned.lastIndexOf(']')],
    ];
    for (const [start, end] of candidates) {
        if (start === -1 || end <= start) continue;
        try {
            return JSON.parse(cleaned.slice(start, end + 1)) as T;
        } catch {
            // Try the other bracket style before giving up.
        }
    }
    return undefined;
}
