-- Shorts Pipeline MCP Server — schema
-- Run this in the Supabase SQL editor (or `supabase db execute -f supabase/schema.sql`).
-- Safe to re-run.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- projects

create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------- shots

create table if not exists shots (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid        not null references projects(id) on delete cascade,
  shot_number  int         not null,
  description  text        not null,
  status       text        not null default 'still_pending'
               check (status in ('still_pending','still_ready','approved',
                                 'animating','done','failed')),
  created_at   timestamptz not null default now()
);

create index if not exists shots_project_idx on shots (project_id, shot_number);

-- ------------------------------------------------------------------ assets

create table if not exists assets (
  id            uuid primary key default gen_random_uuid(),
  shot_id       uuid        not null references shots(id) on delete cascade,
  kind          text        not null
                check (kind in ('still','video','first_frame','last_frame')),
  storage_path  text        not null,
  public_url    text        not null,
  approved      bool        not null default false,
  upstream_job  text,
  created_at    timestamptz not null default now()
);

create index if not exists assets_shot_idx on assets (shot_id, kind);

-- -------------------------------------------------------------------- jobs
-- Durable video-job state. The spec requires jobs to survive a process
-- restart, so nothing about an in-flight job lives in memory: the worker
-- rebuilds its queue from this table on boot.

create table if not exists jobs (
  id                  uuid primary key default gen_random_uuid(),
  shot_id             uuid        not null references shots(id) on delete cascade,
  source_asset_id     uuid        not null references assets(id) on delete cascade,
  upstream_job        text,               -- xAI request_id
  status              text        not null default 'submitted'
                      check (status in ('submitted','processing','done','failed','expired')),
  error               text,
  motion_instruction  text        not null,
  duration            int         not null default 5,
  video_asset_id      uuid        references assets(id) on delete set null,
  first_frame_asset_id uuid       references assets(id) on delete set null,
  last_frame_asset_id  uuid       references assets(id) on delete set null,
  attempts            int         not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- The worker's boot query: everything still in flight, oldest first.
create index if not exists jobs_open_idx on jobs (status, created_at)
  where status in ('submitted','processing');

create index if not exists jobs_shot_idx on jobs (shot_id);

-- ------------------------------------------------------------ story memory
-- Minimal project memory for planning a short before generating shots.
-- `story_manifests` holds the current structured plan. `reference_assets`
-- tags normal still assets as reusable character/location/prop/style refs.

create table if not exists story_manifests (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid        not null references projects(id) on delete cascade,
  title       text,
  story_text  text,
  manifest    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id)
);

create index if not exists story_manifests_project_idx
  on story_manifests (project_id);

create table if not exists reference_assets (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid        not null references projects(id) on delete cascade,
  asset_id    uuid        not null references assets(id) on delete cascade,
  role        text        not null,
  label       text        not null,
  notes       text,
  metadata    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists reference_assets_project_idx
  on reference_assets (project_id, role, label);

create unique index if not exists reference_assets_asset_idx
  on reference_assets (asset_id);

-- --------------------------------------------------------------------- rls
-- Supabase issues a public anon key for every project and the REST API is
-- internet-facing, so with RLS off these tables would be readable and
-- writable by anyone holding that key — and the anon key is designed to be
-- shared publicly.
--
-- The MCP server connects with the service_role key, which bypasses RLS.
-- Enabling RLS with no policies at all therefore locks out anon and
-- authenticated completely while leaving the server with full access. No
-- policies are needed or wanted: nothing but the server should ever touch
-- these tables.

alter table projects enable row level security;
alter table shots    enable row level security;
alter table assets   enable row level security;
alter table jobs     enable row level security;
alter table story_manifests  enable row level security;
alter table reference_assets enable row level security;
