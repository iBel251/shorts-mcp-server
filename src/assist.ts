import { chatText, parseJson } from './chat.js';
import { DEFAULT_DURATION } from './config.js';
import { errorMessage, log } from './logger.js';

/**
 * The story assistant behind the studio's "New short" wizard.
 *
 * The wizard's first three steps — pitch hooks, write a 40-second story, break
 * it into 5-second chunks — are the same steps the grok-shorts-story skill
 * walks a chat model through. In the UI there is no chat model in the loop, so
 * the server does it against xAI directly.
 *
 * Two rules are enforced in the prompts rather than left to taste, because both
 * are load-bearing for the rest of the pipeline:
 *
 *   1. `visual_description` must contain no style language. config.ts appends
 *      the locked style block to every prompt, and a description that also
 *      describes the style double-weights it and skews the generation.
 *   2. `motion_instruction` describes one camera move, one restrained subject
 *      action and subtle background motion — the shape the video model was
 *      tuned against here. Anything more ambitious morphs.
 */

const STORY_GUIDE = [
    'Write a short cinematic cause-and-effect narrative for a vertical short.',
    'Structure: hook with the most surprising fact first, then context, then the',
    'person or force that changes the situation, the decisive action, the',
    'opposition, two or three escalating consequences, and a final line that',
    'lands the point. Present tense or past tense, but consistent. No narrator',
    'addressing the viewer, no questions to the audience, no calls to action,',
    'no emoji, no hashtags, no headings.',
].join(' ');

const MOTION_GUIDE = [
    'Each motion_instruction names exactly one camera move (slow push in, slow',
    'pull out, slow pan, low-angle push in, high-angle pull out, gentle handheld',
    'drift, or slow parallax), one restrained subject action, and one or two',
    'subtle background movements (smoke drifting, dust floating, rain, papers',
    'moving, light flickering). Never describe fast motion, cuts, speech, or a',
    'change of scene.',
].join(' ');

const NO_STYLE_RULE = [
    'visual_description states subject, action, setting and framing only.',
    'It must not mention art style, rendering, outlines, shading, colour palette,',
    'realism, illustration, cartoon, lighting style, or aspect ratio — those are',
    'applied by the server and repeating them corrupts the prompt.',
].join(' ');

async function json<T>(prompt: string, maxTokens: number, temperature: number): Promise<T> {
    const raw = await chatText([{ type: 'text', text: prompt }], {
        maxTokens,
        temperature,
        timeoutMs: 180_000,
    });
    const parsed = parseJson<T>(raw);
    if (!parsed) {
        log.warn('assist reply was not JSON', { preview: raw.slice(0, 160) });
        throw new Error('The model did not return usable JSON. Try again.');
    }
    return parsed;
}

// -------------------------------------------------------------------- pitch

export interface Pitch {
    title: string;
    hook: string;
    logline: string;
    why_it_travels: string;
}

/**
 * Five competing pitches. Deliberately warm (temperature 0.9) — this is the one
 * step where repeatability is the wrong goal.
 */
export async function pitchIdeas(topic: string | undefined, count = 5): Promise<Pitch[]> {
    const subject = topic?.trim()
        ? `The topic is: ${topic.trim()}`
        : 'Choose the topic yourself. Favour true, verifiable, little-known events and objects.';

    const result = await json<{ pitches?: Pitch[] } | Pitch[]>(
        [
            `Pitch ${count} ideas for a 40-second vertical short.`,
            subject,
            '',
            'Each pitch must be a single concrete story with a surprising, specific',
            'fact at its centre — not a category, a listicle, or a general topic.',
            'The hook is the first sentence the viewer hears and must work with no',
            'setup. Avoid anything already saturated on short-form video.',
            '',
            'Reply with ONLY a JSON array, no prose and no code fences:',
            '[{ "title": "<4-8 words>", "hook": "<one sentence, the opening line>",',
            '   "logline": "<one sentence describing the whole story>",',
            '   "why_it_travels": "<one short sentence on why it holds attention>" }]',
        ].join('\n'),
        1400,
        0.9,
    );

    const pitches = Array.isArray(result) ? result : (result.pitches ?? []);
    if (pitches.length === 0) throw new Error('The model returned no pitches. Try again.');
    return pitches;
}

// -------------------------------------------------------------------- story

export interface DraftStory {
    title: string;
    story_text: string;
    logline: string;
}

/** Write (or rewrite) the ~40-second story text. */
export async function writeStory(input: {
    topic?: string | undefined;
    /** An existing draft to revise rather than replace. */
    draft?: string | undefined;
    /** Free-form direction from the user, e.g. "make the ending colder". */
    notes?: string | undefined;
}): Promise<DraftStory> {
    const target = 'about 110 to 130 words, which reads aloud in roughly 40 seconds';

    return json<DraftStory>(
        [
            input.draft
                ? 'Revise the story below. Keep what works; change only what the notes ask for.'
                : 'Write the story for a 40-second vertical short.',
            STORY_GUIDE,
            `Length: ${target}.`,
            '',
            input.topic ? `Subject: ${input.topic.trim()}` : '',
            input.draft ? `Current draft:\n${input.draft.trim()}` : '',
            input.notes ? `Notes from the user: ${input.notes.trim()}` : '',
            '',
            'Reply with ONLY a JSON object, no prose and no code fences:',
            '{ "title": "<4-8 words>", "logline": "<one sentence>",',
            '  "story_text": "<the story, plain prose, no line breaks needed>" }',
        ]
            .filter(Boolean)
            .join('\n'),
        1200,
        0.7,
    );
}

// -------------------------------------------------------------------- shots

export interface PlannedShot {
    shot_number: number;
    story_beat: string;
    visual_description: string;
    camera_motion: string;
    motion_instruction: string;
    needed_references: string[];
    continuity_notes: string;
}

/**
 * Break an approved story into `count` chunks of DEFAULT_DURATION seconds.
 *
 * The output shape is the `manifest.shots` array the story skill already
 * writes, so a manifest produced here and one produced through chat are
 * interchangeable — `get_story_manifest` cannot tell them apart.
 */
export async function planShots(input: {
    storyText: string;
    count?: number | undefined;
    referenceLabels?: string[] | undefined;
}): Promise<PlannedShot[]> {
    const count = input.count ?? 8;
    const known = input.referenceLabels?.length
        ? `Existing reference plates you may cite by label in needed_references: ${input.referenceLabels.join(', ')}.`
        : 'Invent reference labels as needed; they will be created as plates later.';

    const result = await json<{ shots?: PlannedShot[] } | PlannedShot[]>(
        [
            `Break this story into exactly ${count} shots of ${DEFAULT_DURATION} seconds each,`,
            'in narrative order, covering the whole story with no gaps and no repeats.',
            '',
            NO_STYLE_RULE,
            MOTION_GUIDE,
            '',
            known,
            'continuity_notes records what must stay identical to earlier shots',
            '(same face, same coat, same room) — it is what keeps a character from drifting.',
            '',
            `STORY:\n${input.storyText.trim()}`,
            '',
            'Reply with ONLY a JSON array, no prose and no code fences:',
            '[{ "shot_number": 1, "story_beat": "<what this beat does for the story>",',
            '   "visual_description": "<subject, action, setting, framing>",',
            '   "camera_motion": "<the one camera move>",',
            '   "motion_instruction": "<camera move + subject action + background motion>",',
            '   "needed_references": ["<label>"], "continuity_notes": "<what must not change>" }]',
        ].join('\n'),
        3000,
        0.4,
    );

    const shots = Array.isArray(result) ? result : (result.shots ?? []);
    if (shots.length === 0) throw new Error('The model returned no shots. Try again.');
    // Renumber defensively: a gap or duplicate here would collide with
    // shot_number in the database.
    return shots.map((shot, index) => ({ ...shot, shot_number: index + 1 }));
}

// --------------------------------------------------------------- references

export interface PlannedReference {
    role: string;
    label: string;
    /** A ready-to-use prompt for generating the plate. */
    description: string;
    used_in: number[];
}

/**
 * The minimum set of reference plates the shots need for continuity.
 *
 * Minimum is the point: every extra plate is a generation to pay for and
 * another thing to keep consistent. The skill's guidance is main character,
 * key location, central prop — and nothing else until a shot proves it needs one.
 */
export async function planReferences(shots: PlannedShot[]): Promise<PlannedReference[]> {
    const outline = shots
        .map((s) => `${s.shot_number}. ${s.visual_description} [refs: ${(s.needed_references ?? []).join(', ')}]`)
        .join('\n');

    const result = await json<{ references?: PlannedReference[] } | PlannedReference[]>(
        [
            'List the minimum set of reference plates needed to keep these shots visually',
            'consistent. Only include a plate for a subject that appears in more than one',
            'shot, or that carries the final reveal. Do not pad the list.',
            '',
            NO_STYLE_RULE,
            'role is one of: character, character_turnaround, expression_sheet, prop, location, style, other.',
            '',
            `SHOTS:\n${outline}`,
            '',
            'Reply with ONLY a JSON array, no prose and no code fences:',
            '[{ "role": "character", "label": "<short name>",',
            '   "description": "<subject and framing for the plate>",',
            '   "used_in": [1, 3] }]',
        ].join('\n'),
        1600,
        0.3,
    );

    const refs = Array.isArray(result) ? result : (result.references ?? []);
    return refs;
}

/** Turn any assist failure into a message that is safe to show a user. */
export function assistError(err: unknown): string {
    const message = errorMessage(err);
    log.warn('assist failed', { error: message });
    return message;
}
