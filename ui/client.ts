/**
 * Typed client for the studio's own API.
 *
 * The shared secret lives in localStorage and rides on every request as
 * `x-api-key` — the same header the server already accepts from Claude Code.
 * It is never put in the URL: the page's address ends up in history, in
 * screenshots and in whatever the browser syncs, and the same secret spends
 * real xAI credits.
 *
 * A 401 clears the stored key and rejects with `Unauthorized`, which is what
 * sends the app back to the gate.
 */

const KEY_STORAGE = 'shorts-studio.key';

export function storedKey(): string | null {
    try {
        return window.localStorage.getItem(KEY_STORAGE);
    } catch {
        return null;
    }
}

export function storeKey(key: string): void {
    try {
        window.localStorage.setItem(KEY_STORAGE, key);
    } catch {
        /* private mode — the key just will not persist across reloads */
    }
}

export function clearKey(): void {
    try {
        window.localStorage.removeItem(KEY_STORAGE);
    } catch {
        /* nothing to do */
    }
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

async function request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const key = storedKey();
    const res = await fetch(`api${path}`, {
        method,
        headers: {
            ...(key ? { 'x-api-key': key } : {}),
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    if (res.status === 401) {
        clearKey();
        throw new ApiError(401, 'Unauthorized');
    }

    const text = await res.text();
    let parsed: unknown;
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch {
        throw new ApiError(res.status, `Server returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
        const message =
            parsed && typeof parsed === 'object' && 'error' in parsed
                ? String((parsed as { error: unknown }).error)
                : `Request failed with ${res.status}`;
        throw new ApiError(res.status, message);
    }
    return parsed as T;
}

// -------------------------------------------------------------------- types

export interface StudioConfig {
    video_model: string;
    video_resolution: string;
    image_model: string;
    vision_model: string;
    vision_critique: boolean;
    mcp_apps: boolean;
    bucket: string;
    defaults: {
        still_count: number;
        max_still_count: number;
        duration: number;
        min_duration: number;
        max_duration: number;
        max_reference_images: number;
    };
}

export interface ProjectSummary {
    id: string;
    name: string;
    created_at: string;
    title: string | null;
    logline: string | null;
    strip: string[];
    shot_count: number;
    done_count: number;
    approved_count: number;
    open_jobs: number;
    state: 'planning' | 'in progress' | 'complete';
}

export type ShotStatus =
    | 'still_pending'
    | 'still_ready'
    | 'approved'
    | 'animating'
    | 'done'
    | 'failed';

export type JobStatus = 'submitted' | 'processing' | 'done' | 'failed' | 'expired';

export interface Critique {
    verdict?: 'accept' | 'regenerate';
    reason?: string;
    style_ok?: boolean;
    people?: number;
    faces_to_camera?: boolean;
    visible_text?: boolean;
    palette_ok?: boolean;
    framing_ok?: boolean;
    anatomy_issues?: string | null;
    fix_suggestion?: string | null;
    error?: string;
}

export interface StillView {
    asset_id: string;
    url: string;
    approved: boolean;
    critique: Critique | null;
    created_at: string;
}

export interface ShotView {
    shot_id: string;
    shot_number: number;
    description: string;
    status: ShotStatus;
    created_at: string;
    stills: StillView[];
    approved_asset_id: string | null;
    video_url: string | null;
    first_frame_url: string | null;
    last_frame_url: string | null;
    job: { job_id: string; status: JobStatus; error: string | null } | null;
    motion_instruction: string | null;
    camera_motion: string | null;
    story_beat: string | null;
    is_reference: boolean;
}

export interface JobView {
    job_id: string;
    shot_id: string;
    shot_number: number | null;
    status: JobStatus;
    motion_instruction: string;
    duration: number;
    error: string | null;
    attempts: number;
    created_at: string;
    updated_at: string;
    video_url: string | null;
}

export interface ReferenceView {
    reference_id: string;
    asset_id: string;
    role: string;
    label: string;
    notes: string | null;
    url: string | null;
    shot_id: string | null;
    created_at: string;
}

export interface Snapshot {
    project: { id: string; name: string; created_at: string };
    title: string | null;
    story_text: string | null;
    logline: string | null;
    manifest: Record<string, unknown> | null;
    manifest_updated_at: string | null;
    shots: ShotView[];
    jobs: JobView[];
    references: ReferenceView[];
    counts: { shots: number; done: number; approved: number; open_jobs: number };
}

export interface Pitch {
    title: string;
    hook: string;
    logline: string;
    why_it_travels: string;
}

export interface PlannedShot {
    shot_number: number;
    story_beat: string;
    visual_description: string;
    camera_motion: string;
    motion_instruction: string;
    needed_references: string[];
    continuity_notes: string;
}

export interface PlannedReference {
    role: string;
    label: string;
    description: string;
    used_in: number[];
}

// ------------------------------------------------------------------ calls

export const api = {
    config: () => request<StudioConfig>('GET', '/config'),

    projects: () => request<{ projects: ProjectSummary[] }>('GET', '/projects'),
    createProject: (name: string) =>
        request<{ project: { id: string; name: string } }>('POST', '/projects', { name }),
    renameProject: (id: string, name: string) =>
        request<unknown>('PATCH', `/projects/${id}`, { name }),
    deleteProject: (id: string) => request<unknown>('DELETE', `/projects/${id}`),
    snapshot: (id: string) => request<Snapshot>('GET', `/projects/${id}`),

    saveManifest: (
        id: string,
        payload: { title?: string; story_text?: string; manifest: Record<string, unknown> },
    ) => request<{ updated_at: string }>('PUT', `/projects/${id}/manifest`, payload),

    createShot: (
        projectId: string,
        payload: {
            description: string;
            shot_number?: number;
            count?: number;
            palette_override?: string;
            reference_asset_ids?: string[];
            reference_labels?: string[];
        },
    ) =>
        request<{ shot_id: string; shot_number: number; stills: StillView[]; failures: string[] }>(
            'POST',
            `/projects/${projectId}/shots`,
            payload,
        ),
    updateShot: (id: string, description: string) =>
        request<unknown>('PATCH', `/shots/${id}`, { description }),
    deleteShot: (id: string) => request<unknown>('DELETE', `/shots/${id}`),
    regenerate: (
        shotId: string,
        payload: { count?: number; description?: string; reference_asset_ids?: string[] },
    ) => request<{ stills: StillView[]; failures: string[] }>(
        'POST',
        `/shots/${shotId}/stills`,
        payload,
    ),

    approve: (assetId: string) => request<unknown>('POST', `/stills/${assetId}/approve`),

    animate: (shotId: string, payload: { motion_instruction: string; duration?: number }) =>
        request<{ job_id: string }>('POST', `/shots/${shotId}/animate`, payload),
    animateApproved: (projectId: string, duration?: number) =>
        request<{
            submitted: Array<{ shot_number: number; job_id: string }>;
            failures: Array<{ shot_number: number; error: string }>;
        }>('POST', `/projects/${projectId}/animate-approved`, { duration }),

    job: (id: string) => request<{ status: JobStatus }>('GET', `/jobs/${id}`),
    retryJob: (id: string) => request<{ job_id: string }>('POST', `/jobs/${id}/retry`),
    cancelJob: (id: string) => request<unknown>('POST', `/jobs/${id}/cancel`),

    importReference: (
        projectId: string,
        payload: {
            label: string;
            role: string;
            notes?: string;
            image_url?: string;
            image_base64?: string;
        },
    ) => request<{ asset_id: string }>('POST', `/projects/${projectId}/references`, payload),
    generateReference: (
        projectId: string,
        payload: { label: string; role: string; description: string; reference_asset_ids?: string[] },
    ) =>
        request<{ asset_id: string; url: string }>(
            'POST',
            `/projects/${projectId}/references/generate`,
            payload,
        ),
    deleteReference: (id: string) => request<unknown>('DELETE', `/references/${id}`),

    pitch: (topic?: string) => request<{ pitches: Pitch[] }>('POST', '/assist', { mode: 'pitch', topic }),
    story: (payload: { topic?: string; draft?: string; notes?: string }) =>
        request<{ title: string; logline: string; story_text: string }>('POST', '/assist', {
            mode: 'story',
            ...payload,
        }),
    planShots: (story_text: string, count: number) =>
        request<{ shots: PlannedShot[] }>('POST', '/assist', {
            mode: 'shots',
            story_text,
            count,
        }),
    planReferences: (shots: PlannedShot[]) =>
        request<{ references: PlannedReference[] }>('POST', '/assist', {
            mode: 'references',
            shots,
        }),
};

/**
 * Download one shot's clip to disk.
 *
 * Goes through `fetch` rather than a plain link because the endpoint needs the
 * `x-api-key` header, which an `<a href>` cannot carry. The response becomes a
 * same-origin blob URL, and the `download` attribute *is* honoured for those,
 * so the file saves with the name the server chose instead of opening in a tab.
 */
export async function downloadClip(shotId: string, fallbackName: string): Promise<void> {
    const key = storedKey();
    const res = await fetch(`api/shots/${shotId}/video`, {
        headers: key ? { 'x-api-key': key } : {},
    });
    if (res.status === 401) {
        clearKey();
        throw new ApiError(401, 'Unauthorized');
    }
    if (!res.ok) {
        let message = `Download failed with ${res.status}`;
        try {
            const body = (await res.json()) as { error?: string };
            if (body.error) message = body.error;
        } catch {
            /* the body was not JSON; the status is all we have */
        }
        throw new ApiError(res.status, message);
    }

    // The server names the file; fall back only if the header is missing.
    const disposition = res.headers.get('content-disposition') ?? '';
    const matched = /filename="([^"]+)"/.exec(disposition)?.[1];

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = matched ?? fallbackName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        // Revoking immediately can cancel the save in some browsers.
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
}

/** Read a File as bare base64, which is what the import endpoints accept. */
export function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.onload = () => {
            const result = String(reader.result ?? '');
            const comma = result.indexOf(',');
            resolve(comma === -1 ? result : result.slice(comma + 1));
        };
        reader.readAsDataURL(file);
    });
}
