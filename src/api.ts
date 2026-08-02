import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import express, { type Request, type Response, type Router } from 'express';
import { pitchIdeas, planReferences, planShots, writeStory } from './assist.js';
import {
    getConfig,
    DEFAULT_DURATION,
    DEFAULT_STILL_COUNT,
    MAX_DURATION,
    MAX_REFERENCE_IMAGES,
    MAX_STILL_COUNT,
    MIN_DURATION,
} from './config.js';
import {
    createProject,
    createReferenceAsset,
    deleteProject,
    deleteReferenceAsset,
    deleteShot,
    getJob,
    getProject,
    getShot,
    listProjects,
    listShots,
    listAssetsForShots,
    listJobsForShots,
    renameProject,
    saveStoryManifest,
    getStoryManifest,
    updateShotDescription,
} from './db.js';
import { importStillAsset, loadImportedImage } from './import.js';
import { errorMessage, log } from './logger.js';
import {
    animateStill,
    approveStill,
    cancelJob,
    generateStills,
    NotFound,
    projectSnapshot,
    referenceAssetIdsForLabels,
    requireProject,
    retryJob,
} from './pipeline.js';
import { advanceJobById } from './worker.js';

/**
 * JSON API behind the Shorts Studio web UI.
 *
 * Every mutating route here is a thin wrapper over pipeline.ts — the same code
 * the MCP tools run. The UI is a second control surface over one pipeline, not
 * a second pipeline, so a change to how a still is generated lands in both at
 * once.
 *
 * Auth is the existing shared secret, applied as middleware by server.ts before
 * this router is reached. Nothing in here re-checks it, and nothing in here is
 * reachable without it.
 *
 * Note what these routes cost: generating stills and submitting video both
 * spend xAI credits. That is the point of the UI — it is a studio, not a
 * viewer — but it means the secret protecting it is protecting a wallet.
 */

/** Image generation runs to completion inline; four variations can take a minute. */
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

function bad(message: string): never {
    throw new HttpError(400, message);
}

/**
 * Wrap a handler so a throw becomes JSON rather than an Express stack trace.
 *
 * Messages from pipeline.ts and xai.ts are already redacted at their source, so
 * they are safe to return; anything else is reported as a generic 500.
 */
function route(
    name: string,
    handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response) => void {
    return (req, res) => {
        const started = Date.now();
        void (async () => {
            try {
                const payload = await handler(req, res);
                if (res.headersSent) return;
                log.info('api ok', { route: name, ms: Date.now() - started });
                res.json(payload ?? { ok: true });
            } catch (err) {
                const message = errorMessage(err);
                const status =
                    err instanceof HttpError ? err.status : err instanceof NotFound ? 404 : 500;
                log.error('api failed', { route: name, ms: Date.now() - started, error: message });
                if (!res.headersSent) res.status(status).json({ error: message });
            }
        })();
    };
}

// ------------------------------------------------------------------ parsing

function body(req: Request): Record<string, unknown> {
    const value = req.body;
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function str(source: Record<string, unknown>, key: string): string | undefined {
    const value = source[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function requiredStr(source: Record<string, unknown>, key: string): string {
    return str(source, key) ?? bad(`${key} is required`);
}

function int(
    source: Record<string, unknown>,
    key: string,
    opts: { min: number; max: number; fallback: number },
): number {
    const value = source[key];
    if (value === undefined || value === null || value === '') return opts.fallback;
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) bad(`${key} must be a number`);
    if (parsed < opts.min || parsed > opts.max) {
        bad(`${key} must be between ${opts.min} and ${opts.max}`);
    }
    return parsed;
}

function strList(source: Record<string, unknown>, key: string): string[] {
    const value = source[key];
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * A filename that survives every filesystem and reads as what it is.
 *
 * Zero-padded so a directory of clips sorts into story order rather than
 * 1, 10, 11, 2 — the whole point of downloading them is to drop them on a
 * timeline in sequence.
 */
function clipFilename(projectName: string, shotNumber: number): string {
    const slug =
        projectName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48) || 'short';
    return `${slug}-shot-${String(shotNumber).padStart(2, '0')}.mp4`;
}

function param(req: Request, key: string): string {
    const value = (req.params as Record<string, string | undefined>)[key];
    if (!value) bad(`${key} is required`);
    return value;
}

// ------------------------------------------------------------------- routes

export function apiRoutes(): Router {
    const router = express.Router();

    /**
     * Sidebar footer: what this deployment is actually configured to do.
     *
     * The models and toggles are shown because they change what a click costs
     * and what comes back, and reading them off the running server beats
     * guessing from a dashboard in another tab.
     */
    router.get(
        '/config',
        route('config', async () => {
            const cfg = getConfig();
            return {
                video_model: cfg.videoModel,
                video_resolution: cfg.videoResolution,
                image_model: cfg.imageModel,
                vision_model: cfg.visionModel,
                vision_critique: cfg.enableVisionCritique,
                mcp_apps: cfg.enableMcpApps,
                bucket: cfg.supabaseBucket,
                defaults: {
                    still_count: DEFAULT_STILL_COUNT,
                    max_still_count: MAX_STILL_COUNT,
                    duration: DEFAULT_DURATION,
                    min_duration: MIN_DURATION,
                    max_duration: MAX_DURATION,
                    max_reference_images: MAX_REFERENCE_IMAGES,
                },
            };
        }),
    );

    // ---------------------------------------------------------- projects

    router.get(
        '/projects',
        route('list projects', async () => {
            const projects = await listProjects();
            // One summary row per project for the sidebar and the card grid.
            // Cheap enough to do eagerly: it is three queries, not three per
            // project, and the grid is the app's landing screen.
            const summaries = await Promise.all(
                projects.map(async (project) => {
                    const [shots, manifest] = await Promise.all([
                        listShots(project.id),
                        getStoryManifest(project.id),
                    ]);
                    const shotIds = shots.map((s) => s.id);
                    const [assets, jobs] = await Promise.all([
                        listAssetsForShots(shotIds),
                        listJobsForShots(shotIds),
                    ]);
                    const done = shots.filter((s) => s.status === 'done').length;

                    // The card's filmstrip: the approved plate of the first
                    // few shots, in shot order, so the strip reads as the film.
                    const approvedByShot = new Map<string, string>();
                    for (const asset of assets) {
                        if (asset.kind !== 'still') continue;
                        if (asset.approved || !approvedByShot.has(asset.shot_id)) {
                            approvedByShot.set(asset.shot_id, asset.public_url);
                        }
                    }
                    const strip = shots
                        .map((s) => approvedByShot.get(s.id))
                        .filter((url): url is string => Boolean(url))
                        .slice(0, 5);

                    return {
                        id: project.id,
                        name: project.name,
                        created_at: project.created_at,
                        title: manifest?.title ?? null,
                        logline:
                            (typeof manifest?.manifest?.logline === 'string'
                                ? manifest.manifest.logline
                                : null) ??
                            manifest?.story_text?.slice(0, 200) ??
                            null,
                        strip,
                        shot_count: shots.length,
                        done_count: done,
                        approved_count: shots.filter((s) => s.status === 'approved').length,
                        open_jobs: jobs.filter(
                            (j) => j.status === 'submitted' || j.status === 'processing',
                        ).length,
                        state:
                            shots.length === 0
                                ? 'planning'
                                : done === shots.length
                                  ? 'complete'
                                  : 'in progress',
                    };
                }),
            );
            return { projects: summaries };
        }),
    );

    router.post(
        '/projects',
        route('create project', async (req) => {
            const name = requiredStr(body(req), 'name');
            const project = await createProject(name);
            return { project };
        }),
    );

    router.get(
        '/projects/:id',
        route('project snapshot', async (req) => {
            const project = await requireProject(param(req, 'id'));
            return projectSnapshot(project);
        }),
    );

    router.patch(
        '/projects/:id',
        route('rename project', async (req) => {
            const project = await renameProject(param(req, 'id'), requiredStr(body(req), 'name'));
            return { project };
        }),
    );

    router.delete(
        '/projects/:id',
        route('delete project', async (req) => {
            await deleteProject(param(req, 'id'));
            return { ok: true };
        }),
    );

    // ----------------------------------------------------------- manifest

    router.put(
        '/projects/:id/manifest',
        route('save manifest', async (req) => {
            const project = await requireProject(param(req, 'id'));
            const input = body(req);
            const manifest = input.manifest;
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                bad('manifest must be an object');
            }
            const row = await saveStoryManifest({
                projectId: project.id,
                title: str(input, 'title') ?? null,
                storyText: str(input, 'story_text') ?? null,
                manifest: manifest as Record<string, unknown>,
            });
            return { manifest_id: row.id, updated_at: row.updated_at };
        }),
    );

    // -------------------------------------------------------------- shots

    /**
     * Create a shot and generate its first variations in one call.
     *
     * Synchronous on purpose. A shot with no stills is a dead row in the UI,
     * and image generation is fast enough (tens of seconds) to wait on with a
     * spinner. Only video is slow enough to need the job table.
     */
    router.post(
        '/projects/:id/shots',
        route('create shot', async (req, res) => {
            res.setTimeout(GENERATE_TIMEOUT_MS);
            const project = await requireProject(param(req, 'id'));
            const input = body(req);

            const description = requiredStr(input, 'description');
            const referenceIds = strList(input, 'reference_asset_ids');
            const referenceLabels = strList(input, 'reference_labels');
            const resolved = referenceIds.length
                ? referenceIds
                : await referenceAssetIdsForLabels(project.id, referenceLabels);

            const result = await generateStills({
                projectId: project.id,
                shotNumber: input.shot_number === undefined ? undefined : int(input, 'shot_number', {
                    min: 1,
                    max: 999,
                    fallback: 1,
                }),
                description,
                count: int(input, 'count', {
                    min: 1,
                    max: MAX_STILL_COUNT,
                    fallback: DEFAULT_STILL_COUNT,
                }),
                paletteOverride: str(input, 'palette_override'),
                referenceAssetIds: resolved.slice(0, MAX_REFERENCE_IMAGES),
            });

            return {
                shot_id: result.shot.id,
                shot_number: result.shot.shot_number,
                stills: result.stills,
                failures: result.failures,
            };
        }),
    );

    router.patch(
        '/shots/:id',
        route('update shot', async (req) => {
            const shot = await updateShotDescription(
                param(req, 'id'),
                requiredStr(body(req), 'description'),
            );
            return { shot };
        }),
    );

    router.delete(
        '/shots/:id',
        route('delete shot', async (req) => {
            await deleteShot(param(req, 'id'));
            return { ok: true };
        }),
    );

    /** Generate more variations onto a shot that already exists. */
    router.post(
        '/shots/:id/stills',
        route('regenerate stills', async (req, res) => {
            res.setTimeout(GENERATE_TIMEOUT_MS);
            const shotId = param(req, 'id');
            const shot = await getShot(shotId);
            if (!shot) throw new HttpError(404, `No shot with id ${shotId}`);
            const input = body(req);

            const result = await generateStills({
                projectId: shot.project_id,
                shotId: shot.id,
                // A regeneration may also be a rewrite of the shot.
                description: str(input, 'description') ?? shot.description,
                count: int(input, 'count', {
                    min: 1,
                    max: MAX_STILL_COUNT,
                    fallback: DEFAULT_STILL_COUNT,
                }),
                paletteOverride: str(input, 'palette_override'),
                referenceAssetIds: strList(input, 'reference_asset_ids').slice(
                    0,
                    MAX_REFERENCE_IMAGES,
                ),
            });

            const described = str(input, 'description');
            if (described && described !== shot.description) {
                await updateShotDescription(shot.id, described);
            }

            return { shot_id: shot.id, stills: result.stills, failures: result.failures };
        }),
    );

    /** Upload an externally made image as a still for a shot. */
    router.post(
        '/projects/:id/stills/import',
        route('import still', async (req) => {
            const project = await requireProject(param(req, 'id'));
            const input = body(req);
            const imported = await loadImportedImage({
                image_url: str(input, 'image_url'),
                image_base64: str(input, 'image_base64'),
            });
            const still = await importStillAsset({
                projectId: project.id,
                shotId: str(input, 'shot_id'),
                shotNumber:
                    input.shot_number === undefined
                        ? undefined
                        : int(input, 'shot_number', { min: 1, max: 999, fallback: 1 }),
                description:
                    str(input, 'description') ??
                    'Imported still generated outside the shorts MCP server',
                imported,
            });
            return {
                asset_id: still.asset.id,
                shot_id: still.shotId,
                shot_number: still.shotNumber,
                url: still.publicUrl,
                width: still.width,
                height: still.height,
            };
        }),
    );

    // ----------------------------------------------------------- download

    /**
     * Stream a shot's finished clip back through the server.
     *
     * The clip already has a public Storage URL, so this looks redundant — but
     * a browser ignores the `download` attribute on a cross-origin link and
     * navigates to the file instead, which for an mp4 means "plays in a tab"
     * rather than "saves". Coming back through our own origin makes the
     * download honest, and lets the file arrive named after its shot rather
     * than as a uuid.
     */
    router.get(
        '/shots/:id/video',
        route('download clip', async (req, res) => {
            const shotId = param(req, 'id');
            const shot = await getShot(shotId);
            if (!shot) throw new HttpError(404, `No shot with id ${shotId}`);

            const assets = await listAssetsForShots([shotId]);
            const video = assets.filter((a) => a.kind === 'video').at(-1);
            if (!video) throw new HttpError(404, 'This shot has no rendered clip yet');

            const project = await getProject(shot.project_id);
            const upstream = await fetch(video.public_url, {
                signal: AbortSignal.timeout(120_000),
            });
            if (!upstream.ok || !upstream.body) {
                throw new HttpError(502, `Storage returned ${upstream.status} for the clip`);
            }

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${clipFilename(
                project?.name ?? 'short',
                shot.shot_number,
            )}"`);
            const length = upstream.headers.get('content-length');
            if (length) res.setHeader('Content-Length', length);

            // Streamed rather than buffered: a 15-second clip is small, but
            // holding every concurrent download in memory on a free instance
            // is a needless way to fall over.
            await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), res);
            return undefined;
        }),
    );

    // ------------------------------------------------------------ approve

    router.post(
        '/stills/:assetId/approve',
        route('approve still', async (req) => approveStill(param(req, 'assetId'))),
    );

    // ------------------------------------------------------------ animate

    router.post(
        '/shots/:id/animate',
        route('animate shot', async (req) => {
            const shotId = param(req, 'id');
            const input = body(req);

            // The UI addresses shots; animate addresses the approved still.
            // Resolving here keeps that translation out of the client.
            const assets = await listAssetsForShots([shotId]);
            const approved = assets.find((a) => a.kind === 'still' && a.approved);
            if (!approved) {
                throw new HttpError(
                    409,
                    'This shot has no approved still. Approve a variation before animating.',
                );
            }

            const shot = await getShot(shotId);
            if (!shot) throw new HttpError(404, `No shot with id ${shotId}`);

            return animateStill({
                assetId: approved.id,
                motionInstruction:
                    str(input, 'motion_instruction') ??
                    bad('motion_instruction is required to animate a shot'),
                duration: int(input, 'duration', {
                    min: MIN_DURATION,
                    max: MAX_DURATION,
                    fallback: DEFAULT_DURATION,
                }),
                paletteOverride: str(input, 'palette_override'),
            });
        }),
    );

    /**
     * Animate every approved shot in one go.
     *
     * Submissions are sequential and failures are collected rather than thrown:
     * one shot whose still went missing must not stop the other seven from
     * being submitted, and the caller is told exactly which ones did not go.
     */
    router.post(
        '/projects/:id/animate-approved',
        route('animate approved', async (req) => {
            const project = await requireProject(param(req, 'id'));
            const input = body(req);
            const duration = int(input, 'duration', {
                min: MIN_DURATION,
                max: MAX_DURATION,
                fallback: DEFAULT_DURATION,
            });

            const snapshot = await projectSnapshot(project);
            const pending = snapshot.shots.filter(
                (s) => s.status === 'approved' && s.approved_asset_id,
            );

            const submitted: Array<{ shot_number: number; job_id: string }> = [];
            const failures: Array<{ shot_number: number; error: string }> = [];

            for (const shot of pending) {
                try {
                    const job = await animateStill({
                        assetId: shot.approved_asset_id!,
                        // Fall back to a safe default rather than refusing: an
                        // unplanned shot should still be animatable from here.
                        motionInstruction:
                            shot.motion_instruction ??
                            'slow push in, subtle atmospheric drift in the background',
                        duration,
                    });
                    submitted.push({ shot_number: shot.shot_number, job_id: job.job_id });
                } catch (err) {
                    failures.push({ shot_number: shot.shot_number, error: errorMessage(err) });
                }
            }

            return { submitted, failures };
        }),
    );

    // --------------------------------------------------------------- jobs

    /** Poll one job, advancing it upstream first so the UI sees fresh state. */
    router.get(
        '/jobs/:id',
        route('check job', async (req) => {
            const jobId = param(req, 'id');
            const job = (await advanceJobById(jobId)) ?? (await getJob(jobId));
            if (!job) throw new HttpError(404, `No job with id ${jobId}`);
            return {
                job_id: job.id,
                shot_id: job.shot_id,
                status: job.status,
                error: job.error,
                attempts: job.attempts,
                updated_at: job.updated_at,
            };
        }),
    );

    router.post('/jobs/:id/retry', route('retry job', async (req) => retryJob(param(req, 'id'))));

    router.post(
        '/jobs/:id/cancel',
        route('cancel job', async (req) => {
            const job = await cancelJob(param(req, 'id'));
            return { job_id: job.id, status: job.status };
        }),
    );

    // --------------------------------------------------------- references

    router.post(
        '/projects/:id/references',
        route('import reference', async (req) => {
            const project = await requireProject(param(req, 'id'));
            const input = body(req);
            const label = requiredStr(input, 'label');
            const role = str(input, 'role') ?? 'other';

            const imported = await loadImportedImage({
                image_url: str(input, 'image_url'),
                image_base64: str(input, 'image_base64'),
            });
            const still = await importStillAsset({
                projectId: project.id,
                description: `Reference plate: ${label}`,
                imported,
            });
            const reference = await createReferenceAsset({
                projectId: project.id,
                assetId: still.asset.id,
                role,
                label,
                notes: str(input, 'notes') ?? null,
                metadata: {
                    width: still.width,
                    height: still.height,
                    mime_type: still.mimeType,
                    source: still.source,
                },
            });

            return {
                reference_id: reference.id,
                asset_id: still.asset.id,
                url: still.publicUrl,
                role,
                label,
            };
        }),
    );

    /**
     * Generate a reference plate with Grok rather than uploading one.
     *
     * This is the wizard's reference step made real: it produces the plate,
     * persists it, and tags it in one call, so a planned reference becomes a
     * usable asset_id without leaving the studio. One variation, not four —
     * a plate that needs picking between is a plate that has not been
     * described precisely enough.
     */
    router.post(
        '/projects/:id/references/generate',
        route('generate reference', async (req, res) => {
            res.setTimeout(GENERATE_TIMEOUT_MS);
            const project = await requireProject(param(req, 'id'));
            const input = body(req);
            const label = requiredStr(input, 'label');
            const role = str(input, 'role') ?? 'other';
            const description = requiredStr(input, 'description');

            const result = await generateStills({
                projectId: project.id,
                description: `Reference plate — ${label}. ${description}`,
                count: int(input, 'count', { min: 1, max: 4, fallback: 1 }),
                paletteOverride: str(input, 'palette_override'),
                referenceAssetIds: strList(input, 'reference_asset_ids').slice(
                    0,
                    MAX_REFERENCE_IMAGES,
                ),
            });

            const plate = result.stills[0];
            if (!plate) throw new HttpError(502, 'The plate generation returned nothing');

            // The plate is its own approved still: nothing else will ever be
            // approved on a reference shot, and animate would reject it
            // otherwise.
            await approveStill(plate.asset_id);
            const reference = await createReferenceAsset({
                projectId: project.id,
                assetId: plate.asset_id,
                role,
                label,
                notes: str(input, 'notes') ?? description,
                metadata: { generated: true, shot_id: result.shot.id },
            });

            return {
                reference_id: reference.id,
                asset_id: plate.asset_id,
                url: plate.url,
                role,
                label,
                alternates: result.stills.slice(1),
            };
        }),
    );

    router.delete(
        '/references/:id',
        route('delete reference', async (req) => {
            await deleteReferenceAsset(param(req, 'id'));
            return { ok: true };
        }),
    );

    // -------------------------------------------------------------- assist

    /**
     * The wizard's writing steps, run against Grok.
     *
     * One endpoint with a `mode` rather than four, because the client treats
     * them as one thing: "ask the model for the next artefact".
     */
    router.post(
        '/assist',
        route('assist', async (req, res) => {
            res.setTimeout(GENERATE_TIMEOUT_MS);
            const input = body(req);
            const mode = requiredStr(input, 'mode');

            switch (mode) {
                case 'pitch':
                    return { pitches: await pitchIdeas(str(input, 'topic')) };
                case 'story':
                    return writeStory({
                        topic: str(input, 'topic'),
                        draft: str(input, 'draft'),
                        notes: str(input, 'notes'),
                    });
                case 'shots':
                    return {
                        shots: await planShots({
                            storyText: requiredStr(input, 'story_text'),
                            count: int(input, 'count', { min: 2, max: 20, fallback: 8 }),
                            referenceLabels: strList(input, 'reference_labels'),
                        }),
                    };
                case 'references': {
                    const shots = input.shots;
                    if (!Array.isArray(shots) || shots.length === 0) {
                        bad('references mode needs the planned shots');
                    }
                    return {
                        references: await planReferences(
                            shots as Parameters<typeof planReferences>[0],
                        ),
                    };
                }
                default:
                    return bad(`Unknown assist mode "${mode}"`);
            }
        }),
    );

    return router;
}
