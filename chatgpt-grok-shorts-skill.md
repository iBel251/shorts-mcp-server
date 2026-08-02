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

The shot descriptions should be ready for `generate_still`. Do not include style instructions; the Grok MCP server owns the style.

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

### 8. Update The Manifest With Asset IDs

After references are saved, call `save_story_manifest` again with the same project and the updated manifest containing each reference `asset_id`.

The user should be able to start a new chat and say:

`Continue the story named <project_name>`

Then call `get_story_manifest(project_name)` and continue from the stored story, shots, and reference asset IDs.

## Stop Point For This Simple Version

Stop after the first scene references are generated, saved, and the manifest is updated.

Tell the user:

- The story is saved.
- The first reference images are saved.
- The project can be resumed by name.
- The next step is generating shot 1 stills with `generate_still`.

Do not start generating scene stills or videos unless the user explicitly asks to continue.

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
- Use clear labels
- Save every reference immediately
- Never invent asset IDs; only use IDs returned by Grok MCP

For continuity:

- Use `get_story_manifest` before resuming
- Use stored `asset_id` values in `generate_still.reference_asset_ids`
- If a needed reference is missing, create and save it before scene generation
