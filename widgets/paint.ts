/**
 * Put a base64 image on screen inside a sandboxed iframe, whatever the CSP.
 *
 * Three escalating strategies, because each can be blocked independently:
 *
 *   1. `<img src="data:...">` — no network request, but a CSP `img-src` that
 *      lists only domains blocks `data:` too.
 *   2. `<img src="blob:...">` — a different CSP source expression, sometimes
 *      permitted where `data:` is not.
 *   3. `createImageBitmap(blob)` painted to a `<canvas>` — this one takes the
 *      decoded bytes directly and never resolves a URL, so `img-src` does not
 *      apply to it at all. It is the escape hatch when the first two fail.
 *
 * Strategy 3 alone would be enough in principle, but the first two keep the
 * common case as a plain image element: cheaper, and it scales and prints the
 * way an image should.
 */

export function base64ToBlob(base64: string, mimeType: string): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}

function tryImage(src: string, className: string, alt: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.className = className;
        img.alt = alt;
        img.addEventListener('load', () => resolve(img));
        img.addEventListener('error', () => reject(new Error('blocked')));
        img.src = src;
    });
}

/**
 * Render base64 image data into `container`, replacing its contents.
 * Resolves to the strategy that worked, for diagnostics.
 */
export async function paintImage(
    container: HTMLElement,
    base64: string,
    mimeType: string,
    alt = '',
    className = 'sheet',
): Promise<'data' | 'blob' | 'canvas' | 'failed'> {
    // 1. data: URI
    try {
        const img = await tryImage(`data:${mimeType};base64,${base64}`, className, alt);
        container.replaceChildren(img);
        return 'data';
    } catch {
        /* fall through */
    }

    const blob = base64ToBlob(base64, mimeType);

    // 2. blob: URI
    const url = URL.createObjectURL(blob);
    try {
        const img = await tryImage(url, className, alt);
        container.replaceChildren(img);
        // Left alive deliberately: revoking would blank the element still using it.
        return 'blob';
    } catch {
        URL.revokeObjectURL(url);
    }

    // 3. Decoded bytes straight onto a canvas — no URL, so nothing for
    //    img-src to govern.
    try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.className = className;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        container.replaceChildren(canvas);
        return 'canvas';
    } catch {
        return 'failed';
    }
}
