/**
 * Player widget for check_job.
 *
 * Plays the finished clip inline and puts the first and last frame side by
 * side, since that comparison is the whole quality-control mechanism: these
 * models drift from flat 2D toward photorealism, or animate something that was
 * meant to stay still.
 *
 * While the job is still running this shows its status, so the widget is useful
 * before the video exists rather than only after.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface JobPayload {
    status?: string;
    video_url?: string;
    first_frame_url?: string;
    last_frame_url?: string;
    error?: string;
}

const app = new App({ name: 'Shorts Player', version: '1.0.0' });
const root = document.getElementById('root')!;

function escapeHtml(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
}

function render(job: JobPayload): void {
    const status = job.status ?? 'unknown';

    if (status !== 'done') {
        const failed = status === 'failed' || status === 'expired';
        root.innerHTML = `
            <div class="status ${failed ? 'bad' : ''}">
                <span class="dot${failed ? '' : ' pulse'}"></span>
                <div>
                    <strong>${escapeHtml(status)}</strong>
                    <p>${escapeHtml(
                        job.error ??
                            (failed
                                ? 'The job did not complete.'
                                : 'Generating — this usually takes 30s to a few minutes.'),
                    )}</p>
                </div>
            </div>`;
        return;
    }

    root.innerHTML = `
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

app.ontoolresult = (result) => {
    let job = (result.structuredContent ?? {}) as JobPayload;
    if (!job.status) {
        const text = result.content?.find((c: { type: string }) => c.type === 'text');
        if (text && 'text' in text) {
            try {
                job = JSON.parse((text as { text: string }).text);
            } catch {
                /* leave as-is */
            }
        }
    }
    render(job);
};

render({ status: 'loading' });
void app.connect();
