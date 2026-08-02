import {
    api,
    ApiError,
    clearKey,
    storedKey,
    type JobView,
    type PlannedReference,
    type PlannedShot,
    type Pitch,
    type ProjectSummary,
    type Snapshot,
    type StudioConfig,
} from './client.js';

/**
 * All the studio's mutable state, in one object, with one way to change it.
 *
 * `render` is re-run after every mutation. That is affordable because the
 * whole app is one screen over a snapshot of at most a few dozen shots, and it
 * removes a whole class of bug where a list and its detail drawer disagree.
 * The two places where it would be wrong to blow away DOM — a playing <video>
 * and a focused <textarea> — are handled by the views, not by diffing.
 */

export type Tab = 'shots' | 'story' | 'refs' | 'jobs';

export interface RunStep {
    label: string;
    state: 'pending' | 'running' | 'ok' | 'error';
    detail?: string;
}

export interface WizardState {
    open: boolean;
    step: 1 | 2 | 3 | 4 | 5;
    busy: boolean;
    projectName: string;
    topic: string;
    pitches: Pitch[];
    chosenPitch: number | null;
    title: string;
    logline: string;
    storyText: string;
    notes: string;
    shotCount: number;
    shots: PlannedShot[];
    references: PlannedReference[];
    /** Which planned references to actually generate plates for. */
    generateRefs: Set<string>;
    log: RunStep[];
    running: boolean;
}

export interface State {
    ready: boolean;
    authed: boolean;
    authError: string | null;
    config: StudioConfig | null;
    projects: ProjectSummary[];
    projectId: string | null;
    snapshot: Snapshot | null;
    loading: boolean;
    tab: Tab;
    openShotId: string | null;
    roughCut: boolean;
    cutIndex: number;
    refFilter: string;
    editingStory: boolean;
    storyDraft: string;
    /** Shot ids ticked in the Shots tab, for the bulk action bar. */
    selected: Set<string>;
    /** Anchor for shift-click range selection. */
    lastPicked: string | null;
    /** Ids of things with an in-flight request, so buttons can show a spinner. */
    busy: Set<string>;
    toasts: Array<{ id: number; text: string; kind: 'ok' | 'err' | 'info' }>;
    importOpen: boolean;
    newShotOpen: boolean;
    wizard: WizardState;
}

export function blankWizard(): WizardState {
    return {
        open: false,
        step: 1,
        busy: false,
        projectName: '',
        topic: '',
        pitches: [],
        chosenPitch: null,
        title: '',
        logline: '',
        storyText: '',
        notes: '',
        shotCount: 8,
        shots: [],
        references: [],
        generateRefs: new Set(),
        log: [],
        running: false,
    };
}

export const state: State = {
    ready: false,
    authed: Boolean(storedKey()),
    authError: null,
    config: null,
    projects: [],
    projectId: null,
    snapshot: null,
    loading: false,
    tab: 'shots',
    openShotId: null,
    roughCut: false,
    cutIndex: 0,
    refFilter: 'all',
    editingStory: false,
    storyDraft: '',
    selected: new Set(),
    lastPicked: null,
    busy: new Set(),
    toasts: [],
    importOpen: false,
    newShotOpen: false,
    wizard: blankWizard(),
};

let renderFn: () => void = () => {};

export function onRender(fn: () => void): void {
    renderFn = fn;
}

export function render(): void {
    renderFn();
}

// -------------------------------------------------------------------- busy

export function isBusy(key: string): boolean {
    return state.busy.has(key);
}

/**
 * Run an action with a busy flag and uniform error reporting.
 *
 * Every mutating click goes through here, so no caller has to remember to
 * re-render, clear its spinner on the error path, or decide what to do with a
 * 401. Returns undefined when the action failed, which is enough for callers
 * that want to skip their follow-up.
 */
export async function act<T>(
    key: string,
    fn: () => Promise<T>,
    options: { success?: string; refresh?: boolean } = {},
): Promise<T | undefined> {
    if (state.busy.has(key)) return undefined;
    state.busy.add(key);
    render();
    try {
        const result = await fn();
        if (options.success) toast(options.success, 'ok');
        if (options.refresh !== false) await refresh();
        return result;
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
            state.authed = false;
            state.authError = 'That key was rejected. Enter it again.';
        } else {
            toast(err instanceof Error ? err.message : String(err), 'err');
            // Reconcile even on failure. A generate request can outlive the
            // proxy in front of the server — the browser sees a dead
            // connection while the stills land in the database anyway. Without
            // this the UI would sit there insisting nothing happened.
            if (options.refresh !== false) await refresh();
        }
        return undefined;
    } finally {
        state.busy.delete(key);
        render();
    }
}

// ------------------------------------------------------------------ toasts

let toastSeq = 0;

export function toast(text: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
    const id = ++toastSeq;
    state.toasts.push({ id, text, kind });
    render();
    // Errors linger; confirmations do not need to.
    window.setTimeout(
        () => {
            state.toasts = state.toasts.filter((t) => t.id !== id);
            render();
        },
        kind === 'err' ? 9000 : 4000,
    );
}

// ------------------------------------------------------------------- data

export async function loadConfig(): Promise<void> {
    try {
        state.config = await api.config();
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
            state.authed = false;
            state.authError = 'That key was rejected. Enter it again.';
            return;
        }
        toast(err instanceof Error ? err.message : String(err), 'err');
    }
}

/** Re-read the project list and, if one is open, its snapshot. */
export async function refresh(): Promise<void> {
    try {
        const { projects } = await api.projects();
        state.projects = projects;
        if (state.projectId && !projects.some((p) => p.id === state.projectId)) {
            // The open project was deleted, here or from another session.
            state.projectId = null;
            state.snapshot = null;
        }
        if (state.projectId) {
            state.snapshot = await api.snapshot(state.projectId);
        }
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
            state.authed = false;
            state.authError = 'That key was rejected. Enter it again.';
        } else {
            toast(err instanceof Error ? err.message : String(err), 'err');
        }
    } finally {
        state.ready = true;
        render();
    }
}

export async function openProject(id: string): Promise<void> {
    state.projectId = id;
    state.snapshot = null;
    state.tab = 'shots';
    state.openShotId = null;
    state.cutIndex = 0;
    state.editingStory = false;
    // A selection is a set of shot ids, which mean nothing in another project.
    state.selected.clear();
    state.lastPicked = null;
    state.loading = true;
    render();
    try {
        state.snapshot = await api.snapshot(id);
    } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
        state.loading = false;
        render();
    }
}

export function closeProject(): void {
    state.projectId = null;
    state.snapshot = null;
    state.openShotId = null;
    state.roughCut = false;
    state.selected.clear();
    state.lastPicked = null;
    render();
}

// ---------------------------------------------------------------- selection

/**
 * Toggle a shot, or select a range when shift is held.
 *
 * Range select is worth the few lines: the common operation is "these six
 * consecutive shots", and ticking them one at a time is exactly the kind of
 * tedium a selection UI exists to remove.
 */
export function pick(shotId: string, ordered: string[], shiftKey: boolean): void {
    if (shiftKey && state.lastPicked && state.lastPicked !== shotId) {
        const from = ordered.indexOf(state.lastPicked);
        const to = ordered.indexOf(shotId);
        if (from !== -1 && to !== -1) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            // A shift-click extends the selection; it never clears what the
            // range does not cover.
            for (const id of ordered.slice(lo, hi + 1)) state.selected.add(id);
            state.lastPicked = shotId;
            render();
            return;
        }
    }
    if (state.selected.has(shotId)) state.selected.delete(shotId);
    else state.selected.add(shotId);
    state.lastPicked = shotId;
    render();
}

export function selectedShots(): Snapshot['shots'] {
    return filmShots(state.snapshot).filter((s) => state.selected.has(s.shot_id));
}

/**
 * Apply one operation across the selection, one shot at a time.
 *
 * Sequential and failure-tolerant on purpose. These are slow, paid operations,
 * and firing eight image generations at once is a good way to hit the upstream
 * rate limit and lose half of them. A shot that fails is reported by number
 * rather than aborting the rest.
 */
export async function runBatch(
    key: string,
    shots: Snapshot['shots'],
    verb: string,
    fn: (shot: Snapshot['shots'][number]) => Promise<unknown>,
): Promise<void> {
    if (shots.length === 0) {
        toast('Nothing selected.', 'info');
        return;
    }
    if (state.busy.has(key)) return;
    state.busy.add(key);
    render();

    const failures: string[] = [];
    let done = 0;
    for (const shot of shots) {
        try {
            await fn(shot);
            done++;
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                state.authed = false;
                state.authError = 'That key was rejected. Enter it again.';
                break;
            }
            failures.push(
                `${String(shot.shot_number).padStart(2, '0')}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    state.busy.delete(key);
    if (failures.length > 0) {
        toast(`${verb} ${done} of ${shots.length}. Failed — ${failures[0]}`, 'err');
    } else {
        toast(`${verb} ${done} shot${done === 1 ? '' : 's'}.`, 'ok');
    }
    await refresh();
}

export function signOut(): void {
    clearKey();
    state.authed = false;
    state.authError = null;
    state.projectId = null;
    state.snapshot = null;
    render();
}

// ---------------------------------------------------------------- polling

/**
 * Poll while anything is in flight, and only then.
 *
 * The video worker already advances jobs on its own schedule; this is just the
 * UI catching up. It stops the moment the project has no open job, so an idle
 * studio makes no requests at all.
 */
export function startPolling(): void {
    window.setInterval(() => {
        if (!state.authed || !state.projectId || !state.snapshot) return;
        if (state.snapshot.counts.open_jobs === 0) return;
        if (document.visibilityState === 'hidden') return;
        void refresh();
    }, 6000);

    // The job clock ticks every second whether or not data changed.
    window.setInterval(() => {
        if (!state.authed || !state.snapshot) return;
        if (state.snapshot.counts.open_jobs === 0) return;
        render();
    }, 1000);
}

// ----------------------------------------------------------------- derived

/** Shots that are beats of the film — reference plates live in their own tab. */
export function filmShots(snapshot: Snapshot | null): Snapshot['shots'] {
    return (snapshot?.shots ?? []).filter((s) => !s.is_reference);
}

export function finishedClips(snapshot: Snapshot | null): Snapshot['shots'] {
    return filmShots(snapshot).filter((s) => s.video_url);
}

export function openJobs(jobs: JobView[]): JobView[] {
    return jobs.filter((j) => j.status === 'submitted' || j.status === 'processing');
}

export const STATUS_COLOR: Record<string, string> = {
    still_pending: 'var(--muted-2)',
    still_ready: 'var(--info)',
    approved: 'var(--accent)',
    animating: 'var(--accent)',
    done: 'var(--good)',
    failed: 'var(--bad)',
    submitted: 'var(--accent)',
    processing: 'var(--accent)',
    expired: 'var(--muted-2)',
};
