import { randomUUID } from 'node:crypto';
import {
    approveStillExclusively,
    createAsset,
    createJob,
    createShot,
    getAsset,
    getJob,
    getProject,
    getShot,
    getStoryManifest,
    listAssetsForShots,
    listJobsForShots,
    listReferenceAssets,
    listShots,
    nextShotNumber,
    setAssetCritique,
    setShotStatus,
    updateJob,
    type AssetRow,
    type JobRow,
    type ProjectRow,
    type ReferenceAssetRow,
    type ShotRow,
} from './db.js';
import { buildPrompt, getConfig } from './config.js';
import { errorMessage, log } from './logger.js';
import { assetPath, persistFromUrl } from './storage.js';
import { critiqueStill, type Critique } from './vision.js';
import { editImage, generateImage, submitVideo } from './xai.js';

/**
 * The generation pipeline, expressed as plain functions over plain data.
 *
 * These operations used to live inside the MCP tool handlers. The web UI needs
 * exactly the same behaviour — same style block, same reference handling, same
 * ordering of persist-then-report — so it lives here and both surfaces call it.
 * The alternative was a second implementation of "generate a still" that would
 * drift from the first the moment either changed.
 *
 * Nothing in this module knows about MCP or HTTP. Callers handle their own
 * presentation: tool results get image blocks and hints, the API gets JSON.
 */

/**
 * A lookup that found nothing.
 *
 * Distinguished from an ordinary failure so the HTTP layer can answer 404
 * rather than 500 — "you asked for a shot that does not exist" is the client's
 * problem to fix, and reporting it as a server error sends people reading logs
 * in the wrong direction. The MCP tools flatten it back to a plain message,
 * which is all a tool result can carry anyway.
 */
export class NotFound extends Error {}

/** Extension of an upstream URL, for building a storage path. */
export function extOf(url: string, fallback: string): string {
    const match = /\.([a-z0-9]{3,4})(?:\?|#|$)/i.exec(url);
    return (match?.[1] ?? fallback).toLowerCase();
}

// ------------------------------------------------------------------- stills

export interface GeneratedStill {
    asset_id: string;
    url: string;
    critique?: Critique | { error: string };
}

export interface GenerateStillsInput {
    projectId: string;
    /** Generate onto an existing shot instead of creating one. */
    shotId?: string | undefined;
    shotNumber?: number | undefined;
    description: string;
    count: number;
    paletteOverride?: string | undefined;
    referenceAssetIds?: string[] | undefined;
    /** Run the server-side vision pass. Honours ENABLE_VISION_CRITIQUE too. */
    critique?: boolean | undefined;
}

export interface GenerateStillsResult {
    shot: ShotRow;
    stills: GeneratedStill[];
    /** One message per generation that failed. Partial success is normal. */
    failures: string[];
}

/**
 * Resolve reference asset ids to our own public URLs.
 *
 * Deliberately eager and strict: doing this before the shot is created means a
 * bad id fails cleanly rather than leaving an empty shot behind, and refusing
 * video assets keeps the caller from passing an mp4 where a frame was meant.
 */
async function resolveReferenceUrls(assetIds: string[]): Promise<string[]> {
    const urls: string[] = [];
    for (const id of assetIds) {
        const asset = await getAsset(id);
        if (!asset) throw new NotFound(`No asset with id ${id} to use as a reference`);
        if (asset.kind === 'video') {
            throw new Error(
                `Asset ${id} is a video and cannot be a reference. Use its first_frame ` +
                    'or last_frame asset instead.',
            );
        }
        // Our own storage URL — never an expiring upstream one.
        urls.push(asset.public_url);
    }
    return urls;
}

/**
 * Generate still variations for a shot and persist every one of them.
 *
 * Generations run in parallel and partial failure is tolerated: some stills
 * beat none, and the caller is told how many landed. Only a total wipeout
 * marks the shot failed.
 */
export async function generateStills(input: GenerateStillsInput): Promise<GenerateStillsResult> {
    const referenceUrls = await resolveReferenceUrls(input.referenceAssetIds ?? []);

    let shot: ShotRow;
    if (input.shotId) {
        const existing = await getShot(input.shotId);
        if (!existing) throw new NotFound(`No shot with id ${input.shotId}`);
        if (existing.project_id !== input.projectId) {
            throw new Error(`Shot ${existing.id} does not belong to project ${input.projectId}`);
        }
        shot = existing;
    } else {
        shot = await createShot({
            projectId: input.projectId,
            shotNumber: input.shotNumber ?? (await nextShotNumber(input.projectId)),
            description: input.description,
        });
    }

    const prompt = buildPrompt({
        shotDescription: input.description,
        paletteOverride: input.paletteOverride,
        hasReferences: referenceUrls.length > 0,
    });

    const results = await Promise.allSettled(
        Array.from({ length: input.count }, async () => {
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

    const stills: GeneratedStill[] = results
        .filter((r): r is PromiseFulfilledResult<AssetRow> => r.status === 'fulfilled')
        .map((r) => ({ asset_id: r.value.id, url: r.value.public_url }));
    const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => errorMessage(r.reason));

    if (stills.length === 0) {
        // Only mark a brand-new shot failed. A regeneration that produced
        // nothing must not destroy the status of a shot that already has an
        // approved plate.
        if (!input.shotId) await setShotStatus(shot.id, 'failed');
        throw new Error(`All ${input.count} image generations failed: ${failures[0] ?? 'unknown'}`);
    }

    if (!input.shotId || shot.status === 'still_pending' || shot.status === 'failed') {
        await setShotStatus(shot.id, 'still_ready');
    }

    if (getConfig().enableVisionCritique && input.critique !== false) {
        await Promise.all(
            stills.map(async (still) => {
                const verdict = await critiqueStill(
                    still.url,
                    input.description,
                    input.paletteOverride,
                );
                still.critique = verdict;
                // Persist so a resumed session, or the UI, can show why a
                // variation was judged bad. Never let this fail the generation.
                await setAssetCritique(still.asset_id, verdict as unknown as Record<string, unknown>)
                    .catch((err) =>
                        log.warn('storing critique failed', { error: errorMessage(err) }),
                    );
            }),
        );
    }

    return { shot, stills, failures };
}

// ------------------------------------------------------------------ approve

export interface ApproveResult {
    asset_id: string;
    shot_id: string;
    url: string;
}

/** Mark one still as its shot's approved plate, un-approving every sibling. */
export async function approveStill(assetId: string): Promise<ApproveResult> {
    const asset = await getAsset(assetId);
    if (!asset) throw new NotFound(`No asset with id ${assetId}`);
    if (asset.kind !== 'still') throw new Error(`Asset ${assetId} is a ${asset.kind}, not a still`);

    await approveStillExclusively(asset);
    await setShotStatus(asset.shot_id, 'approved');

    return { asset_id: asset.id, shot_id: asset.shot_id, url: asset.public_url };
}

// ------------------------------------------------------------------ animate

export interface AnimateResult {
    job_id: string;
    status: 'submitted';
    shot_id: string;
    duration: number;
    model: string;
    resolution: string;
}

/**
 * Submit an approved still for image-to-video generation.
 *
 * Returns as soon as upstream accepts the job — video generation runs for
 * minutes and the worker owns the rest of its lifecycle.
 */
export async function animateStill(input: {
    assetId: string;
    motionInstruction: string;
    duration: number;
    paletteOverride?: string | undefined;
}): Promise<AnimateResult> {
    const asset = await getAsset(input.assetId);
    if (!asset) throw new NotFound(`No asset with id ${input.assetId}`);
    if (asset.kind !== 'still') {
        throw new Error(`Asset ${input.assetId} is a ${asset.kind}, not a still`);
    }
    if (!asset.approved) {
        throw new Error(`Still ${input.assetId} is not approved. Approve it first.`);
    }

    const shot = await getShot(asset.shot_id);
    if (!shot) throw new NotFound(`Shot ${asset.shot_id} no longer exists`);

    const prompt = buildPrompt({
        shotDescription: shot.description,
        motionInstruction: input.motionInstruction,
        paletteOverride: input.paletteOverride,
    });

    // We hand xAI our own storage URL, never an upstream one.
    const requestId = await submitVideo({
        prompt,
        imageUrl: asset.public_url,
        duration: input.duration,
    });

    const job = await createJob({
        shotId: shot.id,
        sourceAssetId: asset.id,
        upstreamJob: requestId,
        motionInstruction: input.motionInstruction,
        duration: input.duration,
    });
    await setShotStatus(shot.id, 'animating');

    log.info('animate submitted', { jobId: job.id, shotId: shot.id, duration: input.duration });
    const cfg = getConfig();
    return {
        job_id: job.id,
        status: 'submitted',
        shot_id: shot.id,
        duration: input.duration,
        model: cfg.videoModel,
        resolution: cfg.videoResolution,
    };
}

/**
 * Resubmit a failed or expired job.
 *
 * A new job row rather than a mutation of the old one: the failure and its
 * error message are part of the project's history, and the Jobs tab shows both.
 */
export async function retryJob(jobId: string): Promise<AnimateResult> {
    const job = await getJob(jobId);
    if (!job) throw new NotFound(`No job with id ${jobId}`);
    if (job.status === 'submitted' || job.status === 'processing') {
        throw new Error(`Job ${jobId} is still running — cancel it before resubmitting`);
    }
    return animateStill({
        assetId: job.source_asset_id,
        motionInstruction: job.motion_instruction,
        duration: job.duration,
    });
}

/**
 * Stop tracking a running job.
 *
 * xAI exposes no cancel endpoint, so this is local only: the generation
 * upstream still completes and is still billed. What it buys is a worker that
 * stops polling and a shot released from `animating`.
 */
export async function cancelJob(jobId: string): Promise<JobRow> {
    const job = await getJob(jobId);
    if (!job) throw new NotFound(`No job with id ${jobId}`);
    if (job.status === 'done') throw new Error(`Job ${jobId} already finished`);

    const updated = await updateJob(jobId, {
        status: 'expired',
        error: 'Cancelled from the studio UI. The upstream generation was not recalled.',
    });
    const shot = await getShot(job.shot_id);
    if (shot?.status === 'animating') {
        // Back to whatever it was before the job: an approved plate is still
        // approved, so the shot is immediately re-animatable.
        await setShotStatus(job.shot_id, 'approved');
    }
    return updated;
}

// ----------------------------------------------------------------- snapshot

export interface ShotView {
    shot_id: string;
    shot_number: number;
    description: string;
    status: ShotRow['status'];
    created_at: string;
    stills: Array<{
        asset_id: string;
        url: string;
        approved: boolean;
        critique: Record<string, unknown> | null;
        created_at: string;
    }>;
    approved_asset_id: string | null;
    video_url: string | null;
    first_frame_url: string | null;
    last_frame_url: string | null;
    job: { job_id: string; status: JobRow['status']; error: string | null } | null;
    /** Planned motion from the manifest, falling back to the last job's. */
    motion_instruction: string | null;
    camera_motion: string | null;
    story_beat: string | null;
    /**
     * True when this shot exists only to hold a reference plate.
     *
     * Reference assets have to hang off a shot — that is how the assets table
     * is keyed — so importing a character plate creates one. They are real
     * rows, but they are not beats of the film, and listing them among the
     * shots makes an 8-shot short look like a 13-shot one.
     */
    is_reference: boolean;
}

export interface JobView {
    job_id: string;
    shot_id: string;
    shot_number: number | null;
    status: JobRow['status'];
    motion_instruction: string;
    duration: number;
    error: string | null;
    attempts: number;
    created_at: string;
    updated_at: string;
    video_url: string | null;
}

export interface ReferenceView {
    reference_id: string;
    asset_id: string;
    role: string;
    label: string;
    notes: string | null;
    url: string | null;
    shot_id: string | null;
    created_at: string;
}

export interface ProjectSnapshot {
    project: { id: string; name: string; created_at: string };
    title: string | null;
    story_text: string | null;
    logline: string | null;
    manifest: Record<string, unknown> | null;
    manifest_updated_at: string | null;
    shots: ShotView[];
    jobs: JobView[];
    references: ReferenceView[];
    counts: { shots: number; done: number; approved: number; open_jobs: number };
}

/** Entries in `manifest.shots`, as written by the story skill. */
interface ManifestShot {
    shot_number?: number;
    story_beat?: string;
    visual_description?: string;
    camera_motion?: string;
    motion_instruction?: string;
    continuity_notes?: string;
    needed_references?: string[];
}

function manifestShots(manifest: Record<string, unknown> | null): Map<number, ManifestShot> {
    const raw = manifest?.shots;
    const map = new Map<number, ManifestShot>();
    if (!Array.isArray(raw)) return map;
    for (const [index, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object') continue;
        const shot = entry as ManifestShot;
        map.set(Number(shot.shot_number ?? index + 1), shot);
    }
    return map;
}

function firstSentence(text: string | null): string | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const match = /^[\s\S]{20,240}?[.!?](\s|$)/.exec(trimmed);
    return (match ? match[0] : trimmed.slice(0, 200)).trim();
}

/**
 * Everything the studio needs to draw one project, in a single round trip.
 *
 * The UI polls this while jobs run, so it is one query per table rather than
 * per shot.
 */
export async function projectSnapshot(project: ProjectRow): Promise<ProjectSnapshot> {
    const [shots, manifestRow, refRows] = await Promise.all([
        listShots(project.id),
        getStoryManifest(project.id),
        listReferenceAssets({ projectId: project.id }),
    ]);
    const shotIds = shots.map((s) => s.id);
    const [assets, jobRows] = await Promise.all([
        listAssetsForShots(shotIds),
        listJobsForShots(shotIds),
    ]);

    const assetsByShot = new Map<string, AssetRow[]>();
    for (const asset of assets) {
        const list = assetsByShot.get(asset.shot_id) ?? [];
        list.push(asset);
        assetsByShot.set(asset.shot_id, list);
    }
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const shotNumberById = new Map(shots.map((s) => [s.id, s.shot_number]));

    // listJobsForShots is newest first, so the first hit per shot is the latest.
    const latestJobByShot = new Map<string, JobRow>();
    for (const job of jobRows) {
        if (!latestJobByShot.has(job.shot_id)) latestJobByShot.set(job.shot_id, job);
    }

    const manifest = (manifestRow?.manifest as Record<string, unknown> | undefined) ?? null;
    const planned = manifestShots(manifest);
    const referenceShotIds = new Set(
        refRows.map((ref) => assetById.get(ref.asset_id)?.shot_id).filter(Boolean) as string[],
    );

    const shotViews: ShotView[] = shots.map((shot) => {
        const own = assetsByShot.get(shot.id) ?? [];
        const stills = own.filter((a) => a.kind === 'still');
        const approved = stills.find((a) => a.approved);
        const newest = (kind: AssetRow['kind']): AssetRow | undefined =>
            own.filter((a) => a.kind === kind).at(-1);
        const job = latestJobByShot.get(shot.id);
        const plan = planned.get(shot.shot_number);

        return {
            shot_id: shot.id,
            shot_number: shot.shot_number,
            description: shot.description,
            status: shot.status,
            created_at: shot.created_at,
            stills: stills.map((s) => ({
                asset_id: s.id,
                url: s.public_url,
                approved: s.approved,
                critique: s.critique,
                created_at: s.created_at,
            })),
            approved_asset_id: approved?.id ?? null,
            video_url: newest('video')?.public_url ?? null,
            first_frame_url: newest('first_frame')?.public_url ?? null,
            last_frame_url: newest('last_frame')?.public_url ?? null,
            job: job ? { job_id: job.id, status: job.status, error: job.error } : null,
            motion_instruction: plan?.motion_instruction ?? job?.motion_instruction ?? null,
            camera_motion: plan?.camera_motion ?? null,
            story_beat: plan?.story_beat ?? null,
            is_reference: referenceShotIds.has(shot.id),
        };
    });

    const jobViews: JobView[] = jobRows.map((job) => ({
        job_id: job.id,
        shot_id: job.shot_id,
        shot_number: shotNumberById.get(job.shot_id) ?? null,
        status: job.status,
        motion_instruction: job.motion_instruction,
        duration: job.duration,
        error: job.error,
        attempts: job.attempts,
        created_at: job.created_at,
        updated_at: job.updated_at,
        video_url: job.video_asset_id
            ? (assetById.get(job.video_asset_id)?.public_url ?? null)
            : null,
    }));

    const references: ReferenceView[] = refRows.map((ref: ReferenceAssetRow) => {
        const asset = assetById.get(ref.asset_id);
        return {
            reference_id: ref.id,
            asset_id: ref.asset_id,
            role: ref.role,
            label: ref.label,
            notes: ref.notes,
            url: asset?.public_url ?? null,
            shot_id: asset?.shot_id ?? null,
            created_at: ref.created_at,
        };
    });

    const storyText = manifestRow?.story_text ?? null;
    const logline =
        typeof manifest?.logline === 'string' && manifest.logline.trim()
            ? manifest.logline.trim()
            : firstSentence(storyText);

    return {
        project: { id: project.id, name: project.name, created_at: project.created_at },
        title: manifestRow?.title ?? null,
        story_text: storyText,
        logline,
        manifest,
        manifest_updated_at: manifestRow?.updated_at ?? null,
        shots: shotViews,
        jobs: jobViews,
        references,
        // Counts describe the film, so reference plates are excluded — an
        // 8-shot short with 5 character plates is still an 8-shot short.
        counts: (() => {
            const real = shotViews.filter((s) => !s.is_reference);
            return {
                shots: real.length,
                done: real.filter((s) => s.status === 'done').length,
                approved: real.filter((s) => s.status === 'approved').length,
                open_jobs: jobRows.filter(
                    (j) => j.status === 'submitted' || j.status === 'processing',
                ).length,
            };
        })(),
    };
}

/**
 * References the reference index doesn't cover: the reference assets a
 * reference-tagged asset lives on. Used when the caller passed labels rather
 * than asset ids.
 */
export async function referenceAssetIdsForLabels(
    projectId: string,
    labels: string[],
): Promise<string[]> {
    if (labels.length === 0) return [];
    const refs = await listReferenceAssets({ projectId });
    const ids: string[] = [];
    for (const label of labels) {
        const needle = label.trim().toLowerCase();
        const match = refs.find(
            (r) => r.label.toLowerCase() === needle || r.label.toLowerCase().includes(needle),
        );
        if (match) ids.push(match.asset_id);
    }
    return [...new Set(ids)];
}

/** Look up a project by id, throwing the message the API should surface. */
export async function requireProject(projectId: string): Promise<ProjectRow> {
    const project = await getProject(projectId);
    if (!project) throw new NotFound(`No project with id ${projectId}`);
    return project;
}
