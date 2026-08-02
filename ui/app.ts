import { storeKey, storedKey } from './client.js';
import { el, mount, type Child } from './dom.js';
import { CSS } from './theme.js';
import { addShotModal, importModal, roughCut, shotDrawer } from './overlays.js';
import {
    loadConfig,
    onRender,
    refresh,
    render,
    startPolling,
    state,
} from './store.js';
import {
    header,
    jobsView,
    projectsView,
    referencesView,
    shotsView,
    sidebar,
    storyView,
    tabs,
} from './views.js';
import { wizard } from './wizard.js';

/**
 * Entry point: mount, authenticate, render.
 *
 * There is no router. The studio has one URL and its whole navigation state —
 * which project, which tab, which drawer — lives in `state`, because the thing
 * a link to a shot would need to survive is a shared secret, and putting that
 * in a URL is exactly what the gate below exists to avoid.
 */

const root = document.getElementById('root');

function view(): Child {
    if (!state.authed) return gate();

    const snapshot = state.snapshot;
    const inProject = Boolean(state.projectId);

    let body: Child;
    if (!inProject) {
        body = state.ready ? projectsView() : loading('Loading projects…');
    } else if (!snapshot) {
        body = loading('Loading project…');
    } else if (state.tab === 'shots') {
        body = shotsView(snapshot);
    } else if (state.tab === 'story') {
        body = storyView(snapshot);
    } else if (state.tab === 'refs') {
        body = referencesView(snapshot);
    } else {
        body = jobsView(snapshot);
    }

    return [
        el(
            'div',
            { class: 'app' },
            sidebar(),
            el(
                'main',
                { class: 'main' },
                header(),
                inProject && snapshot ? tabs() : null,
                el('div', { class: 'content' }, body),
            ),
        ),
        snapshot ? shotDrawer(snapshot) : null,
        snapshot ? roughCut(snapshot) : null,
        snapshot ? addShotModal(snapshot) : null,
        snapshot ? importModal(snapshot) : null,
        wizard(),
        toasts(),
    ];
}

function loading(text: string): Child {
    return el('div', { class: 'empty' }, text);
}

function toasts(): Child {
    if (state.toasts.length === 0) return null;
    return el(
        'div',
        { class: 'toasts' },
        state.toasts.map((t) => el('div', { class: `toast ${t.kind}` }, t.text)),
    );
}

/**
 * The key gate.
 *
 * The page itself is served without auth — it holds no data — so this is where
 * the shared secret is collected. It goes to localStorage and then into an
 * x-api-key header on every request, which is the same credential path Claude
 * Code uses against this server.
 */
function gate(): Child {
    const input = el('input', {
        class: 'field',
        type: 'password',
        placeholder: 'SHORTS_SHARED_SECRET',
        autocomplete: 'current-password',
        autofocus: true,
    });

    const submit = (event: Event) => {
        event.preventDefault();
        const key = input.value.trim();
        if (!key) return;
        storeKey(key);
        state.authed = true;
        state.authError = null;
        render();
        void boot();
    };

    return el(
        'div',
        { class: 'gate' },
        el(
            'form',
            { onsubmit: submit },
            el(
                'div',
                { class: 'brand' },
                el('div', { class: 'brand-mark' }),
                el(
                    'div',
                    { style: { display: 'flex', 'flex-direction': 'column' } },
                    el('span', { class: 'brand-name' }, 'SHORTS STUDIO'),
                    el('span', { class: 'brand-sub' }, 'grok-imagine · 9:16'),
                ),
            ),
            el(
                'p',
                { class: 'muted', style: { margin: '0', 'font-size': '13px' } },
                'Enter the server’s shared secret. It is kept in this browser and sent as an x-api-key header — never in the URL.',
            ),
            input,
            state.authError && el('p', { class: 'err' }, state.authError),
            el('button', { class: 'btn primary', type: 'submit' }, 'Open studio'),
        ),
    );
}

// -------------------------------------------------------------------- boot

async function boot(): Promise<void> {
    if (!storedKey()) {
        state.authed = false;
        render();
        return;
    }
    await loadConfig();
    if (!state.authed) {
        render();
        return;
    }
    await refresh();
}

if (root) {
    // The stylesheet rides in the bundle rather than the document, so there is
    // one artefact to ship. The head carries just enough critical CSS that this
    // does not flash.
    document.head.appendChild(el('style', null, CSS));

    onRender(() => {
        // A focused field would lose its caret on a full re-render. Nothing in
        // this app re-renders on keystrokes — inputs write straight to state —
        // but a background poll can land mid-typing, so the focused element is
        // restored by id afterwards.
        const active = document.activeElement as HTMLElement | null;
        const focusId = active?.id || null;
        const caret =
            active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
                ? active.selectionStart
                : null;

        mount(root, view());

        if (focusId) {
            const restored = document.getElementById(focusId);
            if (restored instanceof HTMLInputElement || restored instanceof HTMLTextAreaElement) {
                restored.focus();
                if (caret !== null) restored.setSelectionRange(caret, caret);
            }
        }
    });

    render();
    void boot();
    startPolling();

    // Escape closes whatever is on top, innermost first.
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (state.wizard.open && !state.wizard.running) {
            state.wizard.open = false;
        } else if (state.importOpen) {
            state.importOpen = false;
        } else if (state.newShotOpen) {
            state.newShotOpen = false;
        } else if (state.roughCut) {
            state.roughCut = false;
        } else if (state.openShotId) {
            state.openShotId = null;
        } else {
            return;
        }
        render();
    });
}
