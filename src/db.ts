import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig, DEFAULT_PROJECT_NAME } from './config.js';

// ------------------------------------------------------------------ types

export type ShotStatus =
    | 'still_pending'
    | 'still_ready'
    | 'approved'
    | 'animating'
    | 'done'
    | 'failed';

export type AssetKind = 'still' | 'video' | 'first_frame' | 'last_frame';

export type JobStatus = 'submitted' | 'processing' | 'done' | 'failed' | 'expired';

export interface ProjectRow {
    id: string;
    name: string;
    created_at: string;
}

export interface ShotRow {
    id: string;
    project_id: string;
    shot_number: number;
    description: string;
    status: ShotStatus;
    created_at: string;
}

export interface AssetRow {
    id: string;
    shot_id: string;
    kind: AssetKind;
    storage_path: string;
    public_url: string;
    approved: boolean;
    upstream_job: string | null;
    created_at: string;
}

export interface JobRow {
    id: string;
    shot_id: string;
    source_asset_id: string;
    upstream_job: string | null;
    status: JobStatus;
    error: string | null;
    motion_instruction: string;
    duration: number;
    video_asset_id: string | null;
    first_frame_asset_id: string | null;
    last_frame_asset_id: string | null;
    attempts: number;
    created_at: string;
    updated_at: string;
}

export interface StoryManifestRow {
    id: string;
    project_id: string;
    title: string | null;
    story_text: string | null;
    manifest: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface ReferenceAssetRow {
    id: string;
    project_id: string;
    asset_id: string;
    role: string;
    label: string;
    notes: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
}

// ----------------------------------------------------------------- client

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
    if (!client) {
        const cfg = getConfig();
        client = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    }
    return client;
}

/**
 * Supabase returns errors in the result rather than throwing. Unwrap once here
 * so call sites can stay linear.
 */
function unwrap<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
    if (result.error) throw new Error(`${what}: ${result.error.message}`);
    if (result.data === null) throw new Error(`${what}: no data returned`);
    return result.data;
}

// --------------------------------------------------------------- projects

export async function getOrCreateDefaultProject(): Promise<ProjectRow> {
    const existing = await db()
        .from('projects')
        .select('*')
        .eq('name', DEFAULT_PROJECT_NAME)
        .order('created_at', { ascending: true })
        .limit(1);
    if (existing.error) throw new Error(`Look up default project: ${existing.error.message}`);
    const first = existing.data?.[0] as ProjectRow | undefined;
    if (first) return first;

    return unwrap(
        await db()
            .from('projects')
            .insert({ name: DEFAULT_PROJECT_NAME })
            .select()
            .single(),
        'Create default project',
    ) as ProjectRow;
}

export async function getProject(projectId: string): Promise<ProjectRow | null> {
    const res = await db().from('projects').select('*').eq('id', projectId).maybeSingle();
    if (res.error) throw new Error(`Look up project: ${res.error.message}`);
    return (res.data as ProjectRow | null) ?? null;
}

export async function createProject(name: string): Promise<ProjectRow> {
    return unwrap(
        await db().from('projects').insert({ name }).select().single(),
        'Create project',
    ) as ProjectRow;
}

/**
 * Address a project by name, creating it on first use.
 *
 * This is how a second short gets its own project without adding
 * create_project/list_projects tools — the spec asks for exactly five tools and
 * a small surface, so project handling rides on the tools that already exist.
 */
export async function getOrCreateProjectByName(name: string): Promise<ProjectRow> {
    const trimmed = name.trim();
    const existing = await db()
        .from('projects')
        .select('*')
        .ilike('name', trimmed)
        .order('created_at', { ascending: true })
        .limit(1);
    if (existing.error) throw new Error(`Look up project by name: ${existing.error.message}`);
    const first = existing.data?.[0] as ProjectRow | undefined;
    return first ?? (await createProject(trimmed));
}

export async function listProjects(): Promise<ProjectRow[]> {
    const res = await db()
        .from('projects')
        .select('*')
        .order('created_at', { ascending: true });
    if (res.error) throw new Error(`List projects: ${res.error.message}`);
    return (res.data ?? []) as ProjectRow[];
}

// ------------------------------------------------------------------ shots

/** Next free shot number in a project, 1-based. */
export async function nextShotNumber(projectId: string): Promise<number> {
    const res = await db()
        .from('shots')
        .select('shot_number')
        .eq('project_id', projectId)
        .order('shot_number', { ascending: false })
        .limit(1);
    if (res.error) throw new Error(`Find next shot number: ${res.error.message}`);
    const top = res.data?.[0] as { shot_number: number } | undefined;
    return (top?.shot_number ?? 0) + 1;
}

export async function createShot(input: {
    projectId: string;
    shotNumber: number;
    description: string;
}): Promise<ShotRow> {
    return unwrap(
        await db()
            .from('shots')
            .insert({
                project_id: input.projectId,
                shot_number: input.shotNumber,
                description: input.description,
                status: 'still_pending',
            })
            .select()
            .single(),
        'Create shot',
    ) as ShotRow;
}

export async function getShot(shotId: string): Promise<ShotRow | null> {
    const res = await db().from('shots').select('*').eq('id', shotId).maybeSingle();
    if (res.error) throw new Error(`Look up shot: ${res.error.message}`);
    return (res.data as ShotRow | null) ?? null;
}

export async function setShotStatus(shotId: string, status: ShotStatus): Promise<void> {
    const res = await db().from('shots').update({ status }).eq('id', shotId);
    if (res.error) throw new Error(`Update shot status: ${res.error.message}`);
}

export async function listShots(projectId: string): Promise<ShotRow[]> {
    const res = await db()
        .from('shots')
        .select('*')
        .eq('project_id', projectId)
        .order('shot_number', { ascending: true });
    if (res.error) throw new Error(`List shots: ${res.error.message}`);
    return (res.data ?? []) as ShotRow[];
}

// ----------------------------------------------------------------- assets

export async function createAsset(input: {
    shotId: string;
    kind: AssetKind;
    storagePath: string;
    publicUrl: string;
    approved?: boolean;
    upstreamJob?: string | null;
}): Promise<AssetRow> {
    return unwrap(
        await db()
            .from('assets')
            .insert({
                shot_id: input.shotId,
                kind: input.kind,
                storage_path: input.storagePath,
                public_url: input.publicUrl,
                approved: input.approved ?? false,
                upstream_job: input.upstreamJob ?? null,
            })
            .select()
            .single(),
        'Create asset',
    ) as AssetRow;
}

export async function getAsset(assetId: string): Promise<AssetRow | null> {
    const res = await db().from('assets').select('*').eq('id', assetId).maybeSingle();
    if (res.error) throw new Error(`Look up asset: ${res.error.message}`);
    return (res.data as AssetRow | null) ?? null;
}

export async function listAssetsForShots(shotIds: string[]): Promise<AssetRow[]> {
    if (shotIds.length === 0) return [];
    const res = await db()
        .from('assets')
        .select('*')
        .in('shot_id', shotIds)
        .order('created_at', { ascending: true });
    if (res.error) throw new Error(`List assets: ${res.error.message}`);
    return (res.data ?? []) as AssetRow[];
}

export async function listAssetsByIds(assetIds: string[]): Promise<AssetRow[]> {
    if (assetIds.length === 0) return [];
    const res = await db().from('assets').select('*').in('id', assetIds);
    if (res.error) throw new Error(`List assets by id: ${res.error.message}`);
    return (res.data ?? []) as AssetRow[];
}

/** Approve one still and un-approve every sibling of the same shot. */
export async function approveStillExclusively(asset: AssetRow): Promise<void> {
    const clear = await db()
        .from('assets')
        .update({ approved: false })
        .eq('shot_id', asset.shot_id)
        .eq('kind', 'still');
    if (clear.error) throw new Error(`Clear sibling approvals: ${clear.error.message}`);

    const set = await db().from('assets').update({ approved: true }).eq('id', asset.id);
    if (set.error) throw new Error(`Approve still: ${set.error.message}`);
}

// ------------------------------------------------------------------- jobs

export async function createJob(input: {
    shotId: string;
    sourceAssetId: string;
    upstreamJob: string;
    motionInstruction: string;
    duration: number;
}): Promise<JobRow> {
    return unwrap(
        await db()
            .from('jobs')
            .insert({
                shot_id: input.shotId,
                source_asset_id: input.sourceAssetId,
                upstream_job: input.upstreamJob,
                motion_instruction: input.motionInstruction,
                duration: input.duration,
                status: 'submitted',
            })
            .select()
            .single(),
        'Create job',
    ) as JobRow;
}

export async function getJob(jobId: string): Promise<JobRow | null> {
    const res = await db().from('jobs').select('*').eq('id', jobId).maybeSingle();
    if (res.error) throw new Error(`Look up job: ${res.error.message}`);
    return (res.data as JobRow | null) ?? null;
}

export async function updateJob(jobId: string, patch: Partial<JobRow>): Promise<JobRow> {
    return unwrap(
        await db()
            .from('jobs')
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq('id', jobId)
            .select()
            .single(),
        'Update job',
    ) as JobRow;
}

/**
 * Every job still in flight, oldest first. This is the worker's boot query —
 * it is the whole reason a restart mid-job loses nothing.
 */
export async function listOpenJobs(): Promise<JobRow[]> {
    const res = await db()
        .from('jobs')
        .select('*')
        .in('status', ['submitted', 'processing'])
        .order('created_at', { ascending: true });
    if (res.error) throw new Error(`List open jobs: ${res.error.message}`);
    return (res.data ?? []) as JobRow[];
}

/** Most recent job per shot, for list_shots. */
export async function latestJobsForShots(shotIds: string[]): Promise<Map<string, JobRow>> {
    if (shotIds.length === 0) return new Map();
    const res = await db()
        .from('jobs')
        .select('*')
        .in('shot_id', shotIds)
        .order('created_at', { ascending: true });
    if (res.error) throw new Error(`List jobs: ${res.error.message}`);
    const map = new Map<string, JobRow>();
    for (const job of (res.data ?? []) as JobRow[]) map.set(job.shot_id, job);
    return map;
}

// ----------------------------------------------------------- story memory

export async function saveStoryManifest(input: {
    projectId: string;
    title?: string | null;
    storyText?: string | null;
    manifest: Record<string, unknown>;
}): Promise<StoryManifestRow> {
    return unwrap(
        await db()
            .from('story_manifests')
            .upsert(
                {
                    project_id: input.projectId,
                    title: input.title ?? null,
                    story_text: input.storyText ?? null,
                    manifest: input.manifest,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'project_id' },
            )
            .select()
            .single(),
        'Save story manifest',
    ) as StoryManifestRow;
}

export async function getStoryManifest(projectId: string): Promise<StoryManifestRow | null> {
    const res = await db()
        .from('story_manifests')
        .select('*')
        .eq('project_id', projectId)
        .maybeSingle();
    if (res.error) throw new Error(`Get story manifest: ${res.error.message}`);
    return (res.data as StoryManifestRow | null) ?? null;
}

export async function createReferenceAsset(input: {
    projectId: string;
    assetId: string;
    role: string;
    label: string;
    notes?: string | null;
    metadata?: Record<string, unknown>;
}): Promise<ReferenceAssetRow> {
    return unwrap(
        await db()
            .from('reference_assets')
            .upsert(
                {
                    project_id: input.projectId,
                    asset_id: input.assetId,
                    role: input.role,
                    label: input.label,
                    notes: input.notes ?? null,
                    metadata: input.metadata ?? {},
                },
                { onConflict: 'asset_id' },
            )
            .select()
            .single(),
        'Create reference asset',
    ) as ReferenceAssetRow;
}

export async function listReferenceAssets(input: {
    projectId: string;
    role?: string;
    label?: string;
}): Promise<ReferenceAssetRow[]> {
    let query = db()
        .from('reference_assets')
        .select('*')
        .eq('project_id', input.projectId)
        .order('created_at', { ascending: true });

    if (input.role) query = query.eq('role', input.role);
    if (input.label) query = query.ilike('label', `%${input.label}%`);

    const res = await query;
    if (res.error) throw new Error(`List reference assets: ${res.error.message}`);
    return (res.data ?? []) as ReferenceAssetRow[];
}
