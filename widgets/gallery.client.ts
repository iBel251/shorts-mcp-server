/**
 * Gallery widget for generate_still.
 *
 * Renders the variations at full size so a human can actually look at them,
 * which the plain tool result cannot do: image content blocks go to the model,
 * not to the chat surface, and a bare URL is not a picture. Clicking a
 * variation approves it by calling approve_still back through the host.
 *
 * Only URLs cross the wire — the images load directly from Supabase Storage.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface Still {
    asset_id: string;
    url: string;
}

const app = new App({ name: 'Shorts Gallery', version: '1.0.0' });
const root = document.getElementById('root')!;

function escapeHtml(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
}

let approving = false;

function render(stills: Still[], approvedId?: string, note?: string): void {
    if (stills.length === 0) {
        root.innerHTML = `<p class="empty">No variations returned.</p>`;
        return;
    }

    root.innerHTML = `
        <div class="bar">
            <span>${stills.length} variation${stills.length === 1 ? '' : 's'}</span>
            <span class="hint">${
                approvedId ? 'Approved ✓' : 'Click one to approve it'
            }</span>
        </div>
        <div class="grid">
            ${stills
                .map(
                    (s, i) => `
                <figure class="card${approvedId === s.asset_id ? ' approved' : ''}"
                        data-asset="${escapeHtml(s.asset_id)}" tabindex="0">
                    <img src="${escapeHtml(s.url)}" alt="Variation ${i + 1}" loading="lazy" />
                    <figcaption>
                        <span>Variation ${i + 1}</span>
                        ${approvedId === s.asset_id ? '<span class="tick">approved</span>' : ''}
                    </figcaption>
                </figure>`,
                )
                .join('')}
        </div>
        ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
    `;

    for (const card of Array.from(root.querySelectorAll<HTMLElement>('.card'))) {
        const approve = async () => {
            const assetId = card.dataset.asset;
            if (!assetId || approving) return;
            approving = true;
            render(stills, undefined, 'Approving…');
            try {
                await app.callServerTool({
                    name: 'approve_still',
                    arguments: { asset_id: assetId },
                });
                render(stills, assetId);
            } catch (err) {
                render(
                    stills,
                    undefined,
                    `Could not approve: ${err instanceof Error ? err.message : 'unknown error'}`,
                );
            } finally {
                approving = false;
            }
        };
        card.addEventListener('click', () => void approve());
        card.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') void approve();
        });
    }
}

app.ontoolresult = (result) => {
    const data = (result.structuredContent ?? {}) as { stills?: Still[] };
    let stills = data.stills ?? [];

    // Fall back to the text block if the host does not forward structured content.
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
    render(stills);
};

render([]);
void app.connect();
