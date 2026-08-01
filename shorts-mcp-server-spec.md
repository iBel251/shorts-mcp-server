# Build Spec: Shorts Pipeline MCP Server

## What you are building

A **headless remote MCP server** that wraps the xAI Imagine API so Claude (on claude.ai web and mobile) can generate stylized 2D animated vertical shorts through tool calls.

There is **no frontend**. No login page, no dashboard, no React. Nobody opens this in a browser. The only human interface is a Claude chat window. This is a single deployed HTTP process with a handful of route handlers.

Single-user service. Do not build multi-tenancy, user accounts, or role systems.

---

## 1. Stack

- **Language/runtime:** TypeScript on Node.js
- **MCP SDK:** the official `@modelcontextprotocol/sdk` TypeScript SDK
- **Transport:** Streamable HTTP (NOT stdio, NOT legacy SSE — SSE is being deprecated)
- **Storage:** Supabase (Postgres for metadata, Storage bucket for media)
- **Video/frame processing:** ffmpeg
- **Upstream API:** xAI Imagine API at `https://api.x.ai/v1`

---

## 2. Upstream API reference (xAI)

Auth: `Authorization: Bearer $XAI_API_KEY` on all calls. The key lives in the server environment only. It must never appear in a tool argument, a tool response, a log line, or anything returned to the client.

### Image generation
```
POST https://api.x.ai/v1/images/generations
{
  "model": "grok-imagine-image-quality",
  "prompt": "<full prompt>"
}
```
Returns image URL(s). Cost: $0.05 per image.

### Image-to-video (the primary path)
```
POST https://api.x.ai/v1/videos/generations
{
  "model": "grok-imagine-video",
  "prompt": "<motion instruction + style block>",
  "image": { "url": "<https url of the approved still>" },
  "duration": 5
}
```
Returns `{ "request_id": "..." }`. **Asynchronous.**

### Poll
```
GET https://api.x.ai/v1/videos/{request_id}
```
Returns `status` of `done` / `failed` / `expired`. On `done`, the URL is at `video.url`.

### Model choice — do not change this without asking

Use `grok-imagine-video`, **not** `grok-imagine-video-1.5`.

The older model was tested head-to-head and holds the flat 2D style far better; 1.5 pulls toward photorealism, adds gradients and skin texture, and is twice the price. Pricing: old model 480p $0.05/sec, 720p $0.07/sec. 1.5: 480p $0.08, 720p $0.14, 1080p $0.25.

**Default resolution is 720p.** 1080p does not exist on the old model; upscaling happens in post.

Make the model ID and resolution **configurable via environment variable**, defaulting to `grok-imagine-video` and `720p`. Do not hardcode them inline — swapping models later must be a config change, not a refactor.

### Constraints
- Duration 1–15s, 24fps
- Aspect ratio `9:16` is supported natively — always send it, never reframe in post
- Rate limits: 300 RPM / 10 RPS

---

## 3. The style constant — the single most important requirement

The style description is **owned by the server**, not passed in by the caller. It is concatenated onto every image and video prompt automatically.

Store as a config constant, exported and versioned:

```
STYLE_BLOCK = "Flat 2D animated illustration: thick black outlines of even
weight, flat colour fills with no gradients, no texture and no photographic
shading, muted desaturated palette."

NEGATIVE_BLOCK = "Nobody speaks or talks. No faces toward camera. No text,
no captions, no watermark, no extra characters, no fast motion."
```

Every prompt sent upstream is assembled server-side as:

```
`${shot_description} ${motion_instruction ?? ""} ${STYLE_BLOCK} ${NEGATIVE_BLOCK}`
```

**Why this matters:** the xAI endpoints are stateless. Nothing carries over between calls. In manual testing, omitting the style block produced fully photorealistic output — a total style collapse — and the model repeatedly tried to make characters face camera and speak. Making style a server-owned constant means neither the user nor Claude can forget it.

Do not expose a `style` parameter on any tool. Add an optional `palette_override` string param instead (e.g. "deep red palette", "cold desaturated blue") which is appended after `STYLE_BLOCK`, since palette shifts per story beat but the base style never changes.

---

## 4. Data model (Supabase)

```sql
projects
  id            uuid pk
  name          text
  created_at    timestamptz

shots
  id            uuid pk
  project_id    uuid fk -> projects
  shot_number   int
  description   text          -- the shot description as given
  status        text          -- 'still_pending' | 'still_ready' | 'approved'
                              -- | 'animating' | 'done' | 'failed'
  created_at    timestamptz

assets
  id            uuid pk
  shot_id       uuid fk -> shots
  kind          text          -- 'still' | 'video' | 'first_frame' | 'last_frame'
  storage_path  text          -- path in Supabase Storage
  public_url    text
  approved      bool default false
  upstream_job  text          -- xAI request_id, nullable
  created_at    timestamptz
```

### Critical storage rule

**Every asset must be downloaded from the xAI URL and persisted to your own Supabase Storage bucket the moment it is generated, before the tool returns.** Serve your own URLs everywhere; never hand an upstream URL back to the client as the canonical reference.

This is not optional polish. The previous pipeline (Higgsfield) failed mid-project precisely because upstream media IDs expired and the style reference plates became unreachable, forcing a full restart. Assume every upstream URL is ephemeral.

---

## 5. MCP tools

Expose exactly these. Keep the surface small.

### `generate_still`
```
Params:
  shot_description   string   required
  project_id         string   optional (creates/uses a default project if absent)
  shot_number        int      optional
  palette_override   string   optional
  count              int      optional, default 4, max 8
Returns:
  { shot_id, stills: [{ asset_id, url }] }
```
Generates `count` variations in one call. Synchronous — image generation is fast enough. Persist all of them.

### `approve_still`
```
Params:
  asset_id   string   required
Returns:
  { asset_id, shot_id, url }
```
Marks one still approved and sets the shot to `approved`. Un-approves any sibling.

### `animate`
```
Params:
  asset_id            string   required  (must be an approved still)
  motion_instruction  string   required
  duration            int      optional, default 5
Returns:
  { job_id, status: "submitted" }
```
**Returns immediately.** Do not block waiting for the video. Submit upstream, store the `request_id`, return.

### `check_job`
```
Params:
  job_id   string   required
Returns:
  { status, video_url?, first_frame_url?, last_frame_url?, error? }
```

### `list_shots`
```
Params:
  project_id   string   optional
Returns:
  [{ shot_number, description, status, still_url?, video_url?,
     first_frame_url?, last_frame_url? }]
```
This is the resume path. It must be enough to pick a half-finished project back up cold.

---

## 6. Frame extraction — do not skip this

When a video job completes, before marking it done:

1. Download the MP4 to your own storage
2. Use ffmpeg to extract **frame 1** and the **final frame** as PNGs
3. Persist both, and return their URLs from `check_job` and `list_shots` alongside the video URL

**Why:** Claude cannot watch video. It can compare two stills. The characteristic failure mode of these models is *drift* — starting in the correct flat style and progressively realism-ifying, or animating something that was supposed to stay still. In testing, a hand that began as a correct open palm had slowly curled into a closed fist by the last frame, and this was only caught by manual screenshotting.

Auto-extracting both frames turns quality control from a manual loop into something Claude can do unprompted on every shot.

---

## 7. Job handling

- Video generation takes 30s–several minutes. MCP tool calls will time out well before that.
- `animate` submits and returns a job ID. `check_job` polls.
- Run a background worker (or poll lazily inside `check_job`) against the xAI `GET /v1/videos/{request_id}` endpoint.
- On `done`: download, persist, extract frames, update DB, then report done.
- On `failed`/`expired`: store the error text and surface it in `check_job`.
- Jobs must survive a process restart — state lives in Postgres, not in memory. During development the server runs behind a tunnel that drops frequently; a job in flight must not be lost when it does.

---

## 8. Transport, auth, and connection requirements

- **Streamable HTTP transport.** Claude supports both Streamable HTTP and legacy HTTP+SSE, but SSE is being deprecated — build Streamable HTTP only.
- Serve the MCP endpoint at the **root path** and support the `HEAD` method for protocol discovery.
- Implement explicit session management per the current MCP spec.
- Public HTTPS URL required. Claude reaches the server from Anthropic's infrastructure; it cannot reach `localhost`.

### Auth

Authless remote servers are supported, and full OAuth with Dynamic Client Registration is overkill for a single-user service with no per-user data.

**But do not ship it fully open** — an unauthenticated public URL lets anyone burn the owner's xAI credits. Use a **static shared-secret header**: the server requires a header (e.g. `X-Shorts-Key`) matching an environment variable, and rejects anything else with 401. Claude's custom connector configuration supports static request headers.

Structure the auth check as middleware so it can be swapped for OAuth later without touching tool logic.

### Environment variables
```
XAI_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_KEY
SHORTS_SHARED_SECRET
VIDEO_MODEL          default "grok-imagine-video"
VIDEO_RESOLUTION     default "720p"
```

---

## 9. Deployment

**Development:** run locally in VS Code, put a tunnel (`cloudflared tunnel` or ngrok) in front to get a temporary public HTTPS URL. Note the URL changes on restart with free tiers and the connector must be re-added each time — if that loop gets tedious, deploy early and iterate against the deployed instance.

**Production:** any always-on host with a stable HTTPS URL. Cloudflare offers remote MCP hosting with autoscaling and OAuth management if that's preferred. The server must be up whenever Claude might call it — a laptop-only deployment defeats the point of mobile access.

**Connection note for the owner:** custom connectors are added through claude.ai settings on Pro/Max/Team/Enterprise plans. iOS and Android can *use* remote MCP servers, but new servers cannot be added from mobile — add it on the web first, then it's available on the phone.

---

## 10. Acceptance tests

The build is done when, from a Claude chat:

1. `generate_still` with a shot description returns 4 stills, all in flat 2D style with correct outlines and no photorealism, and all 4 are in Supabase Storage
2. `approve_still` marks one, and `list_shots` reflects it
3. `animate` returns a job ID in under 2 seconds
4. `check_job` eventually returns a 9:16 720p MP4 plus first-frame and last-frame PNGs
5. Killing and restarting the server mid-job does not lose the job
6. A request without the shared-secret header gets a 401
7. `list_shots` on a project from a previous session returns enough to resume cold
8. The xAI key appears nowhere in any tool response or log

---

## 11. Explicitly out of scope for v1

- Any web UI or gallery (may come later; decide after using it)
- Audio/narration generation (handled separately; the pipeline uses a locked narrator voice)
- Video assembly/concatenation (done manually in an NLE)
- Upscaling (done in post)
- Multi-user, accounts, billing, quotas
- OAuth / Dynamic Client Registration
- The `edit` capability the old model exposes — note it exists and may be worth adding later for fixing drift without a full re-roll, but do not build it now
