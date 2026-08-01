/**
 * Live connectivity preflight. Verifies Supabase reads/writes, bucket
 * creation, storage upload, and xAI credentials — without generating anything
 * billable. Run before the paid acceptance tests.
 */
import { getConfig } from '../src/config.js';
import { db, getOrCreateDefaultProject } from '../src/db.js';
import { checkFfmpeg } from '../src/frames.js';
import { ensureBucket, putBuffer } from '../src/storage.js';

const cfg = getConfig();
let failed = false;

async function step(name: string, fn: () => Promise<string>): Promise<void> {
    try {
        console.log(`  ok  ${name} — ${await fn()}`);
    } catch (err) {
        failed = true;
        console.error(`  FAIL ${name} — ${err instanceof Error ? err.message : String(err)}`);
    }
}

await step('ffmpeg', async () => (await checkFfmpeg()).slice(0, 40));

await step('supabase: read tables', async () => {
    for (const table of ['projects', 'shots', 'assets', 'jobs']) {
        const { error } = await db().from(table).select('id').limit(1);
        if (error) throw new Error(`${table}: ${error.message}`);
    }
    return 'projects, shots, assets, jobs all readable';
});

await step('supabase: write + default project', async () => {
    const project = await getOrCreateDefaultProject();
    return `default project ${project.id}`;
});

await step('storage: bucket + upload + public fetch', async () => {
    await ensureBucket();
    const probe = new TextEncoder().encode(`preflight ${new Date().toISOString()}`);
    const stored = await putBuffer('preflight/probe.txt', probe, 'text/plain');
    const res = await fetch(stored.publicUrl);
    if (!res.ok) throw new Error(`public URL returned HTTP ${res.status}`);
    const body = await res.text();
    if (!body.startsWith('preflight')) throw new Error('public URL served unexpected content');
    return `bucket "${cfg.supabaseBucket}" writable and publicly readable`;
});

// Auth-only check: hit a cheap endpoint to confirm the key is accepted.
// A 401/403 means bad credentials; anything else means the key works.
await step('xai: credentials accepted', async () => {
    const res = await fetch(`${cfg.xaiBaseUrl}/api-key`, {
        headers: { Authorization: `Bearer ${cfg.xaiApiKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) {
        throw new Error(`xAI rejected the key with HTTP ${res.status}`);
    }
    if (!res.ok) return `key accepted (probe endpoint returned ${res.status})`;
    const info = (await res.json()) as Record<string, unknown>;
    const bits = [
        info.name ? `name=${String(info.name)}` : null,
        Array.isArray(info.acls) ? `acls=${info.acls.length}` : null,
        info.api_key_blocked === true ? 'BLOCKED' : null,
        info.api_key_disabled === true ? 'DISABLED' : null,
    ].filter(Boolean);
    return bits.length > 0 ? bits.join(' ') : 'key valid';
});

console.log(failed ? '\nPreflight FAILED.' : '\nPreflight passed.');
process.exitCode = failed ? 1 : 0;
