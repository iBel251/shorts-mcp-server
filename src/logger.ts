/**
 * Logger that scrubs secrets before anything reaches stdout.
 *
 * Acceptance criterion: the xAI key must appear nowhere in any log line or
 * tool response. Rather than trusting every call site to remember that, every
 * message is run through `redact` on the way out. Secrets are read lazily so
 * this module stays importable before config validation runs.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let secrets: string[] | undefined;

function getSecrets(): string[] {
    if (!secrets) {
        secrets = [
            process.env.XAI_API_KEY,
            process.env.SUPABASE_SERVICE_KEY,
            process.env.SHORTS_SHARED_SECRET,
        ].filter((s): s is string => Boolean(s && s.trim().length >= 8));
    }
    return secrets;
}

/** Call after env changes (tests) to rebuild the secret list. */
export function resetRedactionCache(): void {
    secrets = undefined;
}

/**
 * Replace any known secret with `[redacted]`, plus a belt-and-braces pass for
 * bearer tokens and xAI-shaped keys that might arrive from an error payload we
 * did not construct.
 */
export function redact(input: string): string {
    let out = input;
    for (const secret of getSecrets()) {
        out = out.split(secret).join('[redacted]');
    }
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[redacted]');
    out = out.replace(/\bxai-[A-Za-z0-9]{8,}\b/g, '[redacted]');
    return out;
}

/** Deep-redact an arbitrary value by round-tripping through JSON. */
export function redactValue<T>(value: T): T {
    try {
        return JSON.parse(redact(JSON.stringify(value ?? null))) as T;
    } catch {
        return value;
    }
}

function threshold(): number {
    const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
    return LEVELS[configured] ?? LEVELS.info;
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold()) return;
    const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        msg: message,
    };
    if (context && Object.keys(context).length > 0) line.ctx = context;

    let serialized: string;
    try {
        serialized = JSON.stringify(line);
    } catch {
        serialized = JSON.stringify({ ts: line.ts, level, msg: message, ctx: '[unserializable]' });
    }
    // Logs go to stderr so they can never corrupt an stdio-style JSON stream.
    process.stderr.write(`${redact(serialized)}\n`);
}

export const log = {
    debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
    info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
    warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
    error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
};

/** Turn an unknown thrown value into a redacted, client-safe message. */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) return redact(err.message);
    if (typeof err === 'string') return redact(err);
    try {
        return redact(JSON.stringify(err));
    } catch {
        return 'Unknown error';
    }
}
