/**
 * Gallery widget for generate_still.
 *
 * Renders the variations so a human can actually look at them, and approves one
 * on click by calling approve_still back through the host.
 *
 * Images come from the tool result's own base64 blocks as `data:` URIs rather
 * than by fetching the storage URL. Sandbox CSP is deny-by-default and the
 * host does not necessarily honour a resource's declared `resourceDomains`, so
 * anything the iframe fetches itself can be blocked silently — the widget
 * renders perfectly and every picture inside it is a black rectangle. A `data:`
 * URI is not a network request, so there is nothing to block.
 *
 * Falls back to the storage URL, then to a link, so every degradation still
 * leaves something usable.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface Still {
    asset_id: string;
    url: string;
}

interface ImageBlock {
    type: string;
    data?: string;
    mimeType?: string;
}

const app = new App({ name: 'Shorts Gallery', version: '1.0.0' });
const root = document.getElementById('root')!;

let approving = false;
let approvedId: string | undefined;

function escapeHtml(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
}

/** Attach a link fallback so a blocked image never leaves a blank box. */
function guardImage(img: HTMLImageElement, url: string, label: string): void {
    img.addEventListener('error', () => {
        const holder = document.createElement('div');
        holder.className = 'blocked';
        holder.innerHTML = `<span>${escapeHtml(label)} blocked by sandbox</span>`;
        const link = document.createElement('a');
        link.textContent = 'open ↗';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.addEventListener('click', (e) => {
            if (app.getHostCapabilities()?.openLinks) {
                e.preventDefault();
                void app.openLink({ url });
            }
        });
        holder.appendChild(link);
        img.replaceWith(holder);
    });
}

async function approve(assetId: string, stills: Still[], sheet?: string): Promise<void> {
    if (approving) return;
    approving = true;
    render(stills, sheet, 'Approving…');
    try {
        await app.callServerTool({ name: 'approve_still', arguments: { asset_id: assetId } });
        approvedId = assetId;
        render(stills, sheet);
    } catch (err) {
        render(
            stills,
            sheet,
            `Could not approve: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
    } finally {
        approving = false;
    }
}

function render(stills: Still[], sheet?: string, note?: string): void {
    if (stills.length === 0 && !sheet) {
        root.innerHTML = `<p class="empty">No variations returned.</p>`;
        return;
    }

    // Preferred layout: the contact sheet the tool already produced, shown
    // whole, with an approve button per variation beneath it.
    const sheetHtml = sheet
        ? `<img class="sheet" src="${sheet}" alt="All variations" />`
        : `<div class="grid">${stills
              .map(
                  (s, i) => `
            <figure class="card${approvedId === s.asset_id ? ' approved' : ''}"
                    data-asset="${escapeHtml(s.asset_id)}" tabindex="0">
                <img src="${escapeHtml(s.url)}" alt="Variation ${i + 1}" loading="lazy" />
                <figcaption><span>Variation ${i + 1}</span></figcaption>
            </figure>`,
              )
              .join('')}</div>`;

    root.innerHTML = `
        <div class="bar">
            <span>${stills.length} variation${stills.length === 1 ? '' : 's'}</span>
            <span class="hint">${approvedId ? 'Approved ✓' : 'Pick one to approve'}</span>
        </div>
        ${sheetHtml}
        ${
            stills.length > 0
                ? `<div class="picks">${stills
                      .map(
                          (s, i) =>
                              `<button class="pick${
                                  approvedId === s.asset_id ? ' approved' : ''
                              }" data-asset="${escapeHtml(s.asset_id)}">${
                                  approvedId === s.asset_id ? '✓ ' : ''
                              }Approve ${i + 1}</button>`,
                      )
                      .join('')}</div>`
                : ''
        }
        ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
    `;

    // Only URL-sourced images can be blocked; data: URIs cannot.
    if (!sheet) {
        for (const [i, img] of Array.from(
            root.querySelectorAll<HTMLImageElement>('.card img'),
        ).entries()) {
            guardImage(img, stills[i]?.url ?? '', `Variation ${i + 1}`);
        }
    }

    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.pick, .card'))) {
        const assetId = el.dataset.asset;
        if (!assetId) continue;
        el.addEventListener('click', () => void approve(assetId, stills, sheet));
        el.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') void approve(assetId, stills, sheet);
        });
    }
}

app.ontoolresult = (result) => {
    const data = (result.structuredContent ?? {}) as { stills?: Still[] };
    let stills = data.stills ?? [];

    if (stills.length === 0) {
        const text = result.content?.find((c: { type: string }) => c.type === 'text');
        if (text && 'text' in text) {
            try {
                stills = JSON.parse((text as { text: string }).text).stills ?? [];
            } catch {
                /* leave empty */
            }
        }
    }

    // The first image block is the contact sheet of every variation.
    const image = (result.content as ImageBlock[] | undefined)?.find(
        (c) => c.type === 'image' && c.data,
    );
    const sheet = image ? `data:${image.mimeType ?? 'image/jpeg'};base64,${image.data}` : undefined;

    approvedId = undefined;
    render(stills, sheet);
};

render([]);
void app.connect();
