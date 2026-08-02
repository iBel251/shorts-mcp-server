import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GALLERY_URI, PLAYER_URI, uiMeta } from './apps.js';
import { critiqueDrift, critiqueStill } from './vision.js';
import { makeContactSheet, makePreview } from './frames.js';
import { downloadWithRetry } from './storage.js';
import {
    buildPrompt,
    getConfig,
    DEFAULT_DURATION,
    DEFAULT_STILL_COUNT,
    MAX_DURATION,
    MAX_REFERENCE_IMAGES,
    MAX_STILL_COUNT,
    MIN_DURATION,
} from './config.js';
import {
    approveStillExclusively,
    createReferenceAsset,
    createAsset,
    createJob,
    createShot,
    getAsset,
    getJob,
    getOrCreateDefaultProject,
    getOrCreateProjectByName,
    getProject,
    getStoryManifest,
    listAssetsByIds,
    listProjects,
    getShot,
    latestJobsForShots,
    listAssetsForShots,
    listReferenceAssets,
    listShots,
    nextShotNumber,
    saveStoryManifest,
    setShotStatus,
    type AssetRow,
    type JobRow,
    type ReferenceAssetRow,
} from './db.js';
import { errorMessage, log } from './logger.js';
import { assetPath, persistFromUrl, putBuffer } from './storage.js';
import { advanceJobById } from './worker.js';
import { editImage, generateImage, submitVideo } from './xai.js';

/**
 * The core generation surface is deliberately small.
 *
 * Note what is absent: there is no `style` parameter anywhere. Style is a
 * server-owned constant (see config.ts) so it cannot be forgotten or
 * overridden. `palette_override` is the only prompt lever exposed, because
 * palette shifts per story beat while the base style never does.
 */

type ContentBlock = CallToolResult['content'][number];

const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const REFERENCE_ROLES = [
    'character',
    'character_turnaround',
    'expression_sheet',
    'prop',
    'location',
    'style',
    'other',
] as const;

// Structured JSON in `content` as well as `structuredContent`, since clients
// vary in which they surface to the model.
function ok(payload: unknown, images: ContentBlock[] = []): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }, ...images],
        structuredContent: payload as Record<string, unknown>,
    };
}

/**
 * Previews are keyed by URL and immutable once generated, so a small cache
 * spares us re-downloading and re-encoding on every repeat poll of a finished
 * job. Bounded because these are ~60kB each.
 */
const previewCache = new Map<string, { data: string; mimeType: string }>();
const PREVIEW_CACHE_MAX = 32;

/**
 * Turn a stored image URL into an actual MCP image block.
 *
 * Returning only URLs made the whole first/last-frame feature inert: Claude
 * cannot open arbitrary links, so the frames arrived as text it could not look
 * at and the drift check still needed a human to screenshot. Image content
 * blocks put the pixels in front of the model directly. The URL is still
 * returned alongside — it is the full-resolution PNG, and useful to a human.
 */
async function imageBlocks(url: string | undefined, label: string): Promise<ContentBlock[]> {
    if (!url) return [];
    try {
        let preview = previewCache.get(url);
        if (!preview) {
            const original = await downloadWithRetry(url, 2);
            const scaled = await makePreview(original);
            preview = {
                data: Buffer.from(scaled.data).toString('base64'),
                mimeType: scaled.mimeType,
            };
            if (previewCache.size >= PREVIEW_CACHE_MAX) {
                const oldest = previewCache.keys().next().value;
                if (oldest) previewCache.delete(oldest);
            }
            previewCache.set(url, preview);
        }
        return [
            { type: 'text', text: label },
            { type: 'image', data: preview.data, mimeType: preview.mimeType },
        ];
    } catch (err) {
        // A failed preview must never fail the tool — the URLs are still valid.
        log.warn('preview generation failed', { error: errorMessage(err) });
        return [{ type: 'text', text: `${label} — preview unavailable, use the URL` }];
    }
}

/**
 * One image block containing every variation tiled side by side.
 *
 * Costs a single image slot no matter how many variations there are, which
 * matters if the host limits images per conversation. Falls back to text on
 * failure — the URLs in the payload remain valid either way.
 */
async function contactSheetBlocks(urls: string[], label: string): Promise<ContentBlock[]> {
    const key = `sheet:${urls.join('|')}`;
    try {
        let preview = previewCache.get(key);
        if (!preview) {
            const originals = await Promise.all(urls.map((u) => downloadWithRetry(u, 2)));
            const sheet = await makeContactSheet(originals);
            preview = {
                data: Buffer.from(sheet.data).toString('base64'),
                mimeType: sheet.mimeType,
            };
            if (previewCache.size >= PREVIEW_CACHE_MAX) {
                const oldest = previewCache.keys().next().value;
                if (oldest) previewCache.delete(oldest);
            }
            previewCache.set(key, preview);
        }
        return [
            { type: 'text', text: label },
            { type: 'image', data: preview.data, mimeType: preview.mimeType },
        ];
    } catch (err) {
        log.warn('contact sheet failed', { error: errorMessage(err) });
        return [{ type: 'text', text: `${label} — preview unavailable, use the URLs` }];
    }
}

function fail(message: string): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
    };
}

/** Wrap a handler so an unexpected throw becomes a redacted tool error. */
function guard<T extends unknown[]>(
    name: string,
    handler: (...args: T) => Promise<CallToolResult>,
): (...args: T) => Promise<CallToolResult> {
    return async (...args: T) => {
        const started = Date.now();
        try {
            const result = await handler(...args);
            log.info('tool ok', { tool: name, ms: Date.now() - started });
            return result;
        } catch (err) {
            const message = errorMessage(err);
            log.error('tool failed', { tool: name, ms: Date.now() - started, error: message });
            return fail(message);
        }
    };
}

function extOf(url: string, fallback: string): string {
    const match = /\.([a-z0-9]{3,4})(?:\?|#|$)/i.exec(url);
    return match?.[1]?.toLowerCase() ?? fallback;
}

function isPrivateIp(address: string): boolean {
    const version = isIP(address);
    if (version === 4) {
        const parts = address.split('.').map(Number);
        const [a, b] = parts;
        return (
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            address === '0.0.0.0'
        );
    }
    if (version === 6) {
        const lower = address.toLowerCase();
        return (
            lower === '::1' ||
            lower === '::' ||
            lower.startsWith('fc') ||
            lower.startsWith('fd') ||
            lower.startsWith('fe80:') ||
            lower.startsWith('::ffff:10.') ||
            lower.startsWith('::ffff:127.') ||
            lower.startsWith('::ffff:192.168.')
        );
    }
    return false;
}

async function assertPublicImageUrl(url: URL): Promise<void> {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('image_url must be http or https');
    }
    if (url.username || url.password) {
        throw new Error('image_url must not include credentials');
    }

    const host = url.hostname.toLowerCase();
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === 'metadata.google.internal'
    ) {
        throw new Error('image_url must be publicly reachable, not localhost or metadata');
    }
    if (isIP(host) && isPrivateIp(host)) {
        throw new Error('image_url must not point at a private or loopback address');
    }

    // Hostnames can resolve to private addresses even when they look public.
    const addresses = await lookup(host, { all: true }).catch((err) => {
        throw new Error(`Could not resolve image_url host: ${errorMessage(err)}`);
    });
    if (addresses.some((a) => isPrivateIp(a.address))) {
        throw new Error('image_url resolved to a private or loopback address');
    }
}

async function downloadImportUrl(source: string): Promise<{
    bytes: Uint8Array;
    contentType?: string;
    finalUrl: string;
}> {
    let url = new URL(source);
    for (let redirect = 0; redirect <= 5; redirect++) {
        await assertPublicImageUrl(url);
        const res = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(120_000),
        });

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) throw new Error(`image_url redirected with no Location header`);
            url = new URL(location, url);
            continue;
        }
        if (!res.ok) {
            throw new Error(`Download image_url failed with HTTP ${res.status} ${res.statusText}`);
        }

        const length = Number(res.headers.get('content-length'));
        if (Number.isFinite(length) && length > IMPORT_MAX_BYTES) {
            throw new Error(`Imported image is larger than ${IMPORT_MAX_BYTES} bytes`);
        }

        const body = new Uint8Array(await res.arrayBuffer());
        if (body.byteLength > IMPORT_MAX_BYTES) {
            throw new Error(`Imported image is larger than ${IMPORT_MAX_BYTES} bytes`);
        }
        return {
            bytes: body,
            contentType: res.headers.get('content-type')?.split(';')[0]?.toLowerCase(),
            finalUrl: url.toString(),
        };
    }
    throw new Error('image_url redirected too many times');
}

function parseBase64Image(raw: string): { bytes: Uint8Array; contentType?: string } {
    const trimmed = raw.trim();
    const match = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
    const contentType = match?.[1]?.toLowerCase();
    const encoded = (match?.[2] ?? trimmed).replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length === 0) {
        throw new Error('image_base64 must contain valid base64 image data');
    }
    const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (bytes.byteLength > IMPORT_MAX_BYTES) {
        throw new Error(`Imported image is larger than ${IMPORT_MAX_BYTES} bytes`);
    }
    return { bytes, contentType };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    let i = 2;
    while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = bytes[i + 1]!;
        const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
        if (length < 2) return undefined;
        if (
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)
        ) {
            return {
                height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
                width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
            };
        }
        i += 2 + length;
    }
    return undefined;
}

function u24le(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function inspectImage(bytes: Uint8Array, declared?: string): {
    mimeType: string;
    ext: 'png' | 'jpg' | 'webp';
    width?: number;
    height?: number;
} {
    if (bytes.byteLength < 12) throw new Error('Imported image is empty or truncated');

    if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[12] === 0x49 &&
        bytes[13] === 0x48 &&
        bytes[14] === 0x44 &&
        bytes[15] === 0x52
    ) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
            mimeType: 'image/png',
            ext: 'png',
            width: view.getUint32(16),
            height: view.getUint32(20),
        };
    }

    const jpg = jpegSize(bytes);
    if (jpg) return { mimeType: 'image/jpeg', ext: 'jpg', ...jpg };

    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') {
        const chunk = String.fromCharCode(...bytes.slice(12, 16));
        if (chunk === 'VP8X' && bytes.length >= 30) {
            return {
                mimeType: 'image/webp',
                ext: 'webp',
                width: u24le(bytes, 24) + 1,
                height: u24le(bytes, 27) + 1,
            };
        }
        return { mimeType: 'image/webp', ext: 'webp' };
    }

    throw new Error(
        `Imported image must be PNG, JPEG or WebP${
            declared ? `; received ${declared}` : ''
        }`,
    );
}

type ImportArgs = {
    image_url?: string | undefined;
    image_base64?: string | undefined;
    image_file?: { data: string; mime_type?: string | undefined; filename?: string | undefined };
};

async function loadImportedImage(args: ImportArgs): Promise<{
    bytes: Uint8Array;
    contentType?: string;
    source?: string;
    image: ReturnType<typeof inspectImage>;
}> {
    const sourceCount = [
        Boolean(args.image_url),
        Boolean(args.image_base64),
        Boolean(args.image_file?.data),
    ].filter(Boolean).length;
    if (sourceCount !== 1) {
        throw new Error('Provide exactly one of image_url, image_base64, or image_file.data.');
    }

    let imported: { bytes: Uint8Array; contentType?: string; source?: string };
    if (args.image_url) {
        const downloaded = await downloadImportUrl(args.image_url);
        imported = {
            bytes: downloaded.bytes,
            contentType: downloaded.contentType,
            source: downloaded.finalUrl,
        };
    } else if (args.image_file?.data) {
        const parsed = parseBase64Image(args.image_file.data);
        imported = {
            bytes: parsed.bytes,
            contentType: args.image_file.mime_type?.toLowerCase() ?? parsed.contentType,
            source: args.image_file.filename,
        };
    } else {
        const parsed = parseBase64Image(args.image_base64!);
        imported = {
            bytes: parsed.bytes,
            contentType: parsed.contentType,
        };
    }

    return {
        ...imported,
        image: inspectImage(imported.bytes, imported.contentType),
    };
}

async function resolveProjectId(args: {
    project_id?: string | undefined;
    project_name?: string | undefined;
}): Promise<string | undefined> {
    if (args.project_id) {
        const project = await getProject(args.project_id);
        if (!project) return undefined;
        return args.project_id;
    }
    if (args.project_name) return (await getOrCreateProjectByName(args.project_name)).id;
    return (await getOrCreateDefaultProject()).id;
}

async function importStillAsset(input: {
    projectId: string;
    shotId?: string | undefined;
    shotNumber?: number | undefined;
    description: string;
    imported: Awaited<ReturnType<typeof loadImportedImage>>;
}): Promise<{
    asset: AssetRow;
    shotId: string;
    shotNumber: number;
    publicUrl: string;
    width?: number;
    height?: number;
    mimeType: string;
    source?: string;
}> {
    const shot = input.shotId
        ? await getShot(input.shotId)
        : await createShot({
              projectId: input.projectId,
              shotNumber: input.shotNumber ?? (await nextShotNumber(input.projectId)),
              description: input.description,
          });
    if (!shot) throw new Error(`No shot with id ${input.shotId}`);
    if (shot.project_id !== input.projectId) {
        throw new Error(`Shot ${shot.id} does not belong to project ${input.projectId}`);
    }

    const id = randomUUID();
    const stored = await putBuffer(
        assetPath(shot.id, 'still', id, input.imported.image.ext),
        input.imported.bytes,
        input.imported.image.mimeType,
    );
    const asset = await createAsset({
        shotId: shot.id,
        kind: 'still',
        storagePath: stored.storagePath,
        publicUrl: stored.publicUrl,
    });
    await setShotStatus(shot.id, 'still_ready');

    return {
        asset,
        shotId: shot.id,
        shotNumber: shot.shot_number,
        publicUrl: asset.public_url,
        width: input.imported.image.width,
        height: input.imported.image.height,
        mimeType: input.imported.image.mimeType,
        source: input.imported.source,
    };
}

async function referenceRowsWithUrls(refs: ReferenceAssetRow[]): Promise<Array<Record<string, unknown>>> {
    const assets = await listAssetsByIds(refs.map((r) => r.asset_id));
    const byId = new Map(assets.map((a) => [a.id, a]));
    return refs.map((ref) => {
        const asset = byId.get(ref.asset_id);
        return {
            reference_id: ref.id,
            asset_id: ref.asset_id,
            role: ref.role,
            label: ref.label,
            notes: ref.notes,
            metadata: ref.metadata,
            url: asset?.public_url,
            shot_id: asset?.shot_id,
            created_at: ref.created_at,
        };
    });
}

export function registerTools(server: McpServer): void {
    // ------------------------------------------------------------ generate_still

    server.registerTool(
        'generate_still',
        {
            title: 'Generate still variations',
            description:
                'Generate still-image variations for a shot in the locked flat 2D style. ' +
                'The style is applied server-side and cannot be overridden — use ' +
                'palette_override only for per-beat colour shifts. All variations are ' +
                'persisted to permanent storage before this returns and come back as ' +
                'viewable images. Pick one with approve_still.\n\n' +
                'For any shot that reuses a character, location or prop from an earlier ' +
                'shot, pass that shot\'s approved still in reference_asset_ids. Without a ' +
                'reference each shot is an independent roll and the character will drift.',
            // Renders the variations inline in chat for the user; the image
            // blocks in the result remain what the model sees.
            _meta: uiMeta(GALLERY_URI),
            inputSchema: {
                shot_description: z
                    .string()
                    .min(1)
                    .describe('What the shot depicts. Do not include style instructions.'),
                project_id: z
                    .string()
                    .optional()
                    .describe('Existing project id. A default project is used if omitted.'),
                project_name: z
                    .string()
                    .optional()
                    .describe(
                        'Name of a project to use, created if it does not exist. Ignored when ' +
                        'project_id is given. Use this to keep separate shorts apart.',
                    ),
                shot_number: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Shot number within the project. Auto-assigned if omitted.'),
                palette_override: z
                    .string()
                    .optional()
                    .describe('Palette shift for this beat, e.g. "deep red palette".'),
                count: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_STILL_COUNT)
                    .optional()
                    .describe(`Number of variations, default ${DEFAULT_STILL_COUNT}.`),
                include_images: z
                    .boolean()
                    .optional()
                    .describe('Embed the variations as images. Default true; false saves tokens.'),
                critique: z
                    .boolean()
                    .optional()
                    .describe(
                        'Run a server-side vision pass over each variation and return the ' +
                        'judgements as text. Default true. This is what lets you accept or ' +
                        'reject when embedded images do not reach you.',
                    ),
                image_mode: z
                    .enum(['sheet', 'individual'])
                    .optional()
                    .describe(
                        'How to embed the variations. "sheet" (default) tiles them into one ' +
                        'image, costing a single image slot. "individual" sends one image per ' +
                        'variation, which some hosts cap per conversation.',
                    ),
                reference_asset_ids: z
                    .array(z.string())
                    .max(MAX_REFERENCE_IMAGES)
                    .optional()
                    .describe(
                        `Up to ${MAX_REFERENCE_IMAGES} asset_ids from earlier shots to use as ` +
                        'visual references. Use this to keep a character consistent across ' +
                        'shots: pass the approved still that established them. Accepts stills ' +
                        'and extracted video frames.',
                    ),
            },
        },
        guard('generate_still', async (args) => {
            const count = args.count ?? DEFAULT_STILL_COUNT;

            let projectId = args.project_id;
            if (projectId) {
                const project = await getProject(projectId);
                if (!project) return fail(`No project with id ${projectId}`);
            } else if (args.project_name) {
                projectId = (await getOrCreateProjectByName(args.project_name)).id;
            } else {
                projectId = (await getOrCreateDefaultProject()).id;
            }

            // Resolve references before creating the shot, so a bad id fails
            // cleanly instead of leaving an empty shot behind.
            const referenceIds = args.reference_asset_ids ?? [];
            const referenceUrls: string[] = [];
            for (const id of referenceIds) {
                const asset = await getAsset(id);
                if (!asset) return fail(`No asset with id ${id} to use as a reference`);
                if (asset.kind === 'video') {
                    return fail(
                        `Asset ${id} is a video and cannot be a reference. Use its ` +
                            'first_frame or last_frame asset instead.',
                    );
                }
                // Our own storage URL — never an expiring upstream one.
                referenceUrls.push(asset.public_url);
            }

            const shotNumber = args.shot_number ?? (await nextShotNumber(projectId));
            const shot = await createShot({
                projectId,
                shotNumber,
                description: args.shot_description,
            });

            const prompt = buildPrompt({
                shotDescription: args.shot_description,
                paletteOverride: args.palette_override,
                hasReferences: referenceUrls.length > 0,
            });

            // Generate in parallel, but tolerate partial failure — some stills
            // beat none, and the caller is told how many landed.
            const results = await Promise.allSettled(
                Array.from({ length: count }, async () => {
                    const upstreamUrl =
                        referenceUrls.length > 0
                            ? await editImage(prompt, referenceUrls)
                            : await generateImage(prompt);
                    const id = randomUUID();
                    const stored = await persistFromUrl(
                        upstreamUrl,
                        assetPath(shot.id, 'still', id, extOf(upstreamUrl, 'png')),
                    );
                    return createAsset({
                        shotId: shot.id,
                        kind: 'still',
                        storagePath: stored.storagePath,
                        publicUrl: stored.publicUrl,
                    });
                }),
            );

            const stills = results
                .filter((r): r is PromiseFulfilledResult<AssetRow> => r.status === 'fulfilled')
                .map((r) => ({ asset_id: r.value.id, url: r.value.public_url }));
            const failures = results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map((r) => errorMessage(r.reason));

            if (stills.length === 0) {
                await setShotStatus(shot.id, 'failed');
                return fail(`All ${count} image generations failed: ${failures[0] ?? 'unknown'}`);
            }

            await setShotStatus(shot.id, 'still_ready');

            // Server-side vision pass. Text survives where image blocks do not,
            // so this is what keeps the model able to accept or reject when it
            // cannot see the picture. Runs in parallel with itself, not before
            // the images — a critique failure must never fail the tool.
            let critiques: Array<Record<string, unknown>> | undefined;
            if (getConfig().enableVisionCritique && args.critique !== false) {
                critiques = await Promise.all(
                    stills.map(async (still, index) => ({
                        variation: index + 1,
                        asset_id: still.asset_id,
                        ...(await critiqueStill(
                            still.url,
                            args.shot_description,
                            args.palette_override,
                        )),
                    })),
                );
            }

            // Same reasoning as check_job: a variation the model cannot see is
            // a variation it cannot choose between.
            //
            // One contact sheet by default rather than one block per variation.
            // Four blocks is the greediest possible shape against any host cap
            // on images per conversation, and a single call could exhaust it.
            const images: ContentBlock[] = [];
            if (args.include_images !== false) {
                const mode = args.image_mode ?? 'sheet';
                if (mode === 'sheet' && stills.length > 1) {
                    images.push(
                        ...(await contactSheetBlocks(
                            stills.map((s) => s.url),
                            `Variations left to right: ${stills
                                .map((s, i) => `${i + 1}=${s.asset_id}`)
                                .join(', ')}`,
                        )),
                    );
                } else {
                    for (const [index, still] of stills.entries()) {
                        images.push(
                            ...(await imageBlocks(
                                still.url,
                                `Variation ${index + 1} — asset_id ${still.asset_id}`,
                            )),
                        );
                    }
                }
            }

            return ok(
                {
                    shot_id: shot.id,
                    project_id: projectId,
                    shot_number: shot.shot_number,
                    stills,
                    ...(critiques ? { critiques } : {}),
                    hint:
                        'The images below are the variations, in order. Judge them on style ' +
                        'fidelity (flat 2D, even outlines, no photorealism) and composition, ' +
                        'then call approve_still with the chosen asset_id.' +
                        (critiques
                            ? ' If the images did not reach you, use `critiques` — a ' +
                              'server-side vision pass over each variation. It is a ' +
                              'description, not the picture, so say so if you rely on it; ' +
                              'each entry carries a verdict and a fix_suggestion for ' +
                              'regenerating.'
                            : ''),
                    ...(failures.length > 0
                        ? { warning: `${failures.length} of ${count} generations failed`, failures }
                        : {}),
                },
                images,
            );
        }),
    );

    // --------------------------------------------------------------- import_image

    server.registerTool(
        'import_image',
        {
            title: 'Import an external still',
            description:
                'Import an externally generated image as a still asset that can be ' +
                'approved and animated. Use this when an image was created outside this ' +
                'server, such as ChatGPT image generation. Provide exactly one of ' +
                'image_url, image_base64, or image_file.data. The server validates PNG, ' +
                'JPEG, or WebP bytes, persists them to Storage, creates or reuses a shot, and ' +
                'returns an asset_id for approve_still and animate.',
            inputSchema: {
                image_url: z
                    .string()
                    .url()
                    .optional()
                    .describe('Public or signed HTTP(S) URL for the image to import.'),
                image_base64: z
                    .string()
                    .optional()
                    .describe(
                        'Base64 image bytes, with or without a data:image/...;base64, prefix.',
                    ),
                image_file: z
                    .object({
                        data: z
                            .string()
                            .describe(
                                'Base64 image bytes, with or without a data:image/...;base64, prefix.',
                            ),
                        mime_type: z
                            .string()
                            .optional()
                            .describe('Declared MIME type, e.g. image/png.'),
                        filename: z.string().optional().describe('Original filename, if known.'),
                    })
                    .optional()
                    .describe(
                        'File-like image payload for hosts that can expose generated files as base64.',
                    ),
                project_id: z
                    .string()
                    .optional()
                    .describe('Existing project id. A default project is used if omitted.'),
                project_name: z
                    .string()
                    .optional()
                    .describe(
                        'Name of a project to use, created if it does not exist. Ignored when ' +
                        'project_id is given.',
                    ),
                shot_number: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Shot number within the project. Auto-assigned if omitted.'),
                shot_id: z
                    .string()
                    .optional()
                    .describe(
                        'Existing shot id to add this image as a new still version. Use this when replacing a faulty scene image.',
                    ),
                shot_description: z
                    .string()
                    .optional()
                    .describe(
                        'Description to store for this imported still. Useful for list_shots.',
                    ),
                include_image: z
                    .boolean()
                    .optional()
                    .describe('Embed a preview of the imported image. Default true.'),
            },
        },
        guard('import_image', async (args) => {
            const sourceCount = [
                Boolean(args.image_url),
                Boolean(args.image_base64),
                Boolean(args.image_file?.data),
            ].filter(Boolean).length;
            if (sourceCount !== 1) {
                return fail(
                    'Provide exactly one of image_url, image_base64, or image_file.data.',
                );
            }

            let projectId = args.project_id;
            if (projectId) {
                const project = await getProject(projectId);
                if (!project) return fail(`No project with id ${projectId}`);
            } else if (args.project_name) {
                projectId = (await getOrCreateProjectByName(args.project_name)).id;
            } else {
                projectId = (await getOrCreateDefaultProject()).id;
            }

            let imported: { bytes: Uint8Array; contentType?: string; source?: string };
            if (args.image_url) {
                const downloaded = await downloadImportUrl(args.image_url);
                imported = {
                    bytes: downloaded.bytes,
                    contentType: downloaded.contentType,
                    source: downloaded.finalUrl,
                };
            } else if (args.image_file?.data) {
                const parsed = parseBase64Image(args.image_file.data);
                imported = {
                    bytes: parsed.bytes,
                    contentType: args.image_file.mime_type?.toLowerCase() ?? parsed.contentType,
                    source: args.image_file.filename,
                };
            } else {
                const parsed = parseBase64Image(args.image_base64!);
                imported = {
                    bytes: parsed.bytes,
                    contentType: parsed.contentType,
                };
            }

            const image = inspectImage(imported.bytes, imported.contentType);
            const shot = args.shot_id
                ? await getShot(args.shot_id)
                : await createShot({
                      projectId,
                      shotNumber: args.shot_number ?? (await nextShotNumber(projectId)),
                      description:
                          args.shot_description?.trim() ||
                          'Imported still generated outside the shorts MCP server',
                  });
            if (!shot) return fail(`No shot with id ${args.shot_id}`);
            if (shot.project_id !== projectId) {
                return fail(`Shot ${shot.id} does not belong to project ${projectId}`);
            }

            const id = randomUUID();
            const stored = await putBuffer(
                assetPath(shot.id, 'still', id, image.ext),
                imported.bytes,
                image.mimeType,
            );
            const asset = await createAsset({
                shotId: shot.id,
                kind: 'still',
                storagePath: stored.storagePath,
                publicUrl: stored.publicUrl,
            });
            await setShotStatus(shot.id, 'still_ready');

            const images =
                args.include_image === false
                    ? []
                    : await imageBlocks(asset.public_url, `Imported still — asset_id ${asset.id}`);

            return ok(
                {
                    asset_id: asset.id,
                    shot_id: shot.id,
                    project_id: projectId,
                    shot_number: shot.shot_number,
                    url: asset.public_url,
                    mime_type: image.mimeType,
                    ...(image.width && image.height
                        ? { width: image.width, height: image.height }
                        : {}),
                    ...(imported.source ? { source: imported.source } : {}),
                    ...(args.shot_id ? { version_of_shot_id: args.shot_id } : {}),
                    hint:
                        (args.shot_id
                            ? 'Imported as a replacement still version for the existing shot. '
                            : 'Imported as a still. ') +
                        'Call approve_still with this asset_id, then animate with the same ' +
                        'asset_id and a motion_instruction.',
                },
                images,
            );
        }),
    );

    // -------------------------------------------------------- import_reference_image

    server.registerTool(
        'import_reference_image',
        {
            title: 'Import a reusable reference image',
            description:
                'Import an external image and tag it as a reusable story reference, such ' +
                'as a character design, expression sheet, prop, location or style plate. ' +
                'Returns an asset_id that can be passed in generate_still.reference_asset_ids.',
            inputSchema: {
                image_url: z.string().url().optional().describe('Public or signed HTTP(S) URL.'),
                image_base64: z
                    .string()
                    .optional()
                    .describe('Base64 image bytes, with or without a data URL prefix.'),
                image_file: z
                    .object({
                        data: z.string().describe('Base64 image bytes.'),
                        mime_type: z.string().optional().describe('Declared MIME type.'),
                        filename: z.string().optional().describe('Original filename, if known.'),
                    })
                    .optional(),
                project_id: z.string().optional().describe('Existing project id.'),
                project_name: z
                    .string()
                    .optional()
                    .describe('Project name, created if it does not exist.'),
                role: z
                    .enum(REFERENCE_ROLES)
                    .describe('What kind of reusable reference this image is.'),
                label: z
                    .string()
                    .min(1)
                    .describe('Human-readable name, e.g. "Mara main design".'),
                notes: z.string().optional().describe('Short continuity notes.'),
                metadata: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('Small structured metadata object.'),
                include_image: z
                    .boolean()
                    .optional()
                    .describe('Embed a preview of the imported reference. Default true.'),
            },
        },
        guard('import_reference_image', async (args) => {
            const projectId = await resolveProjectId(args);
            if (!projectId) return fail(`No project with id ${args.project_id}`);

            const imported = await loadImportedImage(args);
            const still = await importStillAsset({
                projectId,
                description: `Reference image: ${args.role} - ${args.label}`,
                imported,
            });
            const ref = await createReferenceAsset({
                projectId,
                assetId: still.asset.id,
                role: args.role,
                label: args.label,
                notes: args.notes,
                metadata: args.metadata,
            });

            const images =
                args.include_image === false
                    ? []
                    : await imageBlocks(
                          still.publicUrl,
                          `Reference ${args.label} - asset_id ${still.asset.id}`,
                      );

            return ok(
                {
                    reference_id: ref.id,
                    asset_id: still.asset.id,
                    project_id: projectId,
                    role: ref.role,
                    label: ref.label,
                    notes: ref.notes,
                    metadata: ref.metadata,
                    url: still.publicUrl,
                    mime_type: still.mimeType,
                    ...(still.width && still.height
                        ? { width: still.width, height: still.height }
                        : {}),
                    hint:
                        'Stored as a reusable reference. Use this asset_id in ' +
                        'generate_still.reference_asset_ids for later scene stills.',
                },
                images,
            );
        }),
    );

    // ---------------------------------------------------------- save_story_manifest

    server.registerTool(
        'save_story_manifest',
        {
            title: 'Save story manifest',
            description:
                'Save or replace the structured story manifest for a project. Use this ' +
                'after analyzing a story into characters, references and planned shots.',
            inputSchema: {
                project_id: z.string().optional().describe('Existing project id.'),
                project_name: z
                    .string()
                    .optional()
                    .describe('Project name, created if it does not exist.'),
                title: z.string().optional().describe('Story or short title.'),
                story_text: z.string().optional().describe('Original story text or summary.'),
                manifest: z
                    .record(z.string(), z.unknown())
                    .describe('Structured JSON manifest for characters, references and shots.'),
            },
        },
        guard('save_story_manifest', async (args) => {
            const projectId = await resolveProjectId(args);
            if (!projectId) return fail(`No project with id ${args.project_id}`);

            const row = await saveStoryManifest({
                projectId,
                title: args.title,
                storyText: args.story_text,
                manifest: args.manifest,
            });

            return ok({
                project_id: projectId,
                manifest_id: row.id,
                title: row.title,
                updated_at: row.updated_at,
                hint:
                    'Manifest saved. Use get_story_manifest later to resume this story ' +
                    'with its reference index.',
            });
        }),
    );

    // ----------------------------------------------------------- get_story_manifest

    server.registerTool(
        'get_story_manifest',
        {
            title: 'Get story manifest',
            description:
                'Return the saved story manifest plus reusable reference images for a project.',
            inputSchema: {
                project_id: z.string().optional().describe('Existing project id.'),
                project_name: z.string().optional().describe('Existing project name.'),
                role: z
                    .enum(REFERENCE_ROLES)
                    .optional()
                    .describe('Optional reference role filter.'),
                label: z.string().optional().describe('Optional fuzzy label filter.'),
            },
        },
        guard('get_story_manifest', async (args) => {
            let projectId = args.project_id;
            if (projectId) {
                const project = await getProject(projectId);
                if (!project) return fail(`No project with id ${projectId}`);
            } else if (args.project_name) {
                const projects = await listProjects();
                const match = projects.find(
                    (p) => p.name.toLowerCase() === args.project_name!.trim().toLowerCase(),
                );
                if (!match) return fail(`No project named "${args.project_name}"`);
                projectId = match.id;
            } else {
                projectId = (await getOrCreateDefaultProject()).id;
            }

            const [manifest, refs] = await Promise.all([
                getStoryManifest(projectId),
                listReferenceAssets({ projectId, role: args.role, label: args.label }),
            ]);

            return ok({
                project_id: projectId,
                manifest: manifest
                    ? {
                          manifest_id: manifest.id,
                          title: manifest.title,
                          story_text: manifest.story_text,
                          manifest: manifest.manifest,
                          updated_at: manifest.updated_at,
                      }
                    : null,
                references: await referenceRowsWithUrls(refs),
                hint:
                    'Use reference asset_id values in generate_still.reference_asset_ids ' +
                    'when creating scene stills.',
            });
        }),
    );

    // ------------------------------------------------------------- approve_still

    server.registerTool(
        'approve_still',
        {
            title: 'Approve a still',
            description:
                'Mark one still as the approved plate for its shot. Un-approves every ' +
                'sibling still. The approved still is what animate uses as its source frame.',
            inputSchema: {
                asset_id: z.string().min(1).describe('The asset_id of the still to approve.'),
            },
        },
        guard('approve_still', async (args) => {
            const asset = await getAsset(args.asset_id);
            if (!asset) return fail(`No asset with id ${args.asset_id}`);
            if (asset.kind !== 'still') {
                return fail(`Asset ${args.asset_id} is a ${asset.kind}, not a still`);
            }

            await approveStillExclusively(asset);
            await setShotStatus(asset.shot_id, 'approved');

            return ok({
                asset_id: asset.id,
                shot_id: asset.shot_id,
                url: asset.public_url,
            });
        }),
    );

    // ------------------------------------------------------------------- animate

    server.registerTool(
        'animate',
        {
            title: 'Animate an approved still',
            description:
                'Submit an approved still for image-to-video generation and return ' +
                'immediately with a job id. Video generation takes 30s to several minutes, ' +
                'so this never blocks — poll check_job for the result. Style and negative ' +
                'prompts are applied server-side.',
            // Same widget as check_job: the card appears the moment the job is
            // submitted and keeps itself up to date, rather than showing
            // nothing until someone polls.
            _meta: uiMeta(PLAYER_URI),
            inputSchema: {
                asset_id: z
                    .string()
                    .min(1)
                    .describe('Asset id of an approved still (see approve_still).'),
                motion_instruction: z
                    .string()
                    .min(1)
                    .describe('What should move, e.g. "slow push in, leaves drift".'),
                duration: z
                    .number()
                    .int()
                    .min(MIN_DURATION)
                    .max(MAX_DURATION)
                    .optional()
                    .describe(`Seconds, ${MIN_DURATION}-${MAX_DURATION}. Default ${DEFAULT_DURATION}.`),
                palette_override: z
                    .string()
                    .optional()
                    .describe('Palette shift for this beat. Should match the still.'),
            },
        },
        guard('animate', async (args) => {
            const duration = args.duration ?? DEFAULT_DURATION;

            const asset = await getAsset(args.asset_id);
            if (!asset) return fail(`No asset with id ${args.asset_id}`);
            if (asset.kind !== 'still') {
                return fail(`Asset ${args.asset_id} is a ${asset.kind}, not a still`);
            }
            if (!asset.approved) {
                return fail(
                    `Still ${args.asset_id} is not approved. Call approve_still on it first.`,
                );
            }

            const shot = await getShot(asset.shot_id);
            if (!shot) return fail(`Shot ${asset.shot_id} no longer exists`);

            const prompt = buildPrompt({
                shotDescription: shot.description,
                motionInstruction: args.motion_instruction,
                paletteOverride: args.palette_override,
            });

            // We hand xAI our own storage URL, never an upstream one.
            const requestId = await submitVideo({
                prompt,
                imageUrl: asset.public_url,
                duration,
            });

            const job = await createJob({
                shotId: shot.id,
                sourceAssetId: asset.id,
                upstreamJob: requestId,
                motionInstruction: args.motion_instruction,
                duration,
            });
            await setShotStatus(shot.id, 'animating');

            log.info('animate submitted', { jobId: job.id, shotId: shot.id, duration });
            // Model and resolution ride along so the widget can label the card
            // while the job runs, the way a job card is expected to.
            const cfg = getConfig();
            return ok({
                job_id: job.id,
                status: 'submitted',
                shot_id: shot.id,
                duration,
                model: cfg.videoModel,
                resolution: cfg.videoResolution,
            });
        }),
    );

    // ----------------------------------------------------------------- check_job

    server.registerTool(
        'check_job',
        {
            title: 'Check a video job',
            description:
                'Poll an animate job. When done, returns the video URL and a stored ' +
                'last_frame_url for later continuity. The player widget displays the video. ' +
                'Only request frame images or critique for explicit diagnostics.',
            // Plays the clip inline for the user.
            _meta: uiMeta(PLAYER_URI),
            inputSchema: {
                job_id: z.string().min(1).describe('Job id returned by animate.'),
                include_images: z
                    .boolean()
                    .optional()
                    .describe(
                        'Embed a last-frame preview image. Default false; use true only for diagnostics.',
                    ),
                include_frames: z
                    .boolean()
                    .optional()
                    .describe(
                        'Return first_frame_url as well as last_frame_url. Default false; use true only for diagnostics.',
                    ),
                critique: z
                    .boolean()
                    .optional()
                    .describe(
                        'Run a server-side vision comparison of the two frames and return it ' +
                        'as text. Default false; use true only when troubleshooting a bad video.',
                    ),
            },
        },
        guard('check_job', async (args) => {
            const existing = await getJob(args.job_id);
            if (!existing) return fail(`No job with id ${args.job_id}`);

            // Poll upstream eagerly so check_job makes progress even if the
            // background worker is between ticks.
            const job = (await advanceJobById(args.job_id)) ?? existing;
            const assets = await listAssetsForShots([job.shot_id]);
            const byId = new Map(assets.map((a) => [a.id, a]));

            const cfg = getConfig();
            const payload: Record<string, unknown> = {
                job_id: job.id,
                shot_id: job.shot_id,
                status: job.status,
                duration: job.duration,
                model: cfg.videoModel,
                resolution: cfg.videoResolution,
            };
            const images: ContentBlock[] = [];
            if (job.status === 'done') {
                const firstUrl = byId.get(job.first_frame_asset_id ?? '')?.public_url;
                const lastUrl = byId.get(job.last_frame_asset_id ?? '')?.public_url;
                payload.video_url = byId.get(job.video_asset_id ?? '')?.public_url;
                payload.last_frame_url = lastUrl;
                if (args.include_frames === true || args.critique === true) {
                    payload.first_frame_url = firstUrl;
                }
                payload.hint =
                    'Video is ready. Review the clip in the player widget. The last_frame_url ' +
                    'is stored for later continuity if needed.';

                if (getConfig().enableVisionCritique && args.critique === true) {
                    const shot = await getShot(job.shot_id);
                    if (firstUrl && lastUrl && shot) {
                        payload.drift_report = await critiqueDrift(
                            firstUrl,
                            lastUrl,
                            shot.description,
                        );
                        payload.hint +=
                            ' drift_report is diagnostic text from a server-side vision ' +
                            'comparison; do not use it as a normal approval gate.';
                    }
                }

                if (args.include_images === true && lastUrl) {
                    images.push(...(await imageBlocks(lastUrl, 'Last frame preview:')));
                }
            }
            if (job.error) payload.error = job.error;

            return ok(payload, images);
        }),
    );

    // ---------------------------------------------------------------- list_shots

    server.registerTool(
        'list_shots',
        {
            title: 'List shots',
            description:
                'List every shot in a project with its status and asset URLs, plus every ' +
                'project that exists. This is the resume path — it returns enough to pick ' +
                'a half-finished project back up cold in a new session, including all ' +
                'unapproved still variations.',
            inputSchema: {
                project_id: z
                    .string()
                    .optional()
                    .describe('Project id. The default project is used if omitted.'),
                project_name: z
                    .string()
                    .optional()
                    .describe('Name of an existing project. Ignored when project_id is given.'),
            },
        },
        guard('list_shots', async (args) => {
            // Always enumerate projects: without a list tool this is how a cold
            // session discovers what else is in flight.
            const projects = await listProjects();

            let projectId = args.project_id;
            if (projectId) {
                const project = await getProject(projectId);
                if (!project) return fail(`No project with id ${projectId}`);
            } else if (args.project_name) {
                const match = projects.find(
                    (p) => p.name.toLowerCase() === args.project_name!.trim().toLowerCase(),
                );
                if (!match) {
                    return fail(
                        `No project named "${args.project_name}". Existing projects: ` +
                            (projects.map((p) => p.name).join(', ') || '(none)'),
                    );
                }
                projectId = match.id;
            } else {
                projectId = (await getOrCreateDefaultProject()).id;
            }

            const shots = await listShots(projectId);
            const shotIds = shots.map((s) => s.id);
            const assets = await listAssetsForShots(shotIds);
            const jobs = await latestJobsForShots(shotIds);

            const byShot = new Map<string, AssetRow[]>();
            for (const asset of assets) {
                const list = byShot.get(asset.shot_id) ?? [];
                list.push(asset);
                byShot.set(asset.shot_id, list);
            }

            const rows = shots.map((shot) => {
                const shotAssets = byShot.get(shot.id) ?? [];
                const stills = shotAssets.filter((a) => a.kind === 'still');
                const approved = stills.find((a) => a.approved);
                const newest = (kind: string): AssetRow | undefined =>
                    shotAssets.filter((a) => a.kind === kind).at(-1);
                const job: JobRow | undefined = jobs.get(shot.id);

                return {
                    shot_id: shot.id,
                    shot_number: shot.shot_number,
                    description: shot.description,
                    status: shot.status,
                    still_url: (approved ?? stills.at(-1))?.public_url,
                    still_asset_id: (approved ?? stills.at(-1))?.id,
                    still_approved: Boolean(approved),
                    still_count: stills.length,
                    // Every variation, not just the approved one. Reporting a
                    // count of 4 while returning a single id stranded the other
                    // three: after a lost session there was no way to approve
                    // one of them, or to re-examine a rejected take.
                    stills: stills.map((s) => ({
                        asset_id: s.id,
                        url: s.public_url,
                        approved: s.approved,
                    })),
                    video_url: newest('video')?.public_url,
                    first_frame_url: newest('first_frame')?.public_url,
                    last_frame_url: newest('last_frame')?.public_url,
                    ...(job ? { job_id: job.id, job_status: job.status } : {}),
                    ...(job?.error ? { error: job.error } : {}),
                };
            });

            return ok({
                project_id: projectId,
                project_name: projects.find((p) => p.id === projectId)?.name,
                shots: rows,
                projects: projects.map((p) => ({ project_id: p.id, name: p.name })),
            });
        }),
    );
}
