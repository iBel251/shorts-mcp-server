/**
 * Exercises the vision pass against stills already in storage.
 *
 * Costs a few tenths of a cent in vision tokens; generates nothing. The point
 * is to check the critique is discriminating rather than rubber-stamping —
 * a pass that says "accept" to everything is worse than none, because it
 * launders a guess as a verification.
 */
import { db } from '../src/db.js';
import { critiqueDrift, critiqueStill } from '../src/vision.js';

const stills = await db()
    .from('assets')
    .select('id, public_url, shot_id')
    .eq('kind', 'still')
    .order('created_at', { ascending: true })
    .limit(4);
if (stills.error) throw new Error(stills.error.message);

const shot = await db()
    .from('shots')
    .select('description')
    .eq('id', (stills.data ?? [])[0]!.shot_id)
    .single();
const description = (shot.data as { description: string }).description;

console.log(`Shot: "${description.slice(0, 70)}…"\n`);

const t0 = Date.now();
const results = await Promise.all(
    (stills.data ?? []).map(async (a: { id: string; public_url: string }) => ({
        id: a.id.slice(0, 8),
        critique: await critiqueStill(a.public_url, description),
    })),
);
console.log(`4 critiques in ${Date.now() - t0}ms\n`);

for (const { id, critique } of results) {
    if ('error' in critique) {
        console.log(`  ${id}  ERROR ${critique.error}`);
        continue;
    }
    console.log(
        `  ${id}  ${critique.verdict.toUpperCase().padEnd(10)} ` +
            `style=${critique.style_ok ? 'ok' : 'BAD'} ` +
            `palette=${critique.palette_ok ? 'ok' : 'BAD'} ` +
            `framing=${critique.framing_ok ? 'ok' : 'BAD'} ` +
            `people=${critique.people} ` +
            `text=${critique.visible_text ? 'YES' : 'no'} ` +
            `faces=${critique.faces_to_camera ? 'YES' : 'no'}`,
    );
    console.log(`            ${critique.reason}`);
    if (critique.anatomy_issues) console.log(`            anatomy: ${critique.anatomy_issues}`);
    if (critique.fix_suggestion) console.log(`            fix: ${critique.fix_suggestion}`);
}

// A critique that accepts everything is not a critique.
const verdicts = results
    .map((r) => ('error' in r.critique ? 'error' : r.critique.verdict))
    .filter((v) => v !== 'error');
console.log(
    `\n  verdicts: ${verdicts.join(', ')}` +
        (new Set(verdicts).size === 1
            ? '  <- all identical; check it is discriminating, not rubber-stamping'
            : '  <- discriminating'),
);

// --- drift comparison on a finished clip -------------------------------------
const frames = await db()
    .from('assets')
    .select('kind, public_url, shot_id')
    .in('kind', ['first_frame', 'last_frame'])
    .order('created_at', { ascending: false })
    .limit(2);
if (frames.error) throw new Error(frames.error.message);

const first = (frames.data ?? []).find((f) => f.kind === 'first_frame');
const last = (frames.data ?? []).find((f) => f.kind === 'last_frame');
if (first && last) {
    const shotRow = await db()
        .from('shots')
        .select('description')
        .eq('id', first.shot_id)
        .single();
    console.log('\n--- drift report ---');
    const t1 = Date.now();
    const drift = await critiqueDrift(
        first.public_url,
        last.public_url,
        (shotRow.data as { description: string }).description,
    );
    console.log(`  (${Date.now() - t1}ms)`, JSON.stringify(drift, null, 2));
}
