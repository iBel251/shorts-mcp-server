---
name: grok-shorts-story
description: >-
  Use when creating YouTube Shorts with the connected Grok MCP server: generate
  viral story ideas from a topic or from scratch, write and revise a 40-second
  hook-driven story, break approved stories into 5-second scene chunks, create
  and save character/location reference images, save story manifests, and resume
  projects through Grok MCP tools.
---

# Grok Shorts Story Skill

Use this skill when the user wants to create a YouTube Short using the connected Grok MCP server.

Available Grok MCP tools:

- `generate_still`
- `import_image`
- `import_reference_image`
- `save_story_manifest`
- `get_story_manifest`
- `approve_still`
- `animate`
- `check_job`
- `list_shots`

## Core Rule

Do not rely on conversation memory for story state. For every approved story, save the plan with `save_story_manifest`. For every approved reference image, save it with `import_reference_image`. When resuming a story, call `get_story_manifest` first.

Do not use the old Grok variation workflow for planning references or scene images. Do not ask the user to pick from generated variations. ChatGPT should generate one image, inspect it itself, reject it if it is wrong, and only save the accepted image.

For this skill version, prefer ChatGPT image generation plus `import_reference_image` or `import_image`. Use `generate_still` only if the user explicitly asks Grok to generate stills.

Every generated image for this workflow must be portrait YouTube Shorts format: vertical 9:16, target 1080x1920. If an image is square, landscape, cropped badly, or not clearly 9:16 portrait, regenerate it before saving it to Grok MCP.

## Workflow

### 1. Topic Or Ideas

If the user gives a topic, use it.

If the user does not give a topic, offer exactly 5 short-form story ideas with viral potential. Mix categories when useful: history, mystery, fiction, science, survival, betrayal, mythology, lost artifacts, strange true events, or emotional twists.

For each idea, give:

- Title
- One-sentence hook
- Why it could work as a short

Ask the user to pick one.

### 2. Write The 40-Second Story

Write a roughly 40-second story for the chosen topic. Make it feel built for retention:

- First line must be a scroll-stopping hook.
- Each sentence should create forward pull.
- Include escalation, surprise, climax, and a final reveal or emotional turn.
- Keep it visual enough to become scenes.
- Avoid generic narration, filler, and exposition dumps.
- Prefer concrete actions, objects, and images.

After writing, ask for approval:

`Approve this story, or tell me what to change.`

Do not proceed to scene planning until the story is approved.

### 3. Revision Loop

If the user gives edits, revise the story and ask for approval again. Continue until the user approves.

### 4. Break Into 5-Second Chunks

After approval, act as storyteller, director, and cinematographer. Break the story into about 8 chunks of roughly 5 seconds each.

For each chunk, define:

- `shot_number`
- `story_beat`
- `visual_description`
- `camera_motion`
- `main_subjects`
- `needed_references`
- `motion_instruction`
- `continuity_notes`

The shot descriptions should be ready for ChatGPT image generation and later video animation. Do not include style instructions for Grok-generated prompts; the Grok MCP server owns the style when Grok is used.

### 5. Build The Reference Plan

Before generating scene stills, identify the minimum reference images needed for consistency.

Start simple. Usually create only references needed for the first scene and recurring subjects:

- Main character design
- Important secondary character if visible early
- Key location
- Important prop if central to the story

For each reference, define:

- `role`: one of `character`, `character_turnaround`, `expression_sheet`, `prop`, `location`, `style`, `other`
- `label`
- `description`
- `continuity_notes`
- `used_in_shots`

### 6. Save The Story Manifest

Call `save_story_manifest` with:

- `project_name`
- `title`
- `story_text`
- `manifest`

The manifest should include:

```json
{
  "approved_story": "...",
  "shots": [
    {
      "shot_number": 1,
      "story_beat": "...",
      "visual_description": "...",
      "camera_motion": "...",
      "motion_instruction": "...",
      "needed_references": ["..."],
      "continuity_notes": "..."
    }
  ],
  "references": [
    {
      "role": "character",
      "label": "Main character",
      "description": "...",
      "continuity_notes": "...",
      "used_in_shots": [1, 2, 3]
    }
  ]
}
```

### 7. Generate And Save Reference Images

Use ChatGPT image generation to create each needed reference image.

For every reference image prompt, require:

- vertical 9:16 portrait composition
- YouTube Shorts frame, target 1080x1920
- full subject visible when it is a character or prop reference
- no text, captions, UI, watermark, logo, or border
- enough empty room around important subjects for later motion

Inspect the generated image yourself. If it is not vertical 9:16 portrait or if it fails the reference purpose, regenerate it. Do not ask the user to choose between variations.

Then immediately save each generated reference through Grok MCP using `import_reference_image`.

Use:

- `project_name`
- `role`
- `label`
- `notes`
- `metadata`
- `image_url`, `image_base64`, or `image_file.data`, depending on what ChatGPT can provide

Metadata should include:

```json
{
  "description": "...",
  "used_in_shots": [1],
  "continuity_notes": "..."
}
```

After each saved reference, record the returned `asset_id`.

### 8. Create Scene Reference Images

After the character, location, prop and style references are saved, create one scene reference image for each 5-second chunk. These are the exact still frames that will later be animated into video.

For each scene image:

- Use the approved story chunk.
- Use saved character/location/prop reference asset IDs as continuity guidance.
- Generate one vertical 9:16 YouTube Shorts image, target 1080x1920.
- Inspect it yourself for aspect ratio, composition, continuity, and story clarity.
- If it is not 9:16 portrait or does not match the shot, regenerate it.
- Save only the accepted scene image with `import_image`.
- Record the returned scene `asset_id`, `shot_id`, `url`, and image dimensions in the manifest under that shot.

Do not call `generate_still` for these scene images unless the user explicitly asks for Grok-generated stills. Do not ask for or expect variations.

### 9. Update The Manifest With Asset IDs

After references and scene images are saved, call `save_story_manifest` again with the same project and the updated manifest containing each reference `asset_id` and each scene image `asset_id`.

The user should be able to start a new chat and say:

`Continue the story named <project_name>`

Then call `get_story_manifest(project_name)` and continue from the stored story, shots, and reference asset IDs.

### 10. Scene Image Approval

After all scene reference images are saved and the manifest is updated, show the saved scene image names/shot numbers to the user and ask:

`Approve all scene images, or tell me which named scene image to remake.`

If the user approves all scene images:

- Call `approve_still` once for each current scene image `asset_id`.
- Update the manifest so each approved shot records `approved_scene_asset_id` and `approved_at`.
- Call `save_story_manifest`.
- Continue to scene video generation.

If the user says a scene image is faulty:

- Identify the scene by its name, label, or shot number from the manifest.
- Generate one replacement image in vertical 9:16 YouTube Shorts format, target 1080x1920.
- Inspect it yourself. If it is not 9:16 portrait or does not fix the issue, regenerate it before saving.
- Call `import_image` with the existing scene `shot_id`. This saves the remake as a new still version for the same shot.
- Update the manifest for that shot:
  - Set `scene_image_asset_id` to the replacement `asset_id`.
  - Keep the existing `shot_id`.
  - Add the previous asset to a simple `versions` list with notes.
  - Record `replacement_reason`.
- Call `save_story_manifest`.
- Ask for approval again.

### 11. Generate Scene Videos

When scene images are approved, generate all 5-second scene videos before asking for video fixes.

First, submit every approved shot:

- Use that shot's `approved_scene_asset_id` as the `asset_id`.
- Call `animate` with the matching `motion_instruction` and `duration: 5`.
- Let each `animate` result create its own video/player widget in chat.
- Record the returned `job_id` in the manifest under that shot.

Do not wait for one scene video to finish before submitting the next scene video unless the host/tooling forces sequential calls.

After all video jobs are submitted:

- Poll each `job_id` with `check_job` until every job is `done`, `failed`, or `expired`.
- Do not inspect or compare first and last frames as a normal approval step.
- Do not approve or disapprove each video yourself.
- When a job is done, record `video_url` and `last_frame_url` in the manifest under that shot.
- Keep saving the manifest with `save_story_manifest` as jobs finish so progress survives a new chat.
- When all possible videos are done, show the user the completed scene video names/shot numbers and ask them to name any bad videos to regenerate.

If the user names a bad scene video:

- Find the shot by scene name, label, or shot number from the manifest.
- Usually retry `animate` using the same approved scene image asset and a clearer `motion_instruction`.
- If the underlying image is the problem, remake the scene image using the replacement flow in Step 10, approve the replacement still, then call `animate` again.
- Save regenerated videos as versions in the manifest and mark the latest one as current.

Only request `check_job` diagnostics such as frame images, `include_frames`, or `critique` if the user explicitly asks for troubleshooting.

## Stop Point For This Simple Version

Default stop point:

- If scene images are not yet approved, stop after asking the user to approve or name images to remake.
- If the user approves scene images, continue through 5-second scene video generation.
- If the user only asked for story/reference setup, stop after saving the scene images and asking for approval.

Tell the user what has been saved, what is approved, what videos are done, and the exact project name they can use to resume later.

## Quality Bar

For story:

- Strong hook in the first line
- No slow setup
- Every line raises curiosity or emotion
- Clear visual climax
- Memorable final reveal

For references:

- Keep reference count low
- Make references reusable
- Enforce vertical 9:16, target 1080x1920
- Use clear labels
- Save every reference immediately
- Never invent asset IDs; only use IDs returned by Grok MCP

For scene images:

- Create exactly one accepted scene image per 5-second chunk
- Enforce vertical 9:16, target 1080x1920
- Inspect and self-reject bad images before saving
- Save accepted scene images with `import_image`
- Record scene image `asset_id`s in the manifest

For continuity:

- Use `get_story_manifest` before resuming
- Use stored `asset_id` values in `generate_still.reference_asset_ids`
- If a needed reference is missing, create and save it before scene generation
