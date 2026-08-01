import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getConfig } from './config.js';
import { log } from './logger.js';

/**
 * Static shared-secret auth.
 *
 * Full OAuth with Dynamic Client Registration is overkill for a single-user
 * service with no per-user data, but an unauthenticated public URL lets anyone
 * burn the owner's xAI credits. So: one header, checked against an env var,
 * 401 otherwise.
 *
 * This is deliberately isolated as middleware — swapping it for OAuth later
 * should not touch a single line of tool logic.
 */

function constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    // timingSafeEqual throws on length mismatch, which would itself leak length.
    if (bufA.length !== bufB.length) {
        timingSafeEqual(bufA, bufA);
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}

/** Pull the secret from the configured header, or from `Authorization: Bearer`. */
function headerValue(req: Request, name: string): string | undefined {
    const raw = req.headers[name];
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (Array.isArray(raw) && raw[0]) return raw[0];
    return undefined;
}

/**
 * Pull the secret out of whichever header the client could actually send.
 *
 * claude.ai restricts connector headers to an allowlist — `authorization`,
 * `x-api-key`, `x-auth-token` — so a bespoke name like `x-shorts-key` can never
 * arrive from a claude.ai connector no matter how it is configured. All the
 * allowlisted names are accepted here, plus whatever `AUTH_HEADER` is set to,
 * so Claude Code and other clients keep working too.
 */
function presentedSecret(req: Request, headerName: string): string | undefined {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.length > 0) {
        // Claude sends the value verbatim, so accept it with or without scheme.
        return /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : auth.trim();
    }
    for (const name of [headerName, 'x-api-key', 'x-auth-token']) {
        const value = headerValue(req, name);
        if (value) return value;
    }
    return undefined;
}

function reject(req: Request, res: Response, hadCredential: boolean): void {
    // Deliberately not logging the path: on the token-in-URL route it would
    // record the presented credential.
    log.warn('rejected unauthenticated request', {
        method: req.method,
        hadCredential,
    });
    // Note the absence of a WWW-Authenticate header. Under the MCP spec a 401
    // carrying one signals "this server does OAuth", and Claude responds by
    // trying to dynamically register a client — which fails with a confusing
    // "couldn't register with the sign-in service" message that sends you
    // hunting for an OAuth Client ID you do not need. Omitting it makes a bad
    // credential read as exactly what it is.
    res.status(401).json({
        jsonrpc: '2.0',
        error: {
            code: -32001,
            message:
                'Unauthorized. This server uses a shared secret, not OAuth. ' +
                'Use https://<host>/<SHORTS_SHARED_SECRET> as the connector URL, ' +
                'or send the secret in an x-api-key header.',
        },
        id: null,
    });
}

export function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
    const cfg = getConfig();
    const presented = presentedSecret(req, cfg.authHeader);

    if (!presented || !constantTimeEquals(presented, cfg.sharedSecret)) {
        reject(req, res, Boolean(presented));
        return;
    }
    next();
}

/**
 * Secret-in-the-URL auth, for clients that cannot set a header at all.
 *
 * claude.ai's request-header support is still a gated beta, so on most accounts
 * the connector dialog offers nothing but OAuth fields. A capability URL is the
 * remaining option: the credential is an unguessable path segment, which is as
 * strong as a bearer token over HTTPS since the path is inside the TLS session.
 *
 * The tradeoff is that URLs are logged more casually than headers — the host's
 * access logs will contain it. Our own logger redacts it (see logger.ts), but
 * treat the full URL as the secret it is, and rotate SHORTS_SHARED_SECRET if it
 * is ever pasted somewhere public.
 */
export function requirePathSecret(req: Request, res: Response, next: NextFunction): void {
    const cfg = getConfig();
    const token =
        (req.params as Record<string, string | undefined>).token ??
        // Fallback for mounts where the param is not merged in.
        req.baseUrl.split('/').filter(Boolean).pop();

    if (!token || !constantTimeEquals(token, cfg.sharedSecret)) {
        reject(req, res, Boolean(token));
        return;
    }
    next();
}
