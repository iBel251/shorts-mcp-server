# Shorts Pipeline MCP Server

A headless remote MCP server that wraps the xAI Imagine API so Claude (web and
mobile) can generate stylized 2D animated vertical shorts through tool calls.

There is no frontend. The only human interface is a Claude chat window.

---

## Setup

### 1. Supabase

Create a project, then run [supabase/schema.sql](supabase/schema.sql) in the SQL
editor. It creates `projects`, `shots`, `assets`, and `jobs`, and is safe to
re-run.

The storage bucket (`shorts`, public) is created automatically on first boot —
no manual step needed.

You need the **service role** key, not the anon key: the server writes to
Storage and bypasses RLS. It is the only thing holding the database, and it
never leaves the process.

### 2. Environment

```bash
cp .env.example .env
```

Fill in `XAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and generate a
shared secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Run

```bash
npm install
npm run dev      # tsx watch
# or
npm run build && npm start
```

ffmpeg is bundled via `ffmpeg-static` — no system install required. The server
verifies it at boot and refuses to start without it, since frame extraction
would silently fail otherwise.

### 4. Expose it

Claude reaches the server from Anthropic's infrastructure and cannot reach
`localhost`. You need a public HTTPS URL.

```bash
cloudflared tunnel --url http://localhost:3000
```

Free-tier tunnel URLs change on every restart and the connector has to be
re-added each time. If that loop gets tedious, deploy early and iterate against
the deployed instance.

**Production: Render (free).** [render.yaml](render.yaml) and
[Dockerfile](Dockerfile) are ready to go.

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo. It reads `render.yaml`.
3. Render prompts for the four secrets (`XAI_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `SHORTS_SHARED_SECRET`) — they are marked
   `sync: false` so they never enter the repo. Copy them from your local `.env`.
4. Deploy. Your URL is `https://<service-name>.onrender.com`.

Note that Cloudflare Workers is *not* an option: frame extraction shells out to
ffmpeg, which Workers cannot run. The image installs ffmpeg from apt rather than
via `ffmpeg-static`; `src/frames.ts` picks whichever is present and honours
`FFMPEG_PATH`.

**The free instance sleeps after 15 minutes idle** and takes roughly a minute to
wake. The first tool call in a chat after an idle period may therefore be slow
enough that Claude reports a connection error — call it again and it will work.
Two ways to avoid it:

- Ping `GET /healthz` every ~10 minutes from an external uptime monitor. Free
  instances get 750 hours/month and a full month is ~744, so staying awake
  around the clock just fits.
- Upgrade to a paid instance.

Sleeping is survivable rather than harmful because `check_job` polls upstream
eagerly and all job state is in Postgres — a job in flight when the instance
sleeps resumes on the next call. The one behavioural difference from an
always-on host: a job is not finished unattended, so if you call `animate` and
abandon the chat, it completes the next time anything calls `check_job`.

Health probe for the host: `GET /healthz` (unauthenticated).

### 5. Add the connector in Claude

Settings → Connectors → Add custom connector (Pro/Max/Team/Enterprise).

**URL:** your HTTPS URL with the shared secret as the path segment:

```
https://<your-host>/<SHORTS_SHARED_SECRET>
```

**Leave Advanced settings (OAuth Client ID/Secret) blank.** Those fields are for
OAuth client registration; the shared secret does not go there.

Why the secret is in the URL: claude.ai's request-header support is a gated beta
("contact Anthropic for early access"), so on most accounts the connector dialog
offers nothing but OAuth fields — there is no place to type a key. A capability
URL is the remaining option, and over HTTPS the path is inside the TLS session,
making it about as strong as a bearer token.

The tradeoff is that URLs get logged more casually than headers: your host's
access logs will contain the secret. Our own logger redacts it, but treat the
whole URL as a credential, and rotate `SHORTS_SHARED_SECRET` if it leaks.

If you *do* have the header beta, or you're connecting from Claude Code, point
at the bare root URL instead and send the secret as a header. Only allowlisted
names reach the server — `authorization`, `x-api-key`, `x-auth-token` — and all
three are accepted (`authorization` with or without a `Bearer ` prefix). A
bespoke name like `x-shorts-key` will never arrive, which is why `AUTH_HEADER`
defaults to `x-api-key`.

Add it on the web first. iOS and Android can *use* remote MCP servers but cannot
add new ones.

---

## Tools

| Tool | Behaviour |
|---|---|
| `generate_still` | Generates `count` (default 4, max 8) variations. Synchronous. Returns them as **viewable images**. |
| `approve_still` | Marks one still approved, un-approves siblings. |
| `animate` | Submits image-to-video, returns a job id **immediately**. |
| `check_job` | Polls a job. On done: video URL + first/last frames as **viewable images**. |
| `list_shots` | Full project state, all still variations, and every project. Cold-resume path. |

Projects are addressed by `project_name` on `generate_still` (created on first
use) and `list_shots` returns every project, so multiple shorts stay separate
without adding `create_project`/`list_projects` tools — the spec asks for
exactly five.

### Reference images (character continuity)

`generate_still` accepts up to three `reference_asset_ids`. Pass the approved
still that established a character and the new shot keeps their face, costume
and proportions instead of being an independent roll of the dice:

```
generate_still(
  shot_description = "The same man now on a narrow cobbled street at night...",
  reference_asset_ids = ["<asset_id of shot 1's approved still>"]
)
```

References resolve to assets in your own Storage, never an expiring upstream
URL, and any still or extracted video frame can serve as one (a video asset
cannot — use its `first_frame`/`last_frame`). When references are present the
request routes to `/v1/images/edits` instead of `/v1/images/generations`, and a
server-owned `REFERENCE_BLOCK` is appended instructing the model to hold the
design — continuity is not something the caller should have to remember to ask
for, for the same reason style isn't.

Request shapes differ by count and both were confirmed against the live API: one
reference goes in `image` as an object, several go in `images` as an array.
Passing an array to `image` is rejected with 422.

Typical flow:

```
generate_still → approve_still → animate → check_job (poll) → compare frames
```

---

## Design notes

### Style is server-owned

`STYLE_BLOCK` and `NEGATIVE_BLOCK` live in [src/config.ts](src/config.ts) and are
concatenated onto every prompt automatically:

```
`${shot_description} ${motion_instruction} ${STYLE_BLOCK} ${palette_override} ${NEGATIVE_BLOCK}`
```

No tool exposes a `style` parameter, and the smoke test asserts that. The xAI
endpoints are stateless — nothing carries between calls — and in manual testing
omitting the style block produced fully photorealistic output while the model
repeatedly tried to make characters face camera and speak. Making style a
server-owned constant means neither the user nor Claude can forget it.

`palette_override` is the one prompt lever exposed, appended *after* the style
block, because palette shifts per story beat while the base style never does.

### Every asset is re-hosted immediately

Upstream URLs are treated as ephemeral. Every generated asset is downloaded and
written to Supabase Storage before the tool returns, and only our own URLs are
handed back. The previous pipeline (Higgsfield) failed mid-project when upstream
media IDs expired and the style reference plates became unreachable.

### First and last frames are extracted automatically — and embedded

Claude cannot watch video, but it can compare two stills. The characteristic
failure of these models is drift — starting in the correct flat style and
progressively realism-ifying, or animating something meant to stay still.
`animate` results therefore always come with frame 1 and the final frame.

They are returned as MCP **image content blocks**, not just URLs. Returning URLs
alone made the feature inert: Claude cannot open arbitrary links, so the frames
arrived as text it could not look at and the drift check still needed a human to
screenshot them. `generate_still` embeds its variations for the same reason —
the model is asked to pick one, so it has to be able to see them.

Embedded images are downscaled to 640px-wide JPEGs (`PREVIEW_MAX_WIDTH`), about
a tenth the size of the stored PNG at no cost to a style judgement. The
full-resolution PNG stays in Storage and its URL is returned alongside. Pass
`include_images: false` to either tool to suppress the blocks and save tokens.

### Inline UI — MCP Apps (SEP-1865)

Image content blocks go to the *model*; they put nothing on the chat surface for
the *human*. So `generate_still` and `check_job` also declare UI resources, which
the host renders in a sandboxed iframe inline in the conversation:

| Widget | URI | Shows |
|---|---|---|
| Gallery | `ui://shorts/gallery.html` | The variations, full size. Click one to approve it. |
| Player | `ui://shorts/player.html` | The clip playing, plus first/last frame side by side. |

The two mechanisms are complementary and both are kept — the widget is for you,
the image blocks are for the model, and neither replaces the other. This is an
optional, backwards-compatible extension: hosts without support ignore the
`_meta` and the resource and still get identical text and image content.

Only URLs cross the wire; the media loads directly from Storage. Two details
that are easy to get wrong:

- **Sandbox CSP is deny-by-default.** Without declaring the bucket origin in
  `_meta.ui.csp.resourceDomains`, the iframe may load no images or video at all
  and the widgets render empty.
- **Resources must be fully self-contained.** The iframe cannot fetch sibling
  assets, so CSS and JS are inlined into a single document. `widgets/build.mjs`
  bundles `widgets/*.client.ts` with esbuild into `src/widgets.generated.ts`.

That generated file is committed deliberately: the Docker build runs `tsc`
directly rather than `npm run build`, because esbuild's platform binary is not
reliably present under `npm ci --ignore-scripts`. After editing a widget, run
`npm run build:widgets` and commit the result.

#### If images stop reaching the model: `ENABLE_MCP_APPS=false`

Declaring a UI resource on a tool appears to change how some hosts handle that
tool's *result* — it gets routed to the widget, and the image content blocks may
stop reaching the model. That trade is a bad one: the model comparing first and
last frames is the load-bearing quality check, and a widget the human looks at
does not replace it.

`ENABLE_MCP_APPS=false` removes both the resources and the tools' `_meta`, in
one env var, no code change. Set it in the host dashboard and restart.

To tell server faults from host rendering, run
`npx tsx scripts/live-tool-check.ts` — it prints the actual content blocks a
deployed tool call returns and validates that each image decodes to a real
JPEG. If that shows valid images, the server is fine and the problem is
host-side.

### Jobs survive restarts

Job state lives entirely in Postgres. The worker re-reads open jobs from the
`jobs` table every tick and runs one pass immediately at boot, so killing the
process mid-job loses nothing — which matters during development, where the
tunnel drops frequently. `check_job` also polls upstream eagerly, so it makes
progress even between worker ticks.

If post-processing fails after a successful generation (network blip, ffmpeg
error), the job is left open and retried rather than failed — a paid generation
is never discarded over a transient error.

### Model choice

`grok-imagine-video`, not `grok-imagine-video-1.5`. The older model holds the
flat 2D style far better; 1.5 pulls toward photorealism, adds gradients and skin
texture, and costs twice as much. Default resolution is 720p (1080p does not
exist on the old model; upscaling happens in post).

Both are set via `VIDEO_MODEL` / `VIDEO_RESOLUTION` env vars, so swapping models
is a config change rather than a refactor.

### Auth

One static shared secret, accepted two ways and compared in constant time:

- **`/<secret>`** — credential as the URL path segment, for claude.ai connectors.
- **`/`** — credential in a header (`authorization`, `x-api-key`, or
  `x-auth-token`), for Claude Code and anything else that can set one.

Full OAuth with Dynamic Client Registration is overkill for a single-user service
with no per-user data, but an unauthenticated public URL lets anyone burn your
xAI credits.

The spec assumed claude.ai connectors could send an arbitrary static header. They
cannot: header support is a gated beta, and even with it, names are restricted to
an allowlist that excludes bespoke ones. Hence the URL-path route.

Both checks are Express middleware in [src/auth.ts](src/auth.ts), so swapping in
OAuth later touches no tool logic.

### Secrets

The xAI key is injected in [src/xai.ts](src/xai.ts) and nowhere else. Rather than
trusting every call site, the logger runs every line through `redact()` on the
way out, and upstream error bodies are redacted before they can propagate into a
tool response.

---

## Transport

Streamable HTTP only, served at the **root path**, with explicit session
management. Legacy HTTP+SSE is deliberately not implemented — it is being
deprecated.

- `HEAD /` — protocol discovery (gated)
- `POST /` — JSON-RPC; `initialize` opens a session, id returned in `mcp-session-id`
- `GET /` — server→client notification stream
- `DELETE /` — ends a session
- Unknown session id → `404`, telling the client to re-initialize

---

## Tests

```bash
npm run typecheck
npm run smoke
```

The smoke test boots the real Express app in-process with dummy credentials and
verifies auth rejection, HEAD discovery, stale-session handling, the full
Streamable HTTP handshake, the exact tool surface, prompt assembly ordering, and
key redaction — without spending anything upstream.

Not covered offline (these need live credentials): actual image/video
generation, Supabase persistence, and end-to-end frame extraction on real
output. See the acceptance checklist in
[shorts-mcp-server-spec.md](shorts-mcp-server-spec.md).

---

## Out of scope for v1

Web UI, audio/narration, video assembly, upscaling, multi-user/billing, OAuth.

The spec also deferred the `edit` capability; it has since been added as
`reference_asset_ids` on `generate_still` (see above), which covers both
character continuity and the spec's stated motivation of fixing drift without a
full re-roll.
