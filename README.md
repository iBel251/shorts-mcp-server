# Shorts Pipeline MCP Server

A remote MCP server that wraps the xAI Imagine API so Claude (web and mobile)
can generate dark editorial-cartoon animated vertical shorts through tool calls.

It ships with a second control surface: **Shorts Studio**, a web UI at `/studio`
that drives the same pipeline directly — see [Web studio](#web-studio).

---

## Setup

### 1. Supabase

Create a project, then run [supabase/schema.sql](supabase/schema.sql) in the SQL
editor. It creates `projects`, `shots`, `assets`, `jobs`, `story_manifests` and
`reference_assets`, and is safe to re-run.

> **Upgrading an existing database:** re-run the same file. It now adds a
> `critique` column to `assets` (`add column if not exists`), which is where the
> vision pass's verdict is stored so the studio can show why a variation was
> rejected. Everything keeps working without it — the critique panel just stays
> empty.

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

## Web studio

Open **`https://<host>/studio`** in a browser. It asks once for
`SHORTS_SHARED_SECRET`, keeps it in `localStorage`, and sends it as `x-api-key`
on every request — the same credential path Claude Code uses.

It is the same pipeline, not a viewer. Everything it does goes through
[`src/pipeline.ts`](src/pipeline.ts), which is also what the MCP tools call, so
a short started in Claude can be finished in the browser and vice versa.

| Screen | What it does |
|---|---|
| Projects | Every project as a card: filmstrip of approved plates, logline, progress. |
| Shots | Each beat with its variations. Click a variation to `approve_still`; Animate, Regenerate, Download, Delete per shot. Tick shots (shift-click for a range) to act on several at once. |
| Story | The saved story text and shot beats. Edit and re-save the manifest. |
| References | The reference index. Upload a plate, import one by URL, or have Grok generate one. |
| Jobs | Live job table with elapsed time, upstream errors, Retry and Cancel. |
| Rough cut | Plays the finished clips back to back, in shot order. Download this clip or all of them. |
| New short | The five-step wizard: pitch → story → beats → references → run. |

The wizard's first four steps call Grok (`/api/assist` → `chat/completions`) to
pitch hooks, draft the ~40-second story, break it into 5-second chunks, and work
out the minimum reference plates. Step 5 turns the plan into real rows: it
creates the project, saves the manifest, generates the plates, then generates
stills shot by shot with a visible log. Video is deliberately **not** submitted —
you approve plates first, then press *Animate approved*.

### Things worth knowing

- **The studio spends money.** Generating stills and submitting video are real
  xAI calls. The shared secret in front of `/api` is protecting a wallet, not
  just data. `/studio` itself is unauthenticated because it is a static document
  with nothing in it.
- **Cancel is local.** xAI exposes no cancel endpoint, so cancelling stops the
  worker polling and frees the shot; the upstream generation still completes and
  is still billed.
- **Rough cut is not a render.** It plays the separate clips in sequence. There
  is no concatenated file on the server, and nothing pretends there is.
  Downloading gives you the individual mp4s, named
  `<project>-shot-01.mp4` and zero-padded so they sort into story order on a
  timeline. Saving several at once makes the browser ask permission once —
  that is the browser working correctly, not an error.
- **Downloads proxy through the server.** The clips already have public Storage
  URLs, but a browser ignores the `download` attribute on a cross-origin link
  and plays the mp4 in a tab instead of saving it. `GET /api/shots/:id/video`
  streams it back from our own origin with a real filename.
- **Reference plates create shots.** Reference assets hang off a shot row, so
  importing one makes a shot. The studio marks these and keeps them out of the
  Shots tab and the shot counts.

### Rebuilding the front end

The studio is bundled to a single self-contained document and committed as
`src/ui.generated.ts`, for the same reason the widgets are: the Dockerfile runs
`tsc` only, and esbuild's platform binary is not reliably present under
`npm ci --ignore-scripts`.

```bash
npm run build:ui        # ui/*.ts -> src/ui.generated.ts
npm run typecheck       # server + browser sources
```

Commit `src/ui.generated.ts` with any change under `ui/`, or the deployed studio
will be stale.

---

## Tools

| Tool | Behaviour |
|---|---|
| `generate_still` | Generates `count` (default 4, max 8) variations. Synchronous. Returns them as **viewable images**. |
| `import_image` | Imports an externally generated PNG/JPEG/WebP from a URL, base64 data URL, or file-like base64 payload as a still asset. Can add a replacement still version to an existing `shot_id`. |
| `import_reference_image` | Imports an external image and tags it as a reusable character, prop, location, style, or expression reference. |
| `save_story_manifest` | Saves the structured story plan for a project. |
| `get_story_manifest` | Returns the saved story plan plus reusable reference image URLs and asset ids. |
| `approve_still` | Marks one still approved, un-approves siblings. |
| `animate` | Submits image-to-video, returns a job id **immediately**. |
| `check_job` | Polls a job. On done: video URL + stored `last_frame_url`; optional diagnostics can return frames. |
| `list_shots` | Full project state, all still variations, and every project. Cold-resume path. |

Projects are addressed by `project_name` on `generate_still` (created on first
use) and `import_image`; `list_shots` returns every project, so multiple shorts
stay separate without adding `create_project`/`list_projects` tools.

### External images

`import_image` is the bridge for hosts that generate an image outside this MCP
server, then want Grok to animate it. Pass exactly one of `image_url`,
`image_base64`, or `image_file.data`; the server validates PNG/JPEG/WebP bytes
(20MB max), saves them to Storage, creates a normal `still` asset, and returns
an `asset_id`:

```
import_image(image_url = "https://example.com/generated.png", project_name = "My Short")
approve_still(asset_id = "<returned asset_id>")
animate(asset_id = "<returned asset_id>", motion_instruction = "slow push in")
```

If ChatGPT regenerates a faulty scene image, pass the original `shot_id` to
`import_image`. The imported file is stored as another still under that same
shot; `approve_still` on the returned `asset_id` makes the replacement the
current source for `animate`.

This keeps `animate` unchanged: it still only accepts an approved still
`asset_id`, but that still no longer has to be generated by `generate_still`.

### Story memory and references

For a full short, have the host analyze the story first, save a compact
manifest, then import reusable reference plates:

```
save_story_manifest(project_name = "My Short", manifest = { ... })
import_reference_image(role = "character", label = "Mara main design", image_url = "...")
import_reference_image(role = "location", label = "Market street", image_url = "...")
get_story_manifest(project_name = "My Short")
generate_still(
  shot_description = "Mara crosses the market at dawn...",
  reference_asset_ids = ["<Mara asset_id>", "<Market street asset_id>"]
)
```

The manifest lives in Postgres and reference images are normal stored assets
with labels, roles and URLs, so a new chat can resume the story without relying
on conversation memory.

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
generate_still -> approve_still -> animate -> check_job (poll)
```

Current ChatGPT story flow does not run a first/last-frame approval pass. Submit
all scene videos first, let the player widgets show them, then have the user
name any bad scene videos to regenerate.

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

### Last frames are stored automatically

Finished videos still have extracted frame assets in Storage. The normal
`check_job` result returns the `video_url` and `last_frame_url`; the last frame
is useful later as a continuity reference or a handoff point.

`check_job` no longer embeds a first/last-frame comparison by default. Pass
`include_images: true`, `include_frames: true`, or `critique: true` only when
explicitly troubleshooting a bad clip.

**`generate_still` returns one contact sheet, not one image per variation.**
Four variations tile into a single image (597kB of PNGs → a 69kB JPEG in
~130ms), so a call costs one image slot instead of four. That matters because
hosts may cap how many images a conversation will carry, and four blocks per
call exhausts such a budget quickly — after which later images arrive as empty
slots. Side by side is also the better way to compare variations. Pass
`image_mode: "individual"` for one block each.

### Inline UI — MCP Apps (SEP-1865)

Image content blocks go to the *model*; they put nothing on the chat surface for
the *human*. So `generate_still` and `check_job` also declare UI resources, which
the host renders in a sandboxed iframe inline in the conversation:

| Widget | Tools | Shows |
|---|---|---|
| Gallery | `generate_still` | The variations, full size. Click one to approve it. |
| Player | `animate`, `check_job` | A live job card, then the finished clip. |

The player is attached to **`animate` as well as `check_job`**, so a card appears
the moment a job is submitted rather than only once someone remembers to poll.
While the job runs the widget polls `check_job` from inside the iframe and
updates in place — elapsed time, status, then the video. Its own polls pass
`include_images: false` and `critique: false`, since the widget only needs URLs
and re-running the vision pass every five seconds would cost real money for
something nobody reads. If the host does not support proxying tool calls, the
card just holds its last known status instead of erroring.

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

### The vision pass — judging when the images don't arrive

Image content blocks are unreliable in practice. Hosts appear to cap how many
images a conversation will carry; past that limit they arrive as correctly
positioned but *empty* slots, and the model is silently blind. Reproduced on a
single connection: the same finished job returned the same bytes early in a
conversation and empty slots later, with nothing changing server-side.

Text always gets through. So the server looks at the image itself and returns a
structured judgement as text:

```json
"critiques": [{
  "variation": 3, "asset_id": "e89658f3",
  "verdict": "regenerate",
  "reason": "Character faces are too realistic and handsome instead of exaggerated editorial-cartoon caricatures.",
  "style_ok": false, "palette_ok": true, "framing_ok": true,
  "people": 1, "visible_text": false, "faces_to_camera": false,
  "anatomy_issues": null,
  "fix_suggestion": "Push oversized expressive eyes, exaggerated nose and brows, angular cheeks, simplified skin planes, painterly texture, and the dark green, burnt orange, red and black palette..."
}]
```

`check_job` can return a `drift_report` comparing first and last frame only when
called with `critique: true`; this is a diagnostic path, not the regular video
approval flow.

The rubric is built from `STYLE_BLOCK` and `NEGATIVE_BLOCK`, so it tests the same
rules the prompt asserts. Verdicts are re-derived server-side rather than
trusting the model to apply its own rule: any failing flag forces `regenerate`,
because a self-contradictory "accept" is exactly what this exists to prevent.

**This is a floor, not a replacement for seeing.** It is a description, and a
model relying on it is judging a description — it should say so. Measured
against four real stills it was discriminating (2 accept, 2 regenerate, catching
style and palette violations) but not identical to a direct look. Images are
still returned alongside; this only carries the load when they don't arrive.

Costs ~$0.006 and ~4–5s per image. `ENABLE_VISION_CRITIQUE=false`, or
`critique: false` per call, turns it off. `VISION_MODEL` defaults to `grok-4.5`.

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
stylized editorial-cartoon look far better; 1.5 pulls toward photorealism and
costs twice as much. Default resolution is 720p (1080p does not
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

The studio's `/api` mount reuses the header check unchanged. `/studio` itself is
served without auth: it is a static document containing no project data, and it
can read nothing until someone types the secret into it. The alternative — a
secret in the URL — would put the credential in browser history, screenshots and
whatever the browser syncs.

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

`/healthz`, `/studio` and `/api/*` are mounted **before** the MCP routes, because
`/:token` matches any single path segment and would otherwise swallow them. The
MCP mounts keep a 4 MB JSON limit; `/api` gets its own 32 MB parser, since a
20 MB reference plate is ~27 MB of base64.

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
