/**
 * Player widget for animate and check_job.
 *
 * Attached to `animate` as well as `check_job`, so a card appears the moment a
 * job is submitted rather than only once someone remembers to poll. While the
 * job runs the widget polls `check_job` itself and updates in place; when it
 * finishes the clip plays inline and the first and last frame sit side by side,
 * since that comparison is the whole quality-control mechanism.
 *
 * Its own polling passes include_images:false and critique:false — the widget
 * needs URLs, and re-running the vision pass on every tick would cost real
 * money for something no one reads.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface JobPayload {
    job_id?: string;
    status?: string;
    video_url?: string;
    first_frame_url?: string;
    last_frame_url?: string;
    error?: string;
    duration?: number;
    resolution?: string;
    model?: string;
}

const app = new App({ name: 'Shorts Player', version: '1.0.0' });
const root = document.getElementById('root')!;

const POLL_MS = 5000;
const MAX_POLL_MS = 15 * 60 * 1000;

let jobId: string | undefined;
let startedAt = Date.now();
let polling = false;
let timer: number | undefined;

function escapeHtml(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
}

function elapsed(): string {
    const s = Math.round((Date.now() - startedAt) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function badges(job: JobPayload): string {
    const items = [job.model, job.resolution, job.duration ? `${job.duration}s` : '', '9:16']
        .filter(Boolean)
        .map((b) => `<span class="badge">${escapeHtml(String(b))}</span>`);
    return items.length ? `<div class="badges">${items.join('')}</div>` : '';
}

function render(job: JobPayload): void {
    const status = job.status ?? 'unknown';

    if (status !== 'done') {
        const failed = status === 'failed' || status === 'expired';
        root.innerHTML = `
            ${badges(job)}
            <div class="status ${failed ? 'bad' : ''}">
                <span class="dot${failed ? '' : ' pulse'}"></span>
                <div>
                    <strong>${escapeHtml(failed ? status : `${status} · ${elapsed()}`)}</strong>
                    <p>${escapeHtml(
                        job.error ??
                            (failed
                                ? 'The job did not complete.'
                                : 'Generating — usually 30s to a few minutes.'),
                    )}</p>
                </div>
            </div>`;
        return;
    }

    root.innerHTML = `
        ${badges(job)}
        ${
            job.video_url
                ? `<video src="${escapeHtml(job.video_url)}" controls playsinline
                          preload="metadata" loop></video>`
                : ''
        }
        ${
            job.first_frame_url && job.last_frame_url
                ? `<div class="frames">
                       <figure>
                           <img src="${escapeHtml(job.first_frame_url)}" alt="First frame" />
                           <figcaption>First frame</figcaption>
                       </figure>
                       <figure>
                           <img src="${escapeHtml(job.last_frame_url)}" alt="Last frame" />
                           <figcaption>Last frame</figcaption>
                       </figure>
                   </div>
                   <p class="note">Compare the two frames for style drift before accepting
                   this shot.</p>`
                : ''
        }
    `;
}

/** Poll check_job until the job settles. */
async function poll(): Promise<void> {
    if (!jobId || polling) return;
    // Without host support for proxying tool calls the card simply stays on
    // its last known status rather than erroring.
    if (!app.getHostCapabilities()?.serverTools) return;
    polling = true;
    try {
        const result: any = await app.callServerTool({
            name: 'check_job',
            arguments: { job_id: jobId, include_images: false, critique: false },
        });
        const text = result.content?.find((c: { type: string }) => c.type === 'text');
        const job: JobPayload = result.structuredContent ?? (text ? JSON.parse(text.text) : {});
        render(job);

        const settled = ['done', 'failed', 'expired'].includes(job.status ?? '');
        if (!settled && Date.now() - startedAt < MAX_POLL_MS) {
            timer = window.setTimeout(() => void poll(), POLL_MS);
        }
    } catch {
        // Transient failures are not worth surfacing mid-poll; try again.
        if (Date.now() - startedAt < MAX_POLL_MS) {
            timer = window.setTimeout(() => void poll(), POLL_MS * 2);
        }
    } finally {
        polling = false;
    }
}

app.ontoolresult = (result) => {
    let job = (result.structuredContent ?? {}) as JobPayload;
    if (!job.status && !job.job_id) {
        const text = result.content?.find((c: { type: string }) => c.type === 'text');
        if (text && 'text' in text) {
            try {
                job = JSON.parse((text as { text: string }).text);
            } catch {
                /* leave as-is */
            }
        }
    }

    jobId = job.job_id;
    startedAt = Date.now();
    if (timer) window.clearTimeout(timer);
    render(job);

    // animate returns "submitted" immediately; keep the card live from there.
    if (jobId && !['done', 'failed', 'expired'].includes(job.status ?? '')) {
        timer = window.setTimeout(() => void poll(), POLL_MS);
    }
};

render({ status: 'loading' });
void app.connect();
