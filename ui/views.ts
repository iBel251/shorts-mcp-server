import { api, downloadClip, type ReferenceView, type ShotView, type Snapshot } from './client.js';
import { day, el, elapsed, shortId, shotLabel, type Child } from './dom.js';
import {
    act,
    closeProject,
    filmShots,
    isBusy,
    openProject,
    pick,
    render,
    runBatch,
    signOut,
    state,
    toast,
    STATUS_COLOR,
    type Tab,
} from './store.js';

/**
 * The main surfaces: sidebar, header, and the four tabs.
 *
 * Every panel renders from `state.snapshot` and nothing else, so what is on
 * screen is always one consistent read of the database rather than an
 * accumulation of optimistic edits.
 */

// ------------------------------------------------------------------ sidebar

export function sidebar(): HTMLElement {
    const cfg = state.config;
    const snapshot = state.snapshot;
    const shots = filmShots(snapshot);
    const openJobCount = snapshot?.counts.open_jobs ?? 0;
    const inProject = Boolean(state.projectId);

    const navItem = (
        key: string,
        label: string,
        count: number | string,
        on: boolean,
        go: () => void,
    ) =>
        el(
            'button',
            { class: `nav-item${on ? ' on' : ''}`, onclick: go, type: 'button' },
            el('span', { class: 'key' }, key),
            el('span', { class: 'label' }, label),
            el('span', { class: 'count' }, String(count)),
        );

    const goTab = (tab: Tab) => () => {
        if (!state.projectId) {
            toast('Open a project first.', 'info');
            return;
        }
        state.tab = tab;
        render();
    };

    return el(
        'aside',
        { class: 'side' },
        el(
            'div',
            { class: 'brand' },
            el('div', { class: 'brand-mark' }),
            el(
                'div',
                { style: { display: 'flex', 'flex-direction': 'column' } },
                el('span', { class: 'brand-name' }, 'SHORTS STUDIO'),
                el(
                    'span',
                    { class: 'brand-sub' },
                    `${cfg?.image_model.replace(/-image.*$/, '') ?? 'grok-imagine'} · 9:16`,
                ),
            ),
        ),

        el(
            'nav',
            { class: 'nav' },
            navItem('01', 'Projects', state.projects.length, !inProject, closeProject),
            navItem('02', 'Shots', shots.length, inProject && state.tab === 'shots', goTab('shots')),
            navItem('03', 'Jobs', openJobCount, inProject && state.tab === 'jobs', goTab('jobs')),
            navItem(
                '04',
                'References',
                snapshot?.references.length ?? 0,
                inProject && state.tab === 'refs',
                goTab('refs'),
            ),
        ),

        el(
            'div',
            { class: 'side-group' },
            el('span', { class: 'side-head' }, 'PROJECTS'),
            state.projects.length === 0
                ? el('span', { class: 'dim mono', style: { 'font-size': '11px' } }, 'none yet')
                : state.projects.map((project) =>
                      el(
                          'button',
                          {
                              class: `side-project${project.id === state.projectId ? ' on' : ''}`,
                              type: 'button',
                              onclick: () => void openProject(project.id),
                          },
                          el('span', {
                              class: 'dot',
                              style: { background: projectColor(project.state) },
                          }),
                          el('span', { class: 'name' }, project.name),
                          el(
                              'span',
                              { class: 'ratio' },
                              `${project.done_count}/${project.shot_count}`,
                          ),
                      ),
                  ),
        ),

        el(
            'button',
            {
                class: 'btn primary',
                type: 'button',
                onclick: () => {
                    state.wizard.open = true;
                    state.wizard.step = 1;
                    render();
                },
            },
            '+ New short',
        ),

        el(
            'div',
            { class: 'side-foot' },
            el(
                'div',
                { class: `live${state.ready && cfg ? '' : ' bad'}` },
                el('b'),
                state.ready && cfg ? 'server healthy · /healthz 200' : 'connecting…',
            ),
            cfg && el('div', null, `VIDEO_MODEL ${cfg.video_model}`),
            cfg && el('div', null, `VIDEO_RESOLUTION ${cfg.video_resolution}`),
            cfg &&
                el(
                    'div',
                    null,
                    `MCP_APPS ${cfg.mcp_apps ? 'on' : 'off'} · VISION_CRITIQUE ${
                        cfg.vision_critique ? 'on' : 'off'
                    }`,
                ),
            el(
                'button',
                {
                    class: 'btn tiny',
                    type: 'button',
                    style: { 'align-self': 'flex-start', 'margin-top': '4px' },
                    onclick: signOut,
                },
                'sign out',
            ),
        ),
    );
}

function projectColor(state_: string): string {
    if (state_ === 'planning') return 'var(--muted-2)';
    if (state_ === 'complete') return 'var(--good)';
    return 'var(--accent)';
}

// ------------------------------------------------------------------- header

export function header(): HTMLElement {
    const snapshot = state.snapshot;
    const inProject = Boolean(state.projectId);
    const shots = filmShots(snapshot);
    const approved = shots.filter((s) => s.status === 'approved').length;
    const openJobs = state.projects.reduce((total, p) => total + p.open_jobs, 0);

    const subtitle = inProject
        ? snapshot
            ? `${shots.length} shots · ${snapshot.counts.done} done · ${approved} approved · ${snapshot.references.length} references`
            : 'loading…'
        : `${state.projects.length} projects · ${openJobs} jobs in flight · bucket "${
              state.config?.bucket ?? 'shorts'
          }"`;

    return el(
        'header',
        { class: 'head' },
        el(
            'div',
            { class: 'left' },
            inProject &&
                el('button', { class: 'btn tiny', type: 'button', onclick: closeProject }, '← all'),
            el(
                'div',
                { style: { 'min-width': '0' } },
                el('h1', { class: 'truncate' }, inProject ? (snapshot?.project.name ?? '…') : 'Projects'),
                el('p', null, subtitle),
            ),
        ),
        inProject &&
            el(
                'div',
                { class: 'right' },
                el(
                    'button',
                    {
                        class: 'btn',
                        type: 'button',
                        onclick: () => {
                            state.roughCut = true;
                            state.cutIndex = 0;
                            render();
                        },
                    },
                    '▶ Rough cut',
                ),
                el(
                    'button',
                    {
                        class: `btn primary${isBusy('animate-all') ? ' busy' : ''}`,
                        type: 'button',
                        disabled: approved === 0,
                        onclick: () => void animateApproved(),
                    },
                    `Animate approved (${approved})`,
                ),
            ),
    );
}

async function animateApproved(): Promise<void> {
    const projectId = state.projectId;
    if (!projectId) return;
    const result = await act('animate-all', () => api.animateApproved(projectId));
    if (!result) return;
    if (result.failures.length > 0) {
        toast(
            `Submitted ${result.submitted.length}; ${result.failures.length} failed: ${result.failures[0]?.error ?? ''}`,
            'err',
        );
    } else {
        toast(`Submitted ${result.submitted.length} clips.`, 'ok');
        state.tab = 'jobs';
        render();
    }
}

// --------------------------------------------------------------------- tabs

export function tabs(): HTMLElement {
    const snapshot = state.snapshot;
    const defs: Array<[Tab, string, number | '']> = [
        ['shots', 'Shots', filmShots(snapshot).length],
        ['story', 'Story', ''],
        ['refs', 'References', snapshot?.references.length ?? 0],
        ['jobs', 'Jobs', snapshot?.jobs.length ?? 0],
    ];
    return el(
        'div',
        { class: 'tabs' },
        defs.map(([key, label, count]) =>
            el(
                'button',
                {
                    class: `tab${state.tab === key ? ' on' : ''}`,
                    type: 'button',
                    onclick: () => {
                        state.tab = key;
                        render();
                    },
                },
                label,
                count === '' ? null : el('span', { class: 'count' }, ` ${count}`),
            ),
        ),
    );
}

// ----------------------------------------------------------- projects grid

export function projectsView(): Child {
    if (state.projects.length === 0) {
        return el(
            'div',
            { class: 'empty' },
            'No projects yet. Start one with ',
            el('b', null, '+ New short'),
            ' — or create shots from Claude and they will appear here.',
        );
    }

    return el(
        'div',
        { class: 'cards' },
        state.projects.map((project) => {
            const pct = project.shot_count
                ? Math.round((project.done_count / project.shot_count) * 100)
                : 0;
            const colour = projectColor(project.state);
            const cells: Child[] = [];
            for (let i = 0; i < 5; i++) {
                const url = project.strip[i];
                cells.push(
                    url
                        ? el('img', { src: url, alt: '', loading: 'lazy' })
                        : el('div', { class: 'blank' }),
                );
            }

            return el(
                'button',
                {
                    class: 'card',
                    type: 'button',
                    onclick: () => void openProject(project.id),
                },
                el('div', { class: 'strip' }, cells),
                el(
                    'div',
                    { class: 'body' },
                    el(
                        'div',
                        {
                            style: {
                                display: 'flex',
                                'align-items': 'flex-start',
                                'justify-content': 'space-between',
                                gap: '10px',
                            },
                        },
                        el('h2', null, project.name),
                        el('span', { class: 'pill', style: { color: colour } }, project.state),
                    ),
                    el('p', { class: 'logline' }, project.logline ?? 'No story saved yet.'),
                    el('div', { class: 'meter' }, el('i', { style: { width: `${pct}%` } })),
                    el(
                        'div',
                        { class: 'foot' },
                        el('span', null, `${project.done_count}/${project.shot_count} shots done`),
                        el('span', null, day(project.created_at)),
                    ),
                ),
            );
        }),
    );
}

// ---------------------------------------------------------------- shots tab

export function shotsView(snapshot: Snapshot): Child {
    const shots = filmShots(snapshot);
    if (shots.length === 0) {
        return el(
            'div',
            { class: 'empty' },
            'No shots in this project yet. Use ',
            el('b', null, '+ Add shot'),
            ' below, or run the ',
            el('b', null, '+ New short'),
            ' wizard to plan the whole thing.',
            el(
                'div',
                { style: { 'margin-top': '14px' } },
                el(
                    'button',
                    {
                        class: 'btn primary',
                        type: 'button',
                        onclick: () => {
                            state.newShotOpen = true;
                            render();
                        },
                    },
                    '+ Add shot',
                ),
            ),
        );
    }

    const order = shots.map((s) => s.shot_id);

    return el(
        'div',
        { class: 'shot-list' },
        selectionBar(shots),
        shots.map((shot) => shotRow(shot, order)),
        el(
            'div',
            null,
            el(
                'button',
                {
                    class: 'btn',
                    type: 'button',
                    onclick: () => {
                        state.newShotOpen = true;
                        render();
                    },
                },
                '+ Add shot',
            ),
        ),
    );
}

/**
 * The bulk action bar.
 *
 * Always present rather than appearing on first tick, so the select-all
 * control has somewhere to live and the row does not shift the list down the
 * moment you touch a checkbox. The destructive actions stay disabled until
 * something is actually selected.
 */
function selectionBar(shots: ShotView[]): Child {
    const chosen = shots.filter((s) => state.selected.has(s.shot_id));
    const withClips = chosen.filter((s) => s.video_url);
    const animatable = chosen.filter((s) => s.approved_asset_id);
    const allPicked = shots.length > 0 && chosen.length === shots.length;
    const none = chosen.length === 0;

    return el(
        'div',
        { class: `select-bar${none ? '' : ' active'}` },
        el(
            'label',
            { class: 'select-all' },
            el('input', {
                type: 'checkbox',
                checked: allPicked,
                onchange: () => {
                    if (allPicked) state.selected.clear();
                    else for (const s of shots) state.selected.add(s.shot_id);
                    state.lastPicked = null;
                    render();
                },
            }),
            el(
                'span',
                { class: 'mono' },
                none ? 'select all' : `${chosen.length} of ${shots.length} selected`,
            ),
        ),

        el('span', { class: 'spacer' }),

        el(
            'button',
            {
                class: `btn small${isBusy('batch-download') ? ' busy' : ''}`,
                type: 'button',
                disabled: withClips.length === 0,
                title:
                    withClips.length === 0
                        ? 'None of the selected shots has a rendered clip'
                        : `Save ${withClips.length} mp4 file${withClips.length === 1 ? '' : 's'}`,
                onclick: () => void downloadMany(withClips),
            },
            `↓ Download clips${withClips.length ? ` (${withClips.length})` : ''}`,
        ),
        el(
            'button',
            {
                class: `btn small accent-hover${isBusy('batch-animate') ? ' busy' : ''}`,
                type: 'button',
                disabled: animatable.length === 0,
                title:
                    animatable.length === 0
                        ? 'Selected shots have no approved still'
                        : 'Submit each selected shot for video generation',
                onclick: () =>
                    void runBatch('batch-animate', animatable, 'Submitted', (shot) =>
                        api.animate(shot.shot_id, {
                            motion_instruction:
                                shot.motion_instruction?.trim() ||
                                'slow push in, subtle atmospheric drift in the background',
                            duration: state.config?.defaults.duration,
                        }),
                    ),
            },
            'Animate',
        ),
        el(
            'button',
            {
                class: `btn small${isBusy('batch-regen') ? ' busy' : ''}`,
                type: 'button',
                disabled: none,
                onclick: () => {
                    if (
                        !window.confirm(
                            `Generate fresh variations for ${chosen.length} shot${
                                chosen.length === 1 ? '' : 's'
                            }? This spends credits per shot.`,
                        )
                    ) {
                        return;
                    }
                    void runBatch('batch-regen', chosen, 'Regenerated', (shot) =>
                        api.regenerate(shot.shot_id, {
                            count: state.config?.defaults.still_count ?? 4,
                        }),
                    );
                },
            },
            'Regenerate',
        ),
        el(
            'button',
            {
                class: `btn small danger${isBusy('batch-delete') ? ' busy' : ''}`,
                type: 'button',
                disabled: none,
                style: { background: 'transparent' },
                onclick: () => {
                    if (
                        !window.confirm(
                            `Delete ${chosen.length} shot${
                                chosen.length === 1 ? '' : 's'
                            }, including every still and clip on them? This cannot be undone.`,
                        )
                    ) {
                        return;
                    }
                    void (async () => {
                        await runBatch('batch-delete', chosen, 'Deleted', (shot) =>
                            api.deleteShot(shot.shot_id),
                        );
                        state.selected.clear();
                        render();
                    })();
                },
            },
            'Delete',
        ),
    );
}

/**
 * Save several clips in sequence.
 *
 * Browsers throttle or block a burst of programmatic downloads, so these are
 * spaced rather than fired at once. Chrome still asks permission once for
 * multiple files, which is the browser working correctly.
 */
async function downloadMany(shots: ShotView[]): Promise<void> {
    const name = state.snapshot?.project.name ?? 'short';
    await runBatch('batch-download', shots, 'Downloaded', async (shot) => {
        await downloadClip(
            shot.shot_id,
            `${name}-shot-${String(shot.shot_number).padStart(2, '0')}.mp4`,
        );
        await new Promise((resolve) => window.setTimeout(resolve, 400));
    });
}

function shotRow(shot: ShotView, order: string[]): HTMLElement {
    const cover = shot.stills.find((s) => s.approved) ?? shot.stills.at(-1);
    const label = shot.video_url ? 'clip' : shot.approved_asset_id ? 'still' : 'empty';
    const busyKey = `shot:${shot.shot_id}`;
    const picked = state.selected.has(shot.shot_id);

    return el(
        'article',
        { class: `shot${picked ? ' picked' : ''}` },
        el(
            'label',
            {
                class: 'shot-pick',
                title: 'Select this shot — shift-click to select a range',
                onclick: (event: MouseEvent) => {
                    // The label's own click drives selection, so the nested
                    // checkbox must not also toggle it.
                    event.preventDefault();
                    pick(shot.shot_id, order, event.shiftKey);
                },
            },
            el('input', { type: 'checkbox', checked: picked, tabindex: '-1' }),
        ),
        el(
            'div',
            {
                class: 'thumb-wrap',
                onclick: () => {
                    state.openShotId = shot.shot_id;
                    render();
                },
            },
            cover
                ? el('img', { class: 'thumb', src: cover.url, alt: '', loading: 'lazy' })
                : el('div', { class: 'thumb blank' }),
            el('span', { class: 'thumb-tag' }, label),
        ),

        el(
            'div',
            { class: 'mid' },
            el(
                'div',
                { class: 'row' },
                el('span', { class: 'num' }, shotLabel(shot.shot_number)),
                el(
                    'span',
                    { class: 'pill', style: { color: STATUS_COLOR[shot.status] ?? 'var(--muted)' } },
                    shot.status,
                ),
                el(
                    'span',
                    { class: 'meta' },
                    shot.stills.length
                        ? `${shot.stills.length} variation${shot.stills.length === 1 ? '' : 's'}`
                        : 'no still yet',
                ),
            ),
            el('p', { class: 'desc' }, shot.description),
            el('p', { class: 'motion' }, `motion: ${shot.motion_instruction ?? 'not planned'}`),
            el(
                'div',
                { class: 'actions' },
                el(
                    'button',
                    {
                        class: 'btn small',
                        type: 'button',
                        onclick: () => {
                            state.openShotId = shot.shot_id;
                            render();
                        },
                    },
                    'Open',
                ),
                el(
                    'button',
                    {
                        class: `btn small accent-hover${isBusy(`animate:${shot.shot_id}`) ? ' busy' : ''}`,
                        type: 'button',
                        disabled: !shot.approved_asset_id,
                        title: shot.approved_asset_id
                            ? 'Submit this shot for video generation'
                            : 'Approve a still variation first',
                        onclick: () => void animateShot(shot),
                    },
                    'Animate',
                ),
                shot.video_url &&
                    el(
                        'button',
                        {
                            class: `btn small${isBusy(`dl:${shot.shot_id}`) ? ' busy' : ''}`,
                            type: 'button',
                            title: 'Save the rendered mp4',
                            onclick: () => void downloadOne(shot),
                        },
                        '↓ Download',
                    ),
                el(
                    'button',
                    {
                        class: `btn small${isBusy(`regen:${shot.shot_id}`) ? ' busy' : ''}`,
                        type: 'button',
                        onclick: () =>
                            void act(
                                `regen:${shot.shot_id}`,
                                () =>
                                    api.regenerate(shot.shot_id, {
                                        count: state.config?.defaults.still_count ?? 4,
                                    }),
                                { success: `New variations for ${shotLabel(shot.shot_number)}.` },
                            ),
                    },
                    'Regenerate still',
                ),
                el(
                    'button',
                    {
                        class: `btn small danger${isBusy(busyKey) ? ' busy' : ''}`,
                        type: 'button',
                        style: { background: 'transparent' },
                        onclick: () => {
                            if (
                                !window.confirm(
                                    `Delete ${shotLabel(shot.shot_number)} and every still and clip on it? This cannot be undone.`,
                                )
                            ) {
                                return;
                            }
                            void act(busyKey, () => api.deleteShot(shot.shot_id), {
                                success: 'Shot deleted.',
                            });
                        },
                    },
                    'Delete',
                ),
            ),
        ),

        el(
            'div',
            { class: 'vars' },
            shot.stills.slice(-4).map((still, index) => variation(still, index, shot)),
        ),
    );
}

function variation(
    still: ShotView['stills'][number],
    index: number,
    shot: ShotView,
): HTMLElement {
    const rejected = still.critique?.verdict === 'regenerate' && !still.approved;
    return el(
        'button',
        {
            class: `var${still.approved ? ' on' : ''}${rejected ? ' rejected' : ''}`,
            type: 'button',
            title: still.approved
                ? 'Approved plate'
                : (still.critique?.reason ?? 'Approve this variation'),
            onclick: () =>
                void act(`approve:${still.asset_id}`, () => api.approve(still.asset_id), {
                    success: `${shotLabel(shot.shot_number)} plate approved.`,
                }),
        },
        el('img', { src: still.url, alt: '', loading: 'lazy' }),
        el('span', { class: 'badge' }, still.approved ? '✓' : String(index + 1)),
    );
}

/** Save one shot's clip. Downloads never refresh — nothing on the server changed. */
export async function downloadOne(shot: ShotView): Promise<void> {
    const name = state.snapshot?.project.name ?? 'short';
    await act(
        `dl:${shot.shot_id}`,
        () =>
            downloadClip(
                shot.shot_id,
                `${name}-shot-${String(shot.shot_number).padStart(2, '0')}.mp4`,
            ),
        { refresh: false },
    );
}

async function animateShot(shot: ShotView): Promise<void> {
    const motion = shot.motion_instruction?.trim();
    if (!motion) {
        // No planned motion: the drawer is where it gets written, and
        // guessing one on the user's behalf spends credits on a shot nobody
        // described.
        state.openShotId = shot.shot_id;
        render();
        toast('Write a motion instruction for this shot, then animate.', 'info');
        return;
    }
    await act(
        `animate:${shot.shot_id}`,
        () =>
            api.animate(shot.shot_id, {
                motion_instruction: motion,
                duration: state.config?.defaults.duration,
            }),
        { success: `${shotLabel(shot.shot_number)} submitted.` },
    );
}

// ---------------------------------------------------------------- story tab

export function storyView(snapshot: Snapshot): Child {
    const beats = filmShots(snapshot);

    return el(
        'div',
        { class: 'split' },
        el(
            'section',
            { class: 'panel' },
            el(
                'div',
                { class: 'head-row' },
                el('h3', null, 'STORY_TEXT'),
                el(
                    'span',
                    { class: 'mono dim', style: { 'font-size': '10px' } },
                    snapshot.manifest_updated_at
                        ? `saved ${day(snapshot.manifest_updated_at)}`
                        : 'never saved',
                ),
            ),
            state.editingStory
                ? el('textarea', {
                      class: 'field',
                      // Ids on the free-text fields so a background poll's
                      // re-render can put the caret back where it was.
                      id: 'story-editor',
                      style: { 'min-height': '260px' },
                      value: state.storyDraft,
                      oninput: (event: Event) => {
                          state.storyDraft = (event.target as HTMLTextAreaElement).value;
                      },
                  })
                : el(
                      'p',
                      { class: 'story-text' },
                      snapshot.story_text ?? 'No story saved for this project yet.',
                  ),
            el(
                'div',
                { style: { display: 'flex', gap: '8px', 'flex-wrap': 'wrap' } },
                el(
                    'button',
                    {
                        class: 'btn small',
                        type: 'button',
                        onclick: () => {
                            state.editingStory = !state.editingStory;
                            state.storyDraft = snapshot.story_text ?? '';
                            render();
                        },
                    },
                    state.editingStory ? 'Cancel' : 'Edit story',
                ),
                el(
                    'button',
                    {
                        class: `btn outline small${isBusy('manifest') ? ' busy' : ''}`,
                        type: 'button',
                        onclick: () => void saveStory(snapshot),
                    },
                    'save_story_manifest',
                ),
            ),
        ),

        el(
            'section',
            { class: 'panel' },
            el('h3', null, 'SHOT_BEATS'),
            beats.length === 0
                ? el('p', { class: 'muted', style: { margin: '0', 'font-size': '13px' } },
                      'No beats planned. The New short wizard writes these, or Claude can with save_story_manifest.')
                : beats.map((shot) =>
                      el(
                          'div',
                          { class: 'beat' },
                          el('span', { class: 'n' }, String(shot.shot_number).padStart(2, '0')),
                          el(
                              'div',
                              { style: { 'min-width': '0' } },
                              el('p', null, shot.story_beat ?? shot.description),
                              el(
                                  'p',
                                  { class: 'sub' },
                                  `${shot.camera_motion ?? 'camera not planned'} · ${shot.status}`,
                              ),
                          ),
                      ),
                  ),
        ),
    );
}

async function saveStory(snapshot: Snapshot): Promise<void> {
    const projectId = snapshot.project.id;
    const storyText = state.editingStory ? state.storyDraft : (snapshot.story_text ?? '');
    await act(
        'manifest',
        () =>
            api.saveManifest(projectId, {
                title: snapshot.title ?? snapshot.project.name,
                story_text: storyText,
                manifest: {
                    ...(snapshot.manifest ?? {}),
                    approved_story: storyText,
                },
            }),
        { success: 'Story manifest saved.' },
    );
    state.editingStory = false;
    render();
}

// ----------------------------------------------------------- references tab

const ROLES = ['character', 'character_turnaround', 'expression_sheet', 'prop', 'location', 'style', 'other'];

export function referencesView(snapshot: Snapshot): Child {
    const all = snapshot.references;
    const shown =
        state.refFilter === 'all' ? all : all.filter((r) => r.role === state.refFilter);
    const usedBy = referenceUsage(snapshot);

    const chip = (label: string, value: string, count: number) =>
        el(
            'button',
            {
                class: `chip${state.refFilter === value ? ' on' : ''}`,
                type: 'button',
                onclick: () => {
                    state.refFilter = value;
                    render();
                },
            },
            `${label} · ${count}`,
        );

    return el(
        'div',
        { style: { display: 'flex', 'flex-direction': 'column', gap: '14px' } },
        el(
            'div',
            { class: 'chips' },
            chip('all', 'all', all.length),
            ROLES.filter((role) => all.some((r) => r.role === role)).map((role) =>
                chip(role, role, all.filter((r) => r.role === role).length),
            ),
        ),
        el(
            'div',
            { class: 'ref-grid' },
            shown.map((ref) => referenceCard(ref, usedBy.get(ref.label.toLowerCase()) ?? [])),
            el(
                'button',
                {
                    class: 'add-ref',
                    type: 'button',
                    onclick: () => {
                        state.importOpen = true;
                        render();
                    },
                },
                '+ import_reference_image',
            ),
        ),
    );
}

/**
 * Which shots cite each reference, read from the manifest's needed_references.
 *
 * The database records that a reference exists, not where it is used — usage
 * is a planning fact, and the plan lives in the manifest.
 */
function referenceUsage(snapshot: Snapshot): Map<string, number[]> {
    const usage = new Map<string, number[]>();
    const shots = snapshot.manifest?.shots;
    if (!Array.isArray(shots)) return usage;
    for (const entry of shots) {
        if (!entry || typeof entry !== 'object') continue;
        const shot = entry as { shot_number?: number; needed_references?: unknown };
        const refs = Array.isArray(shot.needed_references) ? shot.needed_references : [];
        for (const raw of refs) {
            if (typeof raw !== 'string') continue;
            const key = raw.trim().toLowerCase();
            const list = usage.get(key) ?? [];
            if (shot.shot_number) list.push(shot.shot_number);
            usage.set(key, list);
        }
    }
    return usage;
}

function referenceCard(ref: ReferenceView, used: number[]): HTMLElement {
    return el(
        'figure',
        { class: 'ref' },
        el(
            'div',
            { class: 'plate' },
            ref.url && el('img', { src: ref.url, alt: ref.label, loading: 'lazy' }),
            el('span', { class: 'role' }, ref.role),
        ),
        el(
            'figcaption',
            null,
            el('span', { class: 'label' }, ref.label),
            el('span', { class: 'used' }, used.length ? `used in ${used.join(', ')}` : 'not cited yet'),
            el('span', { class: 'id' }, shortId(ref.asset_id)),
        ),
        el(
            'button',
            {
                class: `btn tiny rm${isBusy(`ref:${ref.reference_id}`) ? ' busy' : ''}`,
                type: 'button',
                onclick: () => {
                    if (!window.confirm(`Remove "${ref.label}" from the reference index?`)) return;
                    void act(`ref:${ref.reference_id}`, () => api.deleteReference(ref.reference_id), {
                        success: 'Reference removed.',
                    });
                },
            },
            'remove',
        ),
    );
}

// ----------------------------------------------------------------- jobs tab

export function jobsView(snapshot: Snapshot): Child {
    if (snapshot.jobs.length === 0) {
        return el(
            'div',
            { class: 'empty' },
            'No video jobs yet. Approve a still, then Animate.',
        );
    }

    const now = Date.now();

    return el(
        'div',
        { class: 'jobs' },
        el(
            'div',
            { class: 'job-head' },
            el('span', { style: { flex: '0 0 74px' } }, 'JOB'),
            el('span', { style: { flex: '0 0 46px' } }, 'SHOT'),
            el('span', { style: { flex: '1' } }, 'MOTION_INSTRUCTION'),
            el('span', { style: { flex: '0 0 92px' } }, 'STATUS'),
            el('span', { style: { flex: '0 0 64px' } }, 'ELAPSED'),
            el('span', { style: { flex: '0 0 92px' } }, 'ACTION'),
        ),
        snapshot.jobs.map((job) => {
            const live = job.status === 'submitted' || job.status === 'processing';
            const colour = STATUS_COLOR[job.status] ?? 'var(--muted)';
            const actionLabel =
                job.status === 'done'
                    ? 'Open clip'
                    : job.status === 'failed' || job.status === 'expired'
                      ? 'Retry'
                      : 'Cancel';

            return el(
                'div',
                { class: 'job' },
                el('span', { class: 'c-id' }, shortId(job.job_id)),
                el(
                    'span',
                    { class: 'c-shot' },
                    job.shot_number === null ? '—' : `S${String(job.shot_number).padStart(2, '0')}`,
                ),
                el('span', { class: 'c-motion', title: job.motion_instruction }, job.motion_instruction),
                el(
                    'span',
                    { class: `c-status${live ? ' live' : ''}`, style: { color: colour } },
                    el('i'),
                    job.status,
                ),
                el(
                    'span',
                    { class: 'c-elapsed' },
                    elapsed(live ? job.created_at : job.updated_at, now),
                ),
                el(
                    'button',
                    {
                        class: `btn small c-act${isBusy(`job:${job.job_id}`) ? ' busy' : ''}`,
                        type: 'button',
                        style: actionLabel === 'Retry' ? { color: 'var(--accent)' } : {},
                        onclick: () => void jobAction(job.job_id, actionLabel, job.shot_id),
                    },
                    actionLabel,
                ),
                job.error && el('p', { class: 'c-error' }, job.error),
            );
        }),
    );
}

async function jobAction(jobId: string, action: string, shotId: string): Promise<void> {
    if (action === 'Open clip') {
        state.openShotId = shotId;
        render();
        return;
    }
    if (action === 'Retry') {
        await act(`job:${jobId}`, () => api.retryJob(jobId), { success: 'Resubmitted.' });
        return;
    }
    if (!window.confirm('Stop tracking this job? The upstream generation still runs and is still billed.')) {
        return;
    }
    await act(`job:${jobId}`, () => api.cancelJob(jobId), { success: 'Job cancelled.' });
}
