/**
 * A ~60-line hyperscript layer, in place of a framework.
 *
 * The studio is one page over one JSON snapshot, and the server it ships inside
 * has no build step for the runtime (see the Dockerfile — esbuild is not
 * available there, so this bundle is committed). Pulling in a framework to
 * re-render a list of shots would cost more than it returns.
 *
 * Everything goes through `el`, which sets properties and listeners directly
 * and never touches innerHTML. Shot descriptions, job errors and story text are
 * all user- or model-authored and land in the DOM as text nodes, so there is no
 * path from a generated string to executed markup.
 */

type Falsy = false | null | undefined;
export type Child = Node | string | number | Falsy | Child[];

export interface Attrs {
    class?: string | Falsy;
    /** Applied via style.setProperty, so custom properties work. */
    style?: Record<string, string | Falsy>;
    /** Anything starting with `on` is bound as a listener. */
    [key: string]: unknown;
}

function append(parent: Node, child: Child): void {
    if (child === false || child === null || child === undefined) return;
    if (Array.isArray(child)) {
        for (const item of child) append(parent, item);
        return;
    }
    parent.appendChild(
        child instanceof Node ? child : document.createTextNode(String(child)),
    );
}

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Attrs | null,
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
        if (value === false || value === null || value === undefined) continue;
        if (key === 'class') {
            node.className = String(value);
        } else if (key === 'style' && typeof value === 'object') {
            for (const [prop, val] of Object.entries(value as Record<string, string | Falsy>)) {
                if (val) node.style.setProperty(prop, val);
            }
        } else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key === 'dataset' && typeof value === 'object') {
            Object.assign(node.dataset, value);
        } else if (key === 'value' || key === 'checked') {
            // Must be properties, not attributes. `<textarea value="x">` is
            // simply ignored by the parser — the attribute does not exist —
            // so setting it that way renders an empty box with the text
            // silently dropped.
            (node as unknown as Record<string, unknown>)[key] = value;
        } else if (typeof value === 'boolean') {
            if (value) node.setAttribute(key, '');
        } else {
            node.setAttribute(key, String(value));
        }
    }
    for (const child of children) append(node, child);
    return node;
}

export function frag(...children: Child[]): DocumentFragment {
    const f = document.createDocumentFragment();
    for (const child of children) append(f, child);
    return f;
}

/** Replace a container's contents in one shot. */
export function mount(container: Element, ...children: Child[]): void {
    container.replaceChildren();
    for (const child of children) append(container, child);
}

// ------------------------------------------------------------- formatting

/** Compact elapsed time, matching the design's `1m 14s` job clock. */
export function elapsed(sinceIso: string, now = Date.now()): string {
    const seconds = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** ISO timestamp to the design's `2026-07-29`. */
export function day(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toISOString().slice(0, 10);
}

/** Short form of a uuid, for the id columns. */
export function shortId(id: string): string {
    return id.replace(/-/g, '').slice(0, 8);
}

export function shotLabel(n: number): string {
    return `SHOT ${String(n).padStart(2, '0')}`;
}
