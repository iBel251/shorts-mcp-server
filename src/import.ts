import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
    createAsset,
    createShot,
    getShot,
    nextShotNumber,
    setShotStatus,
    type AssetRow,
} from './db.js';
import { errorMessage } from './logger.js';
import { assetPath, putBuffer } from './storage.js';

/**
 * Importing externally generated images.
 *
 * This is the path an image takes when it was made somewhere else — ChatGPT,
 * Higgsfield, a file on disk — and needs to become a first-class asset of a
 * shot. It lives apart from tools.ts because the studio UI's upload button and
 * the `import_image` / `import_reference_image` tools must apply exactly the
 * same validation. A second, laxer copy of the SSRF checks behind a browser
 * form would be a hole in the same server.
 *
 * Three things are enforced here, in order: the URL is publicly reachable and
 * not pointed at our own network, the payload is within a sane size, and the
 * bytes really are a PNG/JPEG/WebP rather than something merely labelled as one.
 */

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

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

export interface InspectedImage {
    mimeType: string;
    ext: 'png' | 'jpg' | 'webp';
    width?: number;
    height?: number;
}

export function inspectImage(bytes: Uint8Array, declared?: string): InspectedImage {
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
        `Imported image must be PNG, JPEG or WebP${declared ? `; received ${declared}` : ''}`,
    );
}

export type ImportArgs = {
    image_url?: string | undefined;
    image_base64?: string | undefined;
    image_file?: { data: string; mime_type?: string | undefined; filename?: string | undefined };
};

export interface LoadedImage {
    bytes: Uint8Array;
    contentType?: string;
    source?: string;
    image: InspectedImage;
}

export async function loadImportedImage(args: ImportArgs): Promise<LoadedImage> {
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

export interface ImportedStill {
    asset: AssetRow;
    shotId: string;
    shotNumber: number;
    publicUrl: string;
    width?: number;
    height?: number;
    mimeType: string;
    source?: string;
}

/** Persist an already-loaded image as a still on a new or existing shot. */
export async function importStillAsset(input: {
    projectId: string;
    shotId?: string | undefined;
    shotNumber?: number | undefined;
    description: string;
    imported: LoadedImage;
}): Promise<ImportedStill> {
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
