/** Ordered schema migrations. Append new entries; never edit applied ones. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
create sequence message_version_seq;

create table runs (
  id text primary key,
  workflow_id text not null,
  repo_owner text not null,
  repo_name text not null,
  issue_number int not null,
  title text not null,
  url text not null,
  requester text not null,
  state text not null,
  conversation_id text,
  branch text,
  pr_number int,
  pr_url text,
  plan jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_updated_idx on runs (updated_at desc);
create index runs_workflow_idx on runs (workflow_id, created_at desc);

create table run_events (
  run_id text not null references runs(id) on delete cascade,
  seq int not null,
  type text not null,
  actor text not null,
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create table steps (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  kind text not null,
  title text not null,
  subtask_index int,
  state text not null,
  token_hash text,
  summary text,
  result jsonb,
  error text,
  last_seen_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index steps_run_idx on steps (run_id, created_at);

create table step_progress (
  seq bigserial primary key,
  step_id text not null references steps(id) on delete cascade,
  kind text not null,
  text text not null,
  data jsonb,
  at timestamptz not null default now()
);
create index step_progress_step_idx on step_progress (step_id, seq);

create table approvals (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  kind text not null,
  state text not null,
  payload jsonb not null,
  hash text not null,
  decision jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index approvals_pending_idx on approvals (state) where state = 'pending';

create table conversations (
  id text primary key,
  title text not null,
  focused_run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table messages (
  id text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  role text not null,
  text text,
  components jsonb not null default '[]',
  card_key text unique,
  version bigint not null default nextval('message_version_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index messages_conversation_idx on messages (conversation_id, created_at);
create index messages_version_idx on messages (conversation_id, version);

create table preferences (
  key text primary key,
  value jsonb not null
);

create table poll_state (
  key text primary key,
  etag text,
  updated_at timestamptz not null default now()
);
`,
  },
];
