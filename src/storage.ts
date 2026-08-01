import { getConfig } from './config.js';
import { db } from './db.js';
import { log } from './logger.js';

/**
 * Every upstream URL is treated as ephemeral.
 *
 * The previous pipeline (Higgsfield) failed mid-project because upstream media
 * IDs expired and the style reference plates became unreachable, forcing a full
 * restart. So: nothing generated upstream is ever handed back to the client as
 * a canonical reference. It is downloaded and persisted to our own bucket
 * before the tool returns, and only our URL is served.
 */

let bucketReady: Promise<void> | undefined;

/** Create the storage bucket on first use. Idempotent, runs at most once. */
export function ensureBucket(): Promise<void> {
    if (!bucketReady) {
        bucketReady = (async () => {
            const cfg = getConfig();
            const { data, error } = await db().storage.getBucket(cfg.supabaseBucket);
            if (data && !error) return;

            const created = await db().storage.createBucket(cfg.supabaseBucket, {
                public: true,
            });
            // A concurrent boot may have won the race; that is fine.
            if (created.error && !/exist/i.test(created.error.message)) {
                throw new Error(
                    `Create storage bucket "${cfg.supabaseBucket}": ${created.error.message}`,
                );
            }
            log.info('storage bucket ready', { bucket: cfg.supabaseBucket });
        })().catch((err) => {
            bucketReady = undefined; // let the next call retry
            throw err;
        });
    }
    return bucketReady;
}

export interface StoredAsset {
    storagePath: string;
    publicUrl: string;
    bytes: number;
}

const CONTENT_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    mp4: 'video/mp4',
};

function contentTypeFor(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Upload bytes we already hold and return our own public URL. */
export async function putBuffer(
    storagePath: string,
    body: Uint8Array,
    contentType?: string,
): Promise<StoredAsset> {
    await ensureBucket();
    const cfg = getConfig();

    const upload = await db()
        .storage.from(cfg.supabaseBucket)
        .upload(storagePath, body, {
            contentType: contentType ?? contentTypeFor(storagePath),
            upsert: true,
        });
    if (upload.error) {
        throw new Error(`Upload ${storagePath}: ${upload.error.message}`);
    }

    const { data } = db().storage.from(cfg.supabaseBucket).getPublicUrl(storagePath);
    return { storagePath, publicUrl: data.publicUrl, bytes: body.byteLength };
}

/**
 * Fetch an upstream URL and persist it to our bucket. Retries transient
 * failures — losing an asset here means losing a paid generation.
 */
export async function persistFromUrl(
    sourceUrl: string,
    storagePath: string,
): Promise<StoredAsset> {
    const body = await downloadWithRetry(sourceUrl);
    const stored = await putBuffer(storagePath, body);
    log.info('asset persisted', { storagePath, bytes: stored.bytes });
    return stored;
}

export async function downloadWithRetry(url: string, attempts = 3): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
            if (!res.ok) {
                throw new Error(`Download failed with HTTP ${res.status} ${res.statusText}`);
            }
            return new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            lastError = err;
            if (attempt < attempts) {
                const backoff = 500 * 2 ** (attempt - 1);
                log.warn('download retry', { attempt, backoff });
                await new Promise((r) => setTimeout(r, backoff));
            }
        }
    }
    throw new Error(
        `Could not download upstream asset after ${attempts} attempts: ${
            lastError instanceof Error ? lastError.message : String(lastError)
        }`,
    );
}

/** Deterministic, collision-free object paths: shots/<shot_id>/<kind>-<id>.<ext> */
export function assetPath(shotId: string, kind: string, id: string, ext: string): string {
    return `shots/${shotId}/${kind}-${id}.${ext}`;
}
