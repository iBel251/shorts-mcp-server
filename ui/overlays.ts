import {
    api,
    fileToBase64,
    type Critique,
    type ShotView,
    type Snapshot,
    type StillView,
} from './client.js';
import { el, shortId, shotLabel, type Child } from './dom.js';
import { act, finishedClips, isBusy, render, state, toast } from './store.js';

/**
 * Everything that floats above the main surface.
 *
 * These share one rule: the underlying data is never mutated optimistically.
 * A drawer showing an approved plate is showing what the database says, which
 * is why closing and reopening it can never disagree with the list behind it.
 */

// ------------------------------------------------------------- shot drawer

export function shotDrawer(snapshot: Snapshot): Child {
    const shot = snapshot.shots.find((s) => s.shot_id === state.openShotId);
    if (!shot) return null;

    const close = () => {
        state.openShotId = null;
        render();
    };

    // The critique shown is the one for the plate in play: the approved still
    // if there is one, otherwise the most recent variation. Showing an
    // arbitrary sibling's verdict next to a chosen plate would be misleading.
    const focus = shot.stills.find((s) => s.approved) ?? shot.stills.at(-1);

    return [
        el('button', { class: 'scrim', type: 'button', 'aria-label': 'Close', onclick: close }),
        el(
            'aside',
            { class: 'drawer' },
            el(
                'div',
                {
                    style: {
                        display: 'flex',
                        'justify-content': 'space-between',
                        'align-items': 'flex-start',
                        gap: '12px',
                    },
                },
                el(
                    'div',
                    null,
                    el('h2', null, `Shot ${String(shot.shot_number).padStart(2, '0')} · ${shot.status}`),
                    el(
                        'p',
                        { class: 'ids' },
                        `shot_id ${shortId(shot.shot_id)} · project ${shortId(snapshot.project.id)}`,
                    ),
                ),
                el('button', { class: 'btn tiny', type: 'button', onclick: close }, '✕'),
            ),

            el('p', { style: { margin: '0', 'font-size': '13.5px', color: 'var(--fg-4)' }, class: 'pretty' }, shot.description),

            shot.stills.length > 0 &&
                el(
                    'div',
                    { class: 'sec' },
                    el('span', { class: 'lbl' }, 'STILL VARIATIONS · click to approve_still'),
                    el(
                        'div',
                        { class: 'grid4' },
                        shot.stills.map((still, index) => drawerVariation(still, index, shot)),
                    ),
                ),

            focus?.critique && critiquePanel(focus.critique),

            el(
                'div',
                { class: 'sec' },
                el('span', { class: 'lbl' }, 'CLIP'),
                shot.video_url
                    ? el(
                          'div',
                          { class: 'clip' },
                          el('video', {
                              src: shot.video_url,
                              controls: true,
                              playsinline: true,
                              preload: 'metadata',
                          }),
                      )
                    : el(
                          'div',
                          { class: 'clip placeholder' },
                          el(
                              'span',
                              { class: 'mono', style: { 'font-size': '11px', color: 'var(--muted-2)' } },
                              shot.status === 'animating' ? 'job running…' : 'not animated yet',
                          ),
                      ),
                el(
                    'div',
                    { class: 'frames' },
                    frameTile('first_frame', shot.first_frame_url),
                    frameTile('last_frame', shot.last_frame_url),
                ),
            ),

            el(
                'div',
                { class: 'sec' },
                el('label', { class: 'lbl', for: 'motion-input' }, 'MOTION_INSTRUCTION'),
                el('textarea', {
                    class: 'field',
                    id: 'motion-input',
                    style: { 'min-height': '70px' },
                    placeholder: 'slow push in, dust drifting in the light',
                    value: shot.motion_instruction ?? '',
                }),
                el(
                    'span',
                    { class: 'mono dim', style: { 'font-size': '10px' } },
                    'One camera move, one restrained subject action, subtle background motion.',
                ),
            ),

            el(
                'div',
                { class: 'foot' },
                el(
                    'button',
                    {
                        class: `btn primary${isBusy(`animate:${shot.shot_id}`) ? ' busy' : ''}`,
                        type: 'button',
                        disabled: !shot.approved_asset_id,
                        title: shot.approved_asset_id ? '' : 'Approve a still first',
                        onclick: () => void animateFromDrawer(shot),
                    },
                    'Animate shot',
                ),
                el(
                    'button',
                    {
                        class: `btn${isBusy(`regen:${shot.shot_id}`) ? ' busy' : ''}`,
                        type: 'button',
                        onclick: () =>
                            void act(
                                `regen:${shot.shot_id}`,
                                () =>
                                    api.regenerate(shot.shot_id, {
                                        count: state.config?.defaults.still_count ?? 4,
                                    }),
                                { success: 'New variations generated.' },
                            ),
                    },
                    'Regenerate still',
                ),
            ),
        ),
    ];
}

function drawerVariation(still: StillView, index: number, shot: ShotView): HTMLElement {
    return el(
        'button',
        {
            class: `var${still.approved ? ' on' : ''}`,
            type: 'button',
            title: still.critique?.reason ?? 'Approve this variation',
            onclick: () =>
                void act(`approve:${still.asset_id}`, () => api.approve(still.asset_id), {
                    success: `${shotLabel(shot.shot_number)} plate approved.`,
                }),
        },
        el('img', { src: still.url, alt: '', loading: 'lazy' }),
        el('span', { class: 'badge' }, still.approved ? '✓' : String(index + 1)),
    );
}

function frameTile(label: string, url: string | null): HTMLElement {
    return el(
        'button',
        {
            type: 'button',
            disabled: !url,
            title: url ? 'Open the full-resolution frame' : 'Not extracted yet',
            onclick: () => {
                if (url) window.open(url, '_blank', 'noopener');
            },
        },
        label,
    );
}

function critiquePanel(critique: Critique): HTMLElement {
    if (critique.error) {
        return el(
            'div',
            { class: 'critique' },
            el('span', { class: 'lbl' }, 'VISION CRITIQUE'),
            el('p', null, `The critique pass did not complete: ${critique.error}`),
        );
    }

    const accepted = critique.verdict === 'accept';
    const flag = (label: string, ok: boolean) =>
        el(
            'span',
            { class: 'flag', style: { color: ok ? 'var(--good)' : 'var(--bad)' } },
            `${label} ${ok}`,
        );

    return el(
        'div',
        { class: 'critique' },
        el(
            'div',
            { class: 'row' },
            el(
                'span',
                { class: 'lbl', style: { margin: '0' } },
                `VISION CRITIQUE · ${state.config?.vision_model ?? 'grok'}`,
            ),
            el(
                'span',
                {
                    class: 'pill',
                    style: { color: accepted ? 'var(--good)' : 'var(--bad)' },
                },
                critique.verdict ?? 'unknown',
            ),
        ),
        el(
            'div',
            { class: 'flags' },
            flag('style_ok', Boolean(critique.style_ok)),
            flag('palette_ok', Boolean(critique.palette_ok)),
            flag('framing_ok', Boolean(critique.framing_ok)),
            flag('faces_to_camera', !critique.faces_to_camera),
            flag('visible_text', !critique.visible_text),
        ),
        critique.reason && el('p', null, critique.reason),
        critique.anatomy_issues && el('p', { class: 'fix' }, `anatomy: ${critique.anatomy_issues}`),
        critique.fix_suggestion && el('p', { class: 'fix' }, `fix: ${critique.fix_suggestion}`),
    );
}

async function animateFromDrawer(shot: ShotView): Promise<void> {
    const input = document.getElementById('motion-input') as HTMLTextAreaElement | null;
    const motion = input?.value.trim();
    if (!motion) {
        toast('A motion instruction is required — describe the one thing that moves.', 'err');
        input?.focus();
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

// ---------------------------------------------------------------- rough cut

/**
 * Sequential playback of the finished clips.
 *
 * No concatenation happens anywhere: the clips are separate files and this
 * plays them back to back, advancing on `ended`. That is honest about what
 * exists — there is no rendered edit on the server, and pretending otherwise
 * would mean promising a download that does not exist.
 */
export function roughCut(snapshot: Snapshot): Child {
    if (!state.roughCut) return null;
    const clips = finishedClips(snapshot);
    const index = Math.min(state.cutIndex, Math.max(clips.length - 1, 0));
    const current = clips[index];
    const close = () => {
        state.roughCut = false;
        render();
    };

    const go = (next: number) => {
        state.cutIndex = Math.max(0, Math.min(clips.length - 1, next));
        render();
    };

    return el(
        'div',
        { class: 'cut' },
        el(
            'div',
            { class: 'bar' },
            el(
                'div',
                null,
                el('h2', null, `Rough cut · ${snapshot.project.name}`),
                el(
                    'p',
                    { class: 'mono dim', style: { margin: '2px 0 0', 'font-size': '11px' } },
                    clips.length
                        ? `clip ${index + 1} of ${clips.length} · plays straight through`
                        : 'no finished clips yet',
                ),
            ),
            el('button', { class: 'btn tiny', type: 'button', onclick: close }, '✕ close'),
        ),

        el(
            'div',
            { class: 'stage' },
            current?.video_url
                ? el('video', {
                      src: current.video_url,
                      controls: true,
                      autoplay: true,
                      playsinline: true,
                      // Auto-advance is what makes this a cut rather than a
                      // list of files.
                      onended: () => {
                          if (index < clips.length - 1) go(index + 1);
                      },
                  })
                : el(
                      'div',
                      {
                          style: {
                              display: 'flex',
                              height: '100%',
                              'align-items': 'center',
                              'justify-content': 'center',
                          },
                      },
                      el('span', { class: 'mono dim', style: { 'font-size': '11px' } }, 'nothing to play'),
                  ),
        ),

        el(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            el(
                'button',
                { class: 'btn', type: 'button', disabled: index === 0, onclick: () => go(index - 1) },
                '◀ prev',
            ),
            el(
                'button',
                {
                    class: 'btn',
                    type: 'button',
                    disabled: index >= clips.length - 1,
                    onclick: () => go(index + 1),
                },
                'next ▶',
            ),
        ),

        el(
            'div',
            { class: 'strip' },
            clips.map((clip, i) => {
                const cover = clip.stills.find((s) => s.approved) ?? clip.stills.at(-1);
                return el(
                    'button',
                    {
                        class: i === index ? 'on' : '',
                        type: 'button',
                        title: shotLabel(clip.shot_number),
                        onclick: () => go(i),
                    },
                    cover && el('img', { src: cover.url, alt: '', loading: 'lazy' }),
                );
            }),
        ),
    );
}

// -------------------------------------------------------------- add a shot

export function addShotModal(snapshot: Snapshot): Child {
    if (!state.newShotOpen) return null;
    const close = () => {
        state.newShotOpen = false;
        render();
    };

    const description = el('textarea', {
        class: 'field',
        placeholder:
            'Interior bakery at dawn, flour dust hanging in the light from a high window, hands shaping dough on a stone counter.',
    });
    const motion = el('input', {
        class: 'field',
        placeholder: 'slow push in on the hands, dust drifting',
    });
    const count = el('input', {
        class: 'field',
        type: 'number',
        min: '1',
        max: String(state.config?.defaults.max_still_count ?? 8),
        value: String(state.config?.defaults.still_count ?? 4),
    });
    const refPicker = el(
        'select',
        { class: 'field', multiple: true, size: String(Math.min(snapshot.references.length, 4) || 1) },
        snapshot.references.map((ref) =>
            el('option', { value: ref.asset_id }, `${ref.role} · ${ref.label}`),
        ),
    );

    return modal(
        'Add a shot',
        close,
        [
            el(
                'div',
                null,
                el('label', { class: 'lbl' }, 'VISUAL_DESCRIPTION — subject, action, setting. No style words.'),
                description,
            ),
            el(
                'div',
                null,
                el('label', { class: 'lbl' }, 'MOTION_INSTRUCTION — saved to the manifest for later'),
                motion,
            ),
            el(
                'div',
                { style: { display: 'flex', gap: '12px', 'flex-wrap': 'wrap' } },
                el(
                    'div',
                    { style: { flex: '0 0 120px' } },
                    el('label', { class: 'lbl' }, 'VARIATIONS'),
                    count,
                ),
                snapshot.references.length > 0 &&
                    el(
                        'div',
                        { style: { flex: '1 1 240px' } },
                        el(
                            'label',
                            { class: 'lbl' },
                            `REFERENCES — up to ${state.config?.defaults.max_reference_images ?? 3}, for continuity`,
                        ),
                        refPicker,
                    ),
            ),
        ],
        el(
            'button',
            {
                class: `btn primary${isBusy('new-shot') ? ' busy' : ''}`,
                type: 'button',
                onclick: () => {
                    const text = description.value.trim();
                    if (!text) {
                        toast('Describe the shot first.', 'err');
                        return;
                    }
                    const refs = [...refPicker.selectedOptions]
                        .map((o) => o.value)
                        .slice(0, state.config?.defaults.max_reference_images ?? 3);

                    void (async () => {
                        const created = await act(
                            'new-shot',
                            () =>
                                api.createShot(snapshot.project.id, {
                                    description: text,
                                    count: Number(count.value) || undefined,
                                    reference_asset_ids: refs,
                                }),
                            { success: 'Shot generated.' },
                        );
                        if (!created) return;
                        const planned = motion.value.trim();
                        if (planned) {
                            await saveMotionToManifest(created.shot_number, planned, text);
                        }
                        state.newShotOpen = false;
                        render();
                    })();
                },
            },
            'Generate stills',
        ),
    );
}

/**
 * Record a shot's planned motion in the manifest.
 *
 * The `shots` table has no motion column — motion belongs to the plan, and the
 * plan is the manifest. Writing it here means the Shots list, the Story tab and
 * `get_story_manifest` all read the same value.
 */
async function saveMotionToManifest(
    shotNumber: number,
    motionInstruction: string,
    visualDescription: string,
): Promise<void> {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const manifest = { ...(snapshot.manifest ?? {}) } as Record<string, unknown>;
    const shots = Array.isArray(manifest.shots) ? [...(manifest.shots as unknown[])] : [];
    const at = shots.findIndex(
        (entry) =>
            entry &&
            typeof entry === 'object' &&
            (entry as { shot_number?: number }).shot_number === shotNumber,
    );
    const merged = {
        ...(at >= 0 ? (shots[at] as Record<string, unknown>) : {}),
        shot_number: shotNumber,
        visual_description: visualDescription,
        motion_instruction: motionInstruction,
    };
    if (at >= 0) shots[at] = merged;
    else shots.push(merged);
    manifest.shots = shots;

    await act('manifest', () =>
        api.saveManifest(snapshot.project.id, {
            title: snapshot.title ?? snapshot.project.name,
            story_text: snapshot.story_text ?? '',
            manifest,
        }),
    );
}

// ------------------------------------------------------- reference import

export function importModal(snapshot: Snapshot): Child {
    if (!state.importOpen) return null;
    const close = () => {
        state.importOpen = false;
        render();
    };

    const label = el('input', { class: 'field', placeholder: 'Baker — Modestus' });
    const role = el(
        'select',
        { class: 'field' },
        ['character', 'character_turnaround', 'expression_sheet', 'prop', 'location', 'style', 'other'].map(
            (r) => el('option', { value: r }, r),
        ),
    );
    const url = el('input', { class: 'field', placeholder: 'https://… (public image URL)' });
    const file = el('input', { class: 'field', type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const description = el('textarea', {
        class: 'field',
        style: { 'min-height': '70px' },
        placeholder:
            'Middle-aged baker, flour-dusted forearms, leather apron, waist-up, facing three-quarters away.',
    });

    return modal(
        'Add a reference plate',
        close,
        [
            el('div', null, el('label', { class: 'lbl' }, 'LABEL'), label),
            el('div', null, el('label', { class: 'lbl' }, 'ROLE'), role),
            el(
                'div',
                null,
                el('label', { class: 'lbl' }, 'UPLOAD A PLATE — png, jpeg or webp'),
                file,
                el(
                    'div',
                    { style: { 'margin-top': '8px' } },
                    el('label', { class: 'lbl' }, 'OR IMPORT FROM A PUBLIC URL'),
                    url,
                ),
            ),
            el(
                'div',
                null,
                el(
                    'label',
                    { class: 'lbl' },
                    'OR DESCRIBE IT AND LET GROK MAKE IT — subject and framing only, no style words',
                ),
                description,
            ),
        ],
        el(
            'div',
            { style: { display: 'flex', gap: '8px', 'flex-wrap': 'wrap' } },
            el(
                'button',
                {
                    class: `btn${isBusy('ref-import') ? ' busy' : ''}`,
                    type: 'button',
                    onclick: () => {
                        void (async () => {
                            const name = label.value.trim();
                            if (!name) return toast('Give the reference a label.', 'err');
                            const chosen = file.files?.[0];
                            if (!chosen && !url.value.trim()) {
                                return toast('Choose a file or paste a URL.', 'err');
                            }
                            const payload = chosen
                                ? { image_base64: await fileToBase64(chosen) }
                                : { image_url: url.value.trim() };
                            const done = await act(
                                'ref-import',
                                () =>
                                    api.importReference(snapshot.project.id, {
                                        label: name,
                                        role: role.value,
                                        ...payload,
                                    }),
                                { success: 'Reference imported.' },
                            );
                            if (done) {
                                state.importOpen = false;
                                render();
                            }
                        })();
                    },
                },
                'Import plate',
            ),
            el(
                'button',
                {
                    class: `btn primary${isBusy('ref-generate') ? ' busy' : ''}`,
                    type: 'button',
                    onclick: () => {
                        const name = label.value.trim();
                        const desc = description.value.trim();
                        if (!name) return toast('Give the reference a label.', 'err');
                        if (!desc) return toast('Describe the plate for Grok to generate.', 'err');
                        void (async () => {
                            const done = await act(
                                'ref-generate',
                                () =>
                                    api.generateReference(snapshot.project.id, {
                                        label: name,
                                        role: role.value,
                                        description: desc,
                                    }),
                                { success: 'Plate generated and saved.' },
                            );
                            if (done) {
                                state.importOpen = false;
                                render();
                            }
                        })();
                    },
                },
                'Generate with Grok',
            ),
        ),
    );
}

// -------------------------------------------------------------- modal shell

/** Scrim + panel + header + footer, shared by the two dialogs above. */
function modal(title: string, close: () => void, bodyChildren: Child[], footer: Child): HTMLElement {
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
            { class: 'modal' },
            el(
                'div',
                { class: 'head-row' },
                el('h2', null, title),
                el('button', { class: 'btn tiny', type: 'button', onclick: close }, '✕'),
            ),
            el(
                'div',
                { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } },
                bodyChildren,
            ),
            el('div', { class: 'foot', style: { 'justify-content': 'flex-end' } }, footer),
        ),
    );
}
