import { api, type PlannedReference, type PlannedShot } from './client.js';
import { el, type Child } from './dom.js';
import { blankWizard, openProject, refresh, render, state, toast, type RunStep } from './store.js';

/**
 * "New short" — the whole pipeline, driven from the browser.
 *
 * The five steps are the ones the story skill walks a chat model through:
 * pitch, write, break into beats, plan references, run. Steps 1–4 call Grok
 * through /api/assist; step 5 turns the plan into real rows and real
 * generations.
 *
 * The run loop lives on the client rather than in a server-side job. That is
 * deliberate: eight shots is eight image generations of tens of seconds each,
 * and the honest way to present ten minutes of work is a visible list of steps
 * ticking over — not a spinner on a request that a proxy will time out anyway.
 * Each step is a normal API call that is safe on its own, so a closed tab
 * leaves finished shots finished rather than a half-written job row.
 */

const STEP_LABELS: Array<[number, string]> = [
    [1, '1 TOPIC'],
    [2, '2 STORY'],
    [3, '3 SHOTS'],
    [4, '4 REFS'],
    [5, '5 RUN'],
];

export function wizard(): Child {
    const w = state.wizard;
    if (!w.open) return null;

    const close = () => {
        if (w.running && !window.confirm('The pipeline is still running. Close anyway?')) return;
        state.wizard = blankWizard();
        render();
    };

    const goto = (step: 1 | 2 | 3 | 4 | 5) => {
        w.step = step;
        render();
    };

    return el(
        'div',
        {
            class: 'modal-scrim',
            onclick: (event: MouseEvent) => {
                if (event.target === event.currentTarget) close();
            },
        },
        el(
            'div',
            { class: 'modal wide' },
            el(
                'div',
                { class: 'head-row' },
                el('h2', null, 'New short — run the pipeline here'),
                el('button', { class: 'btn tiny', type: 'button', onclick: close }, '✕'),
            ),

            el(
                'div',
                { class: 'steps' },
                STEP_LABELS.map(([n, label]) =>
                    el(
                        'button',
                        {
                            class: `step${w.step === n ? ' on' : ''}${stepDone(n) ? ' done' : ''}`,
                            type: 'button',
                            onclick: () => goto(n as 1 | 2 | 3 | 4 | 5),
                        },
                        label,
                    ),
                ),
            ),

            el('div', { class: 'wiz-body' }, stepBody()),

            el(
                'div',
                { class: 'foot' },
                el(
                    'button',
                    {
                        class: 'btn ghost',
                        type: 'button',
                        disabled: w.step === 1,
                        onclick: () => goto((w.step - 1) as 1 | 2 | 3 | 4 | 5),
                    },
                    'Back',
                ),
                el(
                    'button',
                    {
                        class: `btn primary${w.running ? ' busy' : ''}`,
                        type: 'button',
                        disabled: w.running || !canAdvance(),
                        onclick: () => {
                            if (w.step === 5) void runPipeline();
                            else goto((w.step + 1) as 1 | 2 | 3 | 4 | 5);
                        },
                    },
                    w.step === 5 ? 'Run pipeline' : 'Continue',
                ),
            ),
        ),
    );
}

function stepDone(step: number): boolean {
    const w = state.wizard;
    if (step === 1) return Boolean(w.topic.trim() || w.chosenPitch !== null);
    if (step === 2) return w.storyText.trim().length > 40;
    if (step === 3) return w.shots.length > 0;
    if (step === 4) return w.references.length > 0 || w.shots.length > 0;
    return w.log.some((entry) => entry.state === 'ok');
}

function canAdvance(): boolean {
    const w = state.wizard;
    if (w.step === 2) return w.storyText.trim().length > 40;
    if (w.step === 3) return w.shots.length > 0;
    if (w.step === 5) return w.shots.length > 0 && !w.running;
    return true;
}

/** Run an assist call with the wizard's own busy flag. */
async function assist<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const w = state.wizard;
    if (w.busy) return undefined;
    w.busy = true;
    render();
    try {
        return await fn();
    } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'err');
        return undefined;
    } finally {
        w.busy = false;
        render();
    }
}

// -------------------------------------------------------------- step bodies

function stepBody(): Child {
    const w = state.wizard;
    switch (w.step) {
        case 1:
            return topicStep();
        case 2:
            return storyStep();
        case 3:
            return shotsStep();
        case 4:
            return refsStep();
        default:
            return runStep();
    }
}

function topicStep(): Child {
    const w = state.wizard;
    return [
        el('span', { class: 'lbl' }, '1 TOPIC'),
        el(
            'p',
            null,
            'Give a topic, or leave it blank and let Grok pitch five hooks. Pick one and its logline becomes the story brief.',
        ),
        el('input', {
            class: 'field',
            id: 'wiz-name',
            placeholder: 'Project name — e.g. The Last Loaf of Pompeii',
            value: w.projectName,
            oninput: (event: Event) => {
                w.projectName = (event.target as HTMLInputElement).value;
            },
        }),
        el('textarea', {
            class: 'field',
            style: { 'min-height': '70px' },
            id: 'wiz-topic',
            placeholder: 'e.g. objects that survived a disaster intact',
            value: w.topic,
            oninput: (event: Event) => {
                w.topic = (event.target as HTMLTextAreaElement).value;
            },
        }),
        el(
            'button',
            {
                class: `btn${w.busy ? ' busy' : ''}`,
                type: 'button',
                style: { 'align-self': 'flex-start' },
                onclick: () => {
                    void (async () => {
                        const result = await assist(() => api.pitch(w.topic.trim() || undefined));
                        if (!result) return;
                        w.pitches = result.pitches;
                        w.chosenPitch = null;
                        render();
                    })();
                },
            },
            w.pitches.length ? 'Pitch five more' : 'Pitch five ideas',
        ),
        w.pitches.map((pitch, index) =>
            el(
                'button',
                {
                    class: `pitch${w.chosenPitch === index ? ' on' : ''}`,
                    type: 'button',
                    onclick: () => {
                        w.chosenPitch = index;
                        w.title = pitch.title;
                        w.logline = pitch.logline;
                        if (!w.projectName.trim()) w.projectName = pitch.title;
                        w.topic = `${pitch.title}. ${pitch.logline}`;
                        render();
                    },
                },
                el('b', null, pitch.title),
                el('span', { class: 'hook' }, pitch.hook),
                el('span', { class: 'why' }, pitch.why_it_travels),
            ),
        ),
    ];
}

function storyStep(): Child {
    const w = state.wizard;
    return [
        el('span', { class: 'lbl' }, '2 STORY · about 40 seconds read aloud'),
        el('textarea', {
            class: 'field',
            style: { 'min-height': '200px' },
            id: 'wiz-story',
            placeholder: 'Draft it with Grok, or paste your own story here.',
            value: w.storyText,
            oninput: (event: Event) => {
                w.storyText = (event.target as HTMLTextAreaElement).value;
            },
        }),
        el('input', {
            class: 'field',
            id: 'wiz-notes',
            placeholder: 'Notes for a revision — e.g. colder ending, cut the second example',
            value: w.notes,
            oninput: (event: Event) => {
                w.notes = (event.target as HTMLInputElement).value;
            },
        }),
        el(
            'div',
            { style: { display: 'flex', gap: '8px', 'flex-wrap': 'wrap' } },
            el(
                'button',
                {
                    class: `btn${w.busy ? ' busy' : ''}`,
                    type: 'button',
                    onclick: () => {
                        void (async () => {
                            const result = await assist(() =>
                                api.story({
                                    topic: w.topic.trim() || undefined,
                                    draft: w.storyText.trim() || undefined,
                                    notes: w.notes.trim() || undefined,
                                }),
                            );
                            if (!result) return;
                            w.storyText = result.story_text;
                            w.title = result.title || w.title;
                            w.logline = result.logline || w.logline;
                            if (!w.projectName.trim()) w.projectName = result.title;
                            w.notes = '';
                            render();
                        })();
                    },
                },
                w.storyText.trim() ? 'Revise with Grok' : 'Draft with Grok',
            ),
        ),
    ];
}

function shotsStep(): Child {
    const w = state.wizard;
    return [
        el('span', { class: 'lbl' }, `3 SHOTS · chunks of ${state.config?.defaults.duration ?? 5} seconds`),
        el(
            'div',
            { style: { display: 'flex', gap: '8px', 'align-items': 'flex-end', 'flex-wrap': 'wrap' } },
            el(
                'div',
                { style: { flex: '0 0 110px' } },
                el('label', { class: 'lbl' }, 'HOW MANY'),
                el('input', {
                    class: 'field',
                    type: 'number',
                    min: '2',
                    max: '20',
                    value: String(w.shotCount),
                    oninput: (event: Event) => {
                        w.shotCount = Number((event.target as HTMLInputElement).value) || 8;
                    },
                }),
            ),
            el(
                'button',
                {
                    class: `btn${w.busy ? ' busy' : ''}`,
                    type: 'button',
                    onclick: () => {
                        void (async () => {
                            const result = await assist(() =>
                                api.planShots(w.storyText.trim(), w.shotCount),
                            );
                            if (!result) return;
                            w.shots = result.shots;
                            w.references = [];
                            render();
                        })();
                    },
                },
                w.shots.length ? 'Re-break the story' : 'Break into chunks',
            ),
        ),
        w.shots.length === 0
            ? el('p', { class: 'muted' }, 'Each chunk gets a story beat, a visual description, a camera motion and a motion instruction.')
            : w.shots.map((shot, index) => plannedShotRow(shot, index)),
    ];
}

function plannedShotRow(shot: PlannedShot, index: number): Child {
    const w = state.wizard;
    return el(
        'div',
        { class: 'plan-row' },
        el('span', { class: 'n' }, `SHOT ${String(shot.shot_number).padStart(2, '0')} · ${shot.camera_motion}`),
        el('textarea', {
            class: 'field',
            style: { 'min-height': '58px' },
            value: shot.visual_description,
            oninput: (event: Event) => {
                w.shots[index] = {
                    ...shot,
                    visual_description: (event.target as HTMLTextAreaElement).value,
                };
            },
        }),
        el('input', {
            class: 'field',
            value: shot.motion_instruction,
            oninput: (event: Event) => {
                w.shots[index] = {
                    ...w.shots[index]!,
                    motion_instruction: (event.target as HTMLInputElement).value,
                };
            },
        }),
        el(
            'span',
            { class: 'mono dim', style: { 'font-size': '10.5px' } },
            `refs: ${(shot.needed_references ?? []).join(', ') || 'none'}`,
        ),
    );
}

function refsStep(): Child {
    const w = state.wizard;
    return [
        el('span', { class: 'lbl' }, '4 REFS · the minimum plates for continuity'),
        el(
            'p',
            null,
            'Reference plates are what stop a character drifting between shots. Tick the ones Grok should generate before the shots run; anything unticked you can upload later from the References tab.',
        ),
        el(
            'button',
            {
                class: `btn${w.busy ? ' busy' : ''}`,
                type: 'button',
                style: { 'align-self': 'flex-start' },
                onclick: () => {
                    void (async () => {
                        const result = await assist(() => api.planReferences(w.shots));
                        if (!result) return;
                        w.references = result.references;
                        w.generateRefs = new Set(result.references.map((r) => r.label));
                        render();
                    })();
                },
            },
            w.references.length ? 'Re-plan references' : 'Plan references',
        ),
        w.references.map((ref) => plannedRefRow(ref)),
    ];
}

function plannedRefRow(ref: PlannedReference): Child {
    const w = state.wizard;
    const checked = w.generateRefs.has(ref.label);
    return el(
        'label',
        { class: 'plan-row', style: { cursor: 'pointer' } },
        el(
            'span',
            { style: { display: 'flex', gap: '8px', 'align-items': 'center' } },
            el('input', {
                type: 'checkbox',
                checked,
                onchange: (event: Event) => {
                    if ((event.target as HTMLInputElement).checked) w.generateRefs.add(ref.label);
                    else w.generateRefs.delete(ref.label);
                    render();
                },
            }),
            el('span', { class: 'n' }, ref.role),
            el('b', null, ref.label),
        ),
        el('span', { style: { 'font-size': '13px', color: 'var(--fg-4)' } }, ref.description),
        el(
            'span',
            { class: 'mono dim', style: { 'font-size': '10.5px' } },
            `used in ${(ref.used_in ?? []).join(', ') || '—'}`,
        ),
    );
}

function runStep(): Child {
    const w = state.wizard;
    const plates = w.references.filter((r) => w.generateRefs.has(r.label)).length;
    return [
        el('span', { class: 'lbl' }, '5 RUN'),
        el(
            'p',
            null,
            `This creates the project, saves the manifest, generates ${plates} reference plate${
                plates === 1 ? '' : 's'
            }, then generates stills for ${w.shots.length} shots. Video is not submitted — review the stills first, then use Animate approved.`,
        ),
        w.log.length > 0 &&
            el(
                'div',
                { class: 'run-log' },
                w.log.map((entry) =>
                    el(
                        'div',
                        {
                            class:
                                entry.state === 'ok'
                                    ? 'ok'
                                    : entry.state === 'error'
                                      ? 'err'
                                      : 'pend',
                        },
                        `${marker(entry)} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`,
                    ),
                ),
            ),
    ];
}

function marker(entry: RunStep): string {
    if (entry.state === 'ok') return '✓';
    if (entry.state === 'error') return '✕';
    if (entry.state === 'running') return '…';
    return '·';
}

// ------------------------------------------------------------------ the run

async function runPipeline(): Promise<void> {
    const w = state.wizard;
    if (w.running) return;

    const name = w.projectName.trim() || w.title.trim() || 'Untitled short';
    const plates = w.references.filter((r) => w.generateRefs.has(r.label));

    w.running = true;
    w.log = [
        { label: `Create project "${name}"`, state: 'pending' },
        { label: 'Save story manifest', state: 'pending' },
        ...plates.map((r) => ({ label: `Reference plate — ${r.label}`, state: 'pending' as const })),
        ...w.shots.map((s) => ({
            label: `Shot ${String(s.shot_number).padStart(2, '0')} stills`,
            state: 'pending' as const,
        })),
    ];
    render();

    let cursor = 0;
    const step = async (fn: () => Promise<string | void>): Promise<boolean> => {
        const entry = w.log[cursor];
        if (!entry) return false;
        entry.state = 'running';
        render();
        try {
            const detail = await fn();
            entry.state = 'ok';
            if (detail) entry.detail = detail;
            return true;
        } catch (err) {
            entry.state = 'error';
            entry.detail = err instanceof Error ? err.message : String(err);
            return false;
        } finally {
            cursor++;
            render();
        }
    };

    let projectId = '';
    const madeProject = await step(async () => {
        const created = await api.createProject(name);
        projectId = created.project.id;
    });
    if (!madeProject) {
        w.running = false;
        render();
        return;
    }

    await step(async () => {
        await api.saveManifest(projectId, {
            title: w.title || name,
            story_text: w.storyText.trim(),
            manifest: {
                approved_story: w.storyText.trim(),
                logline: w.logline,
                shots: w.shots,
                references: w.references,
            },
        });
    });

    // Plates first: a shot that cites a reference wants that reference to
    // already exist, and generating them up front is what makes the character
    // survive from shot one to shot eight.
    const plateAssets = new Map<string, string>();
    for (const plate of plates) {
        await step(async () => {
            const made = await api.generateReference(projectId, {
                label: plate.label,
                role: plate.role,
                description: plate.description,
            });
            plateAssets.set(plate.label.toLowerCase(), made.asset_id);
            return 'saved';
        });
    }

    const maxRefs = state.config?.defaults.max_reference_images ?? 3;
    for (const shot of w.shots) {
        await step(async () => {
            const refs = (shot.needed_references ?? [])
                .map((label) => plateAssets.get(String(label).trim().toLowerCase()))
                .filter((id): id is string => Boolean(id))
                .slice(0, maxRefs);

            const created = await api.createShot(projectId, {
                description: shot.visual_description,
                shot_number: shot.shot_number,
                reference_asset_ids: refs,
            });
            return `${created.stills.length} variations`;
        });
    }

    w.running = false;
    render();

    const failed = w.log.filter((entry) => entry.state === 'error').length;
    if (failed > 0) toast(`Finished with ${failed} failed step${failed === 1 ? '' : 's'}.`, 'err');
    else toast('Pipeline complete. Approve a plate per shot, then Animate approved.', 'ok');

    await refresh();
    await openProject(projectId);
    state.wizard = blankWizard();
    render();
}
