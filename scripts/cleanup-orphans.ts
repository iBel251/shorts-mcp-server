/**
 * Removes abandoned shots and their assets, files included.
 *
 * Deleting shot rows cascades to asset rows but leaves the objects in Storage
 * behind, so files are removed first and explicitly.
 *
 * Safety: refuses to touch a shot that has an approved still or any job, and
 * prints the full plan before acting. Pass --apply to actually delete; without
 * it this is a dry run.
 *
 * Run with: npx tsx scripts/cleanup-orphans.ts [--apply]
 */
import { getConfig } from '../src/config.js';
import { db } from '../src/db.js';

const apply = process.argv.includes('--apply');
const cfg = getConfig();

interface ShotRow {
    id: string;
    shot_number: number;
    description: string;
    project_id: string;
}

/** Shots explicitly nominated as disposable. */
const shots = await db()
    .from('shots')
    .select('id, shot_number, description, project_id')
    .or(
        'description.like.A mid view of an abandoned apartment interior%,' +
            'description.like.The same man in the long coat now stands alon%',
    );
if (shots.error) throw new Error(shots.error.message);

const candidates = (shots.data ?? []) as ShotRow[];
if (candidates.length === 0) {
    console.log('Nothing to clean.');
    process.exit(0);
}

const ids = candidates.map((s) => s.id);

// Guard rails. Anything approved or animated is not disposable, whatever the
// description says.
const assets = await db()
    .from('assets')
    .select('id, shot_id, kind, storage_path, approved')
    .in('shot_id', ids);
if (assets.error) throw new Error(assets.error.message);

const jobs = await db().from('jobs').select('id, shot_id').in('shot_id', ids);
if (jobs.error) throw new Error(jobs.error.message);

const protectedShots = new Set<string>();
for (const a of assets.data ?? []) if (a.approved) protectedShots.add(a.shot_id);
for (const j of jobs.data ?? []) protectedShots.add(j.shot_id);

const doomed = candidates.filter((s) => !protectedShots.has(s.id));
const spared = candidates.filter((s) => protectedShots.has(s.id));

console.log(`\n${apply ? 'DELETING' : 'DRY RUN — would delete'}:\n`);
for (const s of doomed) {
    const own = (assets.data ?? []).filter((a) => a.shot_id === s.id);
    console.log(
        `  shot ${String(s.shot_number).padEnd(3)} ${s.id.slice(0, 8)}  ` +
            `${own.length} asset(s)  "${s.description.slice(0, 44)}"`,
    );
}
if (spared.length > 0) {
    console.log('\n  SPARED (approved still or has a job):');
    for (const s of spared) console.log(`    shot ${s.shot_number} ${s.id.slice(0, 8)}`);
}

const doomedIds = new Set(doomed.map((s) => s.id));
const paths = (assets.data ?? [])
    .filter((a) => doomedIds.has(a.shot_id))
    .map((a) => a.storage_path);
console.log(`\n  ${doomed.length} shot row(s), ${paths.length} storage object(s)`);

if (!apply) {
    console.log('\nRe-run with --apply to delete.');
    process.exit(0);
}

// Files first: once the rows are gone the paths are unrecoverable.
if (paths.length > 0) {
    const removed = await db().storage.from(cfg.supabaseBucket).remove(paths);
    if (removed.error) throw new Error(`Storage delete: ${removed.error.message}`);
    console.log(`  removed ${removed.data?.length ?? 0} storage object(s)`);
}

const del = await db().from('shots').delete().in('id', [...doomedIds]);
if (del.error) throw new Error(`Shot delete: ${del.error.message}`);
console.log(`  deleted ${doomedIds.size} shot row(s) (assets cascade)`);

// Drop any project left with no shots — only ones this script emptied.
const emptied = [...new Set(doomed.map((s) => s.project_id))];
for (const projectId of emptied) {
    const left = await db().from('shots').select('id').eq('project_id', projectId).limit(1);
    if (left.error) throw new Error(left.error.message);
    if ((left.data ?? []).length > 0) continue;
    const project = await db().from('projects').select('name').eq('id', projectId).maybeSingle();
    if (project.data?.name === 'Default Project') continue; // never remove the default
    await db().from('projects').delete().eq('id', projectId);
    console.log(`  removed now-empty project "${project.data?.name}"`);
}

console.log('\nDone.');
