/** Builds a contact sheet from stills already in storage. Free — no generation. */
import { writeFile } from 'node:fs/promises';
import { db } from '../src/db.js';
import { makeContactSheet } from '../src/frames.js';
import { downloadWithRetry } from '../src/storage.js';

const res = await db()
    .from('assets')
    .select('public_url, shot_id')
    .eq('kind', 'still')
    .order('created_at', { ascending: true })
    .limit(4);
if (res.error) throw new Error(res.error.message);

const urls = (res.data ?? []).map((r: { public_url: string }) => r.public_url);
console.log(`Tiling ${urls.length} stills…`);

const originals = await Promise.all(urls.map((u) => downloadWithRetry(u, 2)));
const before = originals.reduce((n, b) => n + b.byteLength, 0);

const t0 = Date.now();
const sheet = await makeContactSheet(originals);
const b64 = Buffer.from(sheet.data).toString('base64');

await writeFile('sheet-test.jpg', sheet.data);

console.log(`  source:  ${urls.length} images, ${Math.round(before / 1024)}kB total`);
console.log(`  sheet:   ${Math.round(sheet.data.byteLength / 1024)}kB, base64 ${Math.round(b64.length / 1024)}kB`);
console.log(`  slots:   ${urls.length} image blocks -> 1`);
console.log(`  time:    ${Date.now() - t0}ms`);
console.log('  wrote sheet-test.jpg');
