import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GALLERY_URI, PLAYER_URI, uiMeta } from './apps.js';
import { makeContactSheet, makePreview } from './frames.js';
import { downloadWithRetry } from './storage.js';
import {
    buildPrompt,
    DEFAULT_DURATION,
    DEFAULT_STILL_COUNT,
    MAX_DURATION,
    MAX_REFERENCE_IMAGES,
    MAX_STILL_COUNT,
    MIN_DURATION,
} from './config.js';
import {
    approveStillExclusively,
    createAsset,
    createJob,
    createShot,
    getAsset,
    getJob,
    getOrCreateDefaultProject,
    getOrCreateProjectByName,
    getProject,
    listProjects,
    getShot,
    latestJobsForShots,
    listAssetsForShots,
    listShots,
    nextShotNumber,
    setShotStatus,
    type AssetRow,
    type JobRow,
} from './db.js';
import { errorMessage, log } from './logger.js';
import { assetPath, persistFromUrl } from './storage.js';
import { advanceJobById } from './worker.js';
import { editImage, generateImage, submitVideo } from './xai.js';

/**
 * The five tools. The surface is deliberately small.
 *
 * Note what is absent: there is no `style` parameter anywhere. Style is a
 * server-owned constant (see config.ts) so it cannot be forgotten or
 * overridden. `palette_override` is the only prompt lever exposed, because
 * palette shifts per story beat while the base style never does.
 */

type ContentBlock = CallToolResult['content'][number];

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
                    hint:
                        'The images below are the variations, in order. Judge them on style ' +
                        'fidelity (flat 2D, even outlines, no photorealism) and composition, ' +
                        'then call approve_still with the chosen asset_id.',
                    ...(failures.length > 0
                        ? { warning: `${failures.length} of ${count} generations failed`, failures }
                        : {}),
                },
                images,
            );
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
            return ok({ job_id: job.id, status: 'submitted' });
        }),
    );

    // ----------------------------------------------------------------- check_job

    server.registerTool(
        'check_job',
        {
            title: 'Check a video job',
            description:
                'Poll an animate job. When done, returns the video URL plus the first and ' +
                'last frames as viewable images. Look at both: the characteristic failure ' +
                'is starting flat and progressively turning photorealistic, or moving ' +
                'something meant to stay still. Report drift rather than accepting it.',
            // Plays the clip and shows the frame pair inline for the user.
            _meta: uiMeta(PLAYER_URI),
            inputSchema: {
                job_id: z.string().min(1).describe('Job id returned by animate.'),
                include_images: z
                    .boolean()
                    .optional()
                    .describe('Embed the frames as images. Default true; set false to save tokens.'),
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

            const payload: Record<string, unknown> = {
                job_id: job.id,
                shot_id: job.shot_id,
                status: job.status,
            };
            const images: ContentBlock[] = [];
            if (job.status === 'done') {
                const firstUrl = byId.get(job.first_frame_asset_id ?? '')?.public_url;
                const lastUrl = byId.get(job.last_frame_asset_id ?? '')?.public_url;
                payload.video_url = byId.get(job.video_asset_id ?? '')?.public_url;
                payload.first_frame_url = firstUrl;
                payload.last_frame_url = lastUrl;
                payload.hint =
                    'The two frames below are the first and last frame of this clip. Compare ' +
                    'them for style drift (flat 2D holding? outlines even? anything moved that ' +
                    'should not have?) before accepting this shot.';

                if (args.include_images !== false) {
                    // One block, not two. The frames are only ever looked at
                    // together, side by side is the better comparison anyway,
                    // and halving image slots per call doubles how long a
                    // conversation stays useful if the host caps them.
                    images.push(
                        ...(firstUrl && lastUrl
                            ? await contactSheetBlocks(
                                  [firstUrl, lastUrl],
                                  'LEFT = first frame, RIGHT = last frame. Compare them for ' +
                                      'style drift before accepting this shot.',
                              )
                            : [
                                  ...(await imageBlocks(firstUrl, 'FIRST frame:')),
                                  ...(await imageBlocks(lastUrl, 'LAST frame:')),
                              ]),
                    );
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
