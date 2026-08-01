import { getConfig } from './config.js';
import {
    createAsset,
    getJob,
    listOpenJobs,
    setShotStatus,
    updateJob,
    type JobRow,
} from './db.js';
import { extractFirstAndLastFrame } from './frames.js';
import { errorMessage, log } from './logger.js';
import { assetPath, downloadWithRetry, putBuffer } from './storage.js';
import { pollVideo } from './xai.js';

/**
 * Background worker for video jobs.
 *
 * Nothing about an in-flight job lives in memory. Every tick re-reads the open
 * jobs from Postgres, so killing the process mid-job loses nothing — on boot
 * the worker picks up exactly where it left off. This matters during
 * development in particular, where the server sits behind a tunnel that drops
 * frequently.
 *
 * `inFlight` below is only a same-process de-duplication guard, never a source
 * of truth: it stops one job being advanced twice concurrently by the timer
 * and by a lazy check_job poll.
 */

const inFlight = new Set<string>();
let timer: NodeJS.Timeout | undefined;
let stopped = false;

export function startWorker(): void {
    const cfg = getConfig();
    stopped = false;

    const tick = async () => {
        if (stopped) return;
        try {
            const open = await listOpenJobs();
            if (open.length > 0) {
                log.debug('worker tick', { open: open.length });
            }
            // Sequential: video jobs are slow and the download/ffmpeg stage is
            // heavy. There is no benefit to hammering them in parallel.
            for (const job of open) {
                if (stopped) break;
                await advanceJob(job).catch((err) => {
                    log.error('job advance failed', { jobId: job.id, error: errorMessage(err) });
                });
            }
        } catch (err) {
            log.error('worker tick failed', { error: errorMessage(err) });
        }
    };

    timer = setInterval(() => void tick(), cfg.jobPollIntervalMs);
    timer.unref?.();
    // Run one pass immediately so a restart resumes without waiting a full interval.
    void tick();
    log.info('job worker started', { intervalMs: cfg.jobPollIntervalMs });
}

export function stopWorker(): void {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
}

/**
 * Move a single job forward one step. Safe to call concurrently from the timer
 * and from `check_job`; the second caller is dropped by the in-flight guard.
 */
export async function advanceJob(job: JobRow): Promise<JobRow> {
    if (job.status === 'done' || job.status === 'failed' || job.status === 'expired') {
        return job;
    }
    if (inFlight.has(job.id)) return job;
    inFlight.add(job.id);
    try {
        return await processJob(job);
    } finally {
        inFlight.delete(job.id);
    }
}

/** Poll a job by id and advance it. Used by check_job for lazy progress. */
export async function advanceJobById(jobId: string): Promise<JobRow | null> {
    const job = await getJob(jobId);
    if (!job) return null;
    return advanceJob(job);
}

async function processJob(job: JobRow): Promise<JobRow> {
    const cfg = getConfig();

    if (Date.now() - new Date(job.created_at).getTime() > cfg.jobTimeoutMs) {
        log.warn('job timed out', { jobId: job.id });
        return failJob(job, `Job exceeded the ${Math.round(cfg.jobTimeoutMs / 60000)} minute timeout`);
    }
    if (!job.upstream_job) {
        return failJob(job, 'Job has no upstream request id');
    }

    const result = await pollVideo(job.upstream_job);

    if (result.status === 'pending') {
        if (job.status !== 'processing') {
            return updateJob(job.id, { status: 'processing', attempts: job.attempts + 1 });
        }
        return updateJob(job.id, { attempts: job.attempts + 1 });
    }

    if (result.status === 'failed' || result.status === 'expired') {
        log.warn('upstream job ended badly', { jobId: job.id, status: result.status });
        await setShotStatus(job.shot_id, 'failed');
        return updateJob(job.id, {
            status: result.status,
            error: result.error ?? 'Upstream job did not complete',
        });
    }

    // Done upstream. Persist everything before reporting done, so a client that
    // sees `done` can always trust the URLs it gets back.
    if (!result.videoUrl) {
        return failJob(job, 'Upstream reported done but returned no video URL');
    }

    log.info('job completed upstream, persisting', { jobId: job.id });
    try {
        return await finalizeJob(job, result.videoUrl);
    } catch (err) {
        // Persisting failed (network blip, ffmpeg). Leave the job open so the
        // next tick retries rather than burning the generation.
        log.error('finalize failed, will retry', { jobId: job.id, error: errorMessage(err) });
        return updateJob(job.id, {
            status: 'processing',
            attempts: job.attempts + 1,
            error: `Post-processing retry: ${errorMessage(err)}`,
        });
    }
}

async function finalizeJob(job: JobRow, videoUrl: string): Promise<JobRow> {
    const mp4 = await downloadWithRetry(videoUrl);
    const videoStored = await putBuffer(
        assetPath(job.shot_id, 'video', job.id, 'mp4'),
        mp4,
        'video/mp4',
    );
    const videoAsset = await createAsset({
        shotId: job.shot_id,
        kind: 'video',
        storagePath: videoStored.storagePath,
        publicUrl: videoStored.publicUrl,
        upstreamJob: job.upstream_job,
    });

    const frames = await extractFirstAndLastFrame(mp4);
    const [firstStored, lastStored] = await Promise.all([
        putBuffer(assetPath(job.shot_id, 'first_frame', job.id, 'png'), frames.firstFrame, 'image/png'),
        putBuffer(assetPath(job.shot_id, 'last_frame', job.id, 'png'), frames.lastFrame, 'image/png'),
    ]);
    const [firstAsset, lastAsset] = await Promise.all([
        createAsset({
            shotId: job.shot_id,
            kind: 'first_frame',
            storagePath: firstStored.storagePath,
            publicUrl: firstStored.publicUrl,
            upstreamJob: job.upstream_job,
        }),
        createAsset({
            shotId: job.shot_id,
            kind: 'last_frame',
            storagePath: lastStored.storagePath,
            publicUrl: lastStored.publicUrl,
            upstreamJob: job.upstream_job,
        }),
    ]);

    await setShotStatus(job.shot_id, 'done');
    const updated = await updateJob(job.id, {
        status: 'done',
        error: null,
        video_asset_id: videoAsset.id,
        first_frame_asset_id: firstAsset.id,
        last_frame_asset_id: lastAsset.id,
    });
    log.info('job done', { jobId: job.id, shotId: job.shot_id });
    return updated;
}

async function failJob(job: JobRow, error: string): Promise<JobRow> {
    await setShotStatus(job.shot_id, 'failed').catch(() => {});
    return updateJob(job.id, { status: 'failed', error });
}
