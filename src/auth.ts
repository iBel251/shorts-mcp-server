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
function presentedSecret(req: Request, headerName: string): string | undefined {
    const direct = req.headers[headerName];
    if (typeof direct === 'string' && direct.length > 0) return direct;
    if (Array.isArray(direct) && direct[0]) return direct[0];

    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
        return auth.replace(/^bearer\s+/i, '').trim();
    }
    return undefined;
}

export function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
    const cfg = getConfig();
    const presented = presentedSecret(req, cfg.authHeader);

    if (!presented || !constantTimeEquals(presented, cfg.sharedSecret)) {
        log.warn('rejected unauthenticated request', {
            method: req.method,
            path: req.path,
            hadHeader: Boolean(presented),
        });
        res.status(401)
            .set('WWW-Authenticate', `Bearer realm="shorts-mcp"`)
            .json({
                jsonrpc: '2.0',
                error: { code: -32001, message: 'Unauthorized' },
                id: null,
            });
        return;
    }
    next();
}
