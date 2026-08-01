import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    buildPrompt,
    DEFAULT_DURATION,
    DEFAULT_STILL_COUNT,
    MAX_DURATION,
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
    getProject,
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
import { generateImage, submitVideo } from './xai.js';

/**
 * The five tools. The surface is deliberately small.
 *
 * Note what is absent: there is no `style` parameter anywhere. Style is a
 * server-owned constant (see config.ts) so it cannot be forgotten or
 * overridden. `palette_override` is the only prompt lever exposed, because
 * palette shifts per story beat while the base style never does.
 */

// Structured JSON in `content` as well as `structuredContent`, since clients
// vary in which they surface to the model.
function ok(payload: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload as Record<string, unknown>,
    };
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
                'persisted to permanent storage before this returns. Pick one with approve_still.',
            inputSchema: {
                shot_description: z
                    .string()
                    .min(1)
                    .describe('What the shot depicts. Do not include style instructions.'),
                project_id: z
                    .string()
                    .optional()
                    .describe('Existing project id. A default project is used if omitted.'),
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
            },
        },
        guard('generate_still', async (args) => {
            const count = args.count ?? DEFAULT_STILL_COUNT;

            let projectId = args.project_id;
            if (projectId) {
                const project = await getProject(projectId);
                if (!project) return fail(`No project with id ${projectId}`);
            } else {
                projectId = (await getOrCreateDefaultProject()).id;
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
            });

            // Generate in parallel, but tolerate partial failure — some stills
            // beat none, and the caller is told how many landed.
            const results = await Promise.allSettled(
                Array.from({ length: count }, async () => {
                    const upstreamUrl = await generateImage(prompt);
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

            return ok({
                shot_id: shot.id,
                project_id: projectId,
                shot_number: shot.shot_number,
                stills,
                ...(failures.length > 0
                    ? { warning: `${failures.length} of ${count} generations failed`, failures }
                    : {}),
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
                'Poll an animate job. When done, returns the video URL plus first-frame ' +
                'and last-frame PNGs. Compare those two frames to catch style drift — the ' +
                'characteristic failure is starting flat and progressively turning ' +
                'photorealistic, or moving something meant to stay still.',
            inputSchema: {
                job_id: z.string().min(1).describe('Job id returned by animate.'),
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
            if (job.status === 'done') {
                payload.video_url = byId.get(job.video_asset_id ?? '')?.public_url;
                payload.first_frame_url = byId.get(job.first_frame_asset_id ?? '')?.public_url;
                payload.last_frame_url = byId.get(job.last_frame_asset_id ?? '')?.public_url;
                payload.hint =
                    'Compare first_frame_url and last_frame_url for style drift before accepting this shot.';
            }
            if (job.error) payload.error = job.error;

            return ok(payload);
        }),
    );

    // ---------------------------------------------------------------- list_shots

    server.registerTool(
        'list_shots',
        {
            title: 'List shots',
            description:
                'List every shot in a project with its status and current asset URLs. ' +
                'This is the resume path — it returns enough to pick a half-finished ' +
                'project back up cold in a new session.',
            inputSchema: {
                project_id: z
                    .string()
                    .optional()
                    .describe('Project id. The default project is used if omitted.'),
            },
        },
        guard('list_shots', async (args) => {
            let projectId = args.project_id;
            if (projectId) {
                const project = await getProject(projectId);
                if (!project) return fail(`No project with id ${projectId}`);
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
                    video_url: newest('video')?.public_url,
                    first_frame_url: newest('first_frame')?.public_url,
                    last_frame_url: newest('last_frame')?.public_url,
                    ...(job ? { job_id: job.id, job_status: job.status } : {}),
                    ...(job?.error ? { error: job.error } : {}),
                };
            });

            return ok({ project_id: projectId, shots: rows });
        }),
    );
}
