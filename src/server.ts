import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { apiRoutes } from './api.js';
import { registerApps } from './apps.js';
import { requirePathSecret, requireSharedSecret } from './auth.js';
import { errorMessage, log } from './logger.js';
import { registerTools } from './tools.js';
import { STUDIO_HTML } from './ui.generated.js';

/**
 * Streamable HTTP transport, served at the root path.
 *
 * Only Streamable HTTP is implemented — Claude also speaks legacy HTTP+SSE but
 * that transport is being deprecated, so there is no /sse endpoint here by
 * design.
 */

/** One transport per session; a fresh McpServer is bound to each. */
const transports = new Map<string, StreamableHTTPServerTransport>();

function buildMcpServer(): McpServer {
    const server = new McpServer(
        { name: 'shorts-pipeline', version: '1.0.0' },
        {
            instructions:
                'Generates stylized dark editorial-cartoon animated vertical shorts via the xAI Imagine API.\n\n' +
                'Pipeline: generate_still → approve_still → animate → check_job. ' +
                'For externally generated images, use import_image → approve_still → ' +
                'animate → check_job. ' +
                'To replace a bad externally generated scene still, call import_image with ' +
                'the existing shot_id, then approve_still on the returned replacement asset_id. ' +
                'For story projects, save_story_manifest and import_reference_image first, ' +
                'then use get_story_manifest to retrieve reference asset ids for scenes. ' +
                'Use list_shots to resume a project cold.\n\n' +
                'The base visual style is locked server-side and is applied to every prompt ' +
                'automatically. Keep shot_description focused on subject, action and setting. ' +
                'Keep motion_instruction focused on one camera move, one restrained subject ' +
                'action, subtle background motion, preserving the original composition and ' +
                'character design, and preventing morphing. Use palette_override only for ' +
                'per-beat colour shifts.\n\n' +
                'For multi-scene shorts, submit every approved scene image to animate first ' +
                'so each clip gets its own player card, then poll check_job for completion. ' +
                'Do not run a first-frame/last-frame approval pass unless the user asks for ' +
                'diagnostics; let the user review the finished video widgets and name any ' +
                'bad scenes to regenerate.',
        },
    );
    registerTools(server);
    registerApps(server);
    return server;
}

/** The MCP endpoint itself, mountable at more than one path. */
function mcpRoutes(): express.Router {
    const router = express.Router();

    // Protocol discovery. Claude probes with HEAD before connecting, and it
    // must answer without a session or a body.
    router.head('/', (_req: Request, res: Response) => {
        res.status(200).set('Content-Type', 'application/json').end();
    });
    router.post('/', handlePost);
    router.get('/', handleSessionRequest);
    router.delete('/', handleSessionRequest);

    return router;
}

export function createApp(): express.Express {
    const app = express();
    app.disable('x-powered-by');

    // Unauthenticated liveness probe for the host's health checks. Registered
    // before the gated mounts so it stays reachable.
    app.get('/healthz', (_req: Request, res: Response) => {
        res.json({ ok: true, sessions: transports.size });
    });

    // OAuth discovery must 404, and must do so *before* the auth middleware.
    //
    // Claude probes /.well-known/oauth-protected-resource (and friends) before
    // connecting. Letting those fall through to the gated mounts returned 401,
    // which Claude reads as "this resource is OAuth-protected" — so it tries to
    // dynamically register a client, fails, and reports "couldn't register with
    // the sign-in service". A 404 is how a server says it has no OAuth, which
    // sends Claude straight to the shared-secret path instead.
    app.use((req: Request, res: Response, next) => {
        if (req.path.startsWith('/.well-known/')) {
            res.status(404).json({
                error: 'not_found',
                message: 'This server does not use OAuth. Authenticate with the shared secret.',
            });
            return;
        }
        next();
    });

    // The studio shell. Deliberately ungated: it is a static document with no
    // project data in it, and it cannot read any until the person using it
    // supplies the shared secret, which it then sends as x-api-key on every
    // /api call. Putting auth in front of the HTML instead would mean a browser
    // basic-auth prompt or a secret in the URL bar, and neither is better than
    // a page that asks once and holds the key client-side.
    app.get(['/studio', '/studio/'], (_req: Request, res: Response) => {
        res.type('html').send(STUDIO_HTML);
    });

    // The studio's data plane, gated by the same shared secret as MCP.
    //
    // Its own body parser, with a much larger limit: reference plates and
    // imported stills arrive as base64, and 20MB of image is ~27MB of JSON.
    // Scoping it here keeps the MCP endpoint's 4MB ceiling intact.
    app.use('/api', requireSharedSecret, express.json({ limit: '32mb' }), apiRoutes());

    // Two ways in, same endpoint, both gated:
    //
    //   /<secret>  — credential in the URL, for claude.ai connectors, which
    //                cannot set request headers unless the beta is enabled.
    //   /          — credential in a header, for Claude Code and anything else
    //                that can set one.
    //
    // Auth is middleware either way, so tool logic never sees an
    // unauthenticated request and swapping in OAuth touches only auth.ts.
    //
    // These are last because `/:token` matches any single path segment and
    // would otherwise swallow /studio and /api.
    const mcpJson = express.json({ limit: '4mb' });
    app.use('/:token', requirePathSecret, mcpJson, mcpRoutes());
    app.use('/', requireSharedSecret, mcpJson, mcpRoutes());

    return app;
}

async function handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.header('mcp-session-id') ?? undefined;

    try {
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
            if (sessionId) {
                // Known-unknown session: the client is holding an id we lost
                // (e.g. across a restart). 404 tells it to re-initialize.
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: { code: -32001, message: 'Session not found — reinitialize' },
                    id: null,
                });
                return;
            }
            if (!isInitializeRequest(req.body)) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: no session id and not an initialize request',
                    },
                    id: null,
                });
                return;
            }

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id: string) => {
                    transports.set(id, transport!);
                    log.info('mcp session opened', { sessionId: id, sessions: transports.size });
                },
            });

            transport.onclose = () => {
                const id = transport?.sessionId;
                if (id) {
                    transports.delete(id);
                    log.info('mcp session closed', { sessionId: id, sessions: transports.size });
                }
            };

            await buildMcpServer().connect(transport);
        }

        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        log.error('mcp post failed', { error: errorMessage(err) });
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    }
}

/** GET opens the server→client notification stream; DELETE ends the session. */
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.header('mcp-session-id');
    const transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Missing or unknown session id' },
            id: null,
        });
        return;
    }

    try {
        await transport.handleRequest(req, res);
    } catch (err) {
        log.error('mcp session request failed', { error: errorMessage(err) });
        if (!res.headersSent) res.status(500).end();
    }
}

export async function closeAllSessions(): Promise<void> {
    await Promise.allSettled([...transports.values()].map((t) => t.close()));
    transports.clear();
}
