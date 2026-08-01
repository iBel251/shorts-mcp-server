import { getConfig } from './config.js';
import { checkFfmpeg } from './frames.js';
import { errorMessage, log } from './logger.js';
import { closeAllSessions, createApp } from './server.js';
import { ensureBucket } from './storage.js';
import { startWorker, stopWorker } from './worker.js';

async function main(): Promise<void> {
    // Validate config first — fail loudly at boot rather than on the first tool call.
    const cfg = getConfig();

    const ffmpegVersion = await checkFfmpeg().catch((err) => {
        throw new Error(
            `ffmpeg is not usable, so first/last frame extraction would fail: ${errorMessage(err)}`,
        );
    });
    await ensureBucket();

    const app = createApp();
    const server = app.listen(cfg.port, () => {
        log.info('shorts mcp server listening', {
            port: cfg.port,
            videoModel: cfg.videoModel,
            resolution: cfg.videoResolution,
            bucket: cfg.supabaseBucket,
            ffmpeg: ffmpegVersion,
        });
    });

    // Video jobs are long; do not let a slow client hold the process open, but
    // do not cut off an in-progress stream either.
    server.headersTimeout = 65_000;
    server.requestTimeout = 0;

    // The worker rebuilds its queue from Postgres, so this immediately resumes
    // any job that was in flight when the process last died.
    startWorker();

    const shutdown = (signal: string) => {
        log.info('shutting down', { signal });
        stopWorker();
        void closeAllSessions().finally(() => {
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 5000).unref();
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason) => {
        log.error('unhandled rejection', { error: errorMessage(reason) });
    });
}

main().catch((err) => {
    log.error('fatal startup error', { error: errorMessage(err) });
    process.exit(1);
});
