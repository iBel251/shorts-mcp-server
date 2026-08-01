/**
 * Probes POST /v1/images/edits to pin down the request shape.
 *
 * The single-image body is documented; the multi-image one is not, so we try
 * the plausible shapes and see which the API accepts. Rejected requests are
 * free — only a 200 bills (~$0.05) — and we stop at the first success.
 *
 * Run with: npx tsx scripts/probe-edits.ts
 */
import { getConfig } from '../src/config.js';
import { db } from '../src/db.js';

const cfg = getConfig();

const res = await db()
    .from('assets')
    .select('public_url')
    .eq('kind', 'still')
    .order('created_at', { ascending: false })
    .limit(2);
if (res.error) throw new Error(res.error.message);
const urls = (res.data ?? []).map((r: { public_url: string }) => r.public_url);
if (urls.length < 2) throw new Error('need at least 2 stored stills to probe with');
console.log(`Using ${urls.length} stored stills as references.\n`);

const PROMPT =
    'Keep the subject identical. Flat 2D animated illustration: thick black outlines of ' +
    'even weight, flat colour fills, muted desaturated palette.';

async function attempt(label: string, body: Record<string, unknown>): Promise<boolean> {
    process.stdout.write(`  ${label.padEnd(34)} `);
    try {
        const r = await fetch(`${cfg.xaiBaseUrl}/images/edits`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cfg.xaiApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180_000),
        });
        const text = await r.text();
        if (r.ok) {
            let shape = 'unknown';
            try {
                const json = JSON.parse(text);
                shape = json.data?.[0]?.url
                    ? 'data[0].url'
                    : json.url
                      ? 'url'
                      : Object.keys(json).join(',');
            } catch {
                /* not json */
            }
            console.log(`ACCEPTED (200)  response shape: ${shape}`);
            return true;
        }
        // Trim the error so the useful part is visible.
        let msg = text.slice(0, 180).replace(/\s+/g, ' ');
        console.log(`rejected ${r.status}  ${msg}`);
        return false;
    } catch (err) {
        console.log(`error: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`);
        return false;
    }
}

console.log('--- single image (documented shape) ---');
const singleOk = await attempt('image:{url,type}', {
    model: cfg.imageModel,
    prompt: PROMPT,
    image: { url: urls[0], type: 'image_url' },
});

console.log('\n--- multi-image candidates (stops at first success) ---');
const candidates: Array<[string, Record<string, unknown>]> = [
    [
        'image: [ {url,type}, ... ]',
        {
            model: cfg.imageModel,
            prompt: PROMPT,
            image: urls.map((u) => ({ url: u, type: 'image_url' })),
        },
    ],
    [
        'images: [ {url,type}, ... ]',
        {
            model: cfg.imageModel,
            prompt: PROMPT,
            images: urls.map((u) => ({ url: u, type: 'image_url' })),
        },
    ],
    [
        'image: [ "url", ... ]',
        { model: cfg.imageModel, prompt: PROMPT, image: urls },
    ],
];

let multiShape: string | undefined;
for (const [label, body] of candidates) {
    if (await attempt(label, body)) {
        multiShape = label;
        break;
    }
}

console.log('\n=== result ===');
console.log(`single image: ${singleOk ? 'works' : 'FAILED'}`);
console.log(`multi image : ${multiShape ?? 'no candidate accepted — single-reference only'}`);
