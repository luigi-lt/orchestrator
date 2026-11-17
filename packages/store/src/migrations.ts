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
  {
    // Iteration 2, increment 1: product catalog, analysis and track, one conversation per run, repositories on demand.
    version: 2,
    sql: `
create table catalog_versions (
  hash text primary key,
  content jsonb not null,
  created_at timestamptz not null default now()
);

alter table runs
  add column labels jsonb not null default '[]',
  add column track text,
  add column track_reasons jsonb not null default '[]',
  add column home_product text,
  add column products jsonb not null default '[]',
  add column analysis jsonb,
  add column catalog_hash text;

alter table conversations add column kind text not null default 'general';
update conversations set kind = 'run' where focused_run_id is not null and id in (select conversation_id from runs);

alter table messages add column author text;
update messages set author = 'front-door' where role = 'agent';

create table repository_requests (
  id text primary key,
  step_id text not null references steps(id) on delete cascade,
  repository text not null,
  reason text,
  state text not null,
  entry jsonb,
  error text,
  created_at timestamptz not null default now(),
  unique (step_id, repository)
);
create index repository_requests_pending_idx on repository_requests (step_id) where state = 'pending';
`,
  },
  {
    // Iteration 2, increment 2: sub-tasks with their own branch, pull request, review and conversation.
    version: 3,
    sql: `
create table subtasks (
  run_id text not null references runs(id) on delete cascade,
  key text not null,
  idx int not null,
  title text not null,
  description text not null default '',
  acceptance_criteria jsonb not null default '[]',
  state text not null,
  product text,
  repository text,
  branch text,
  base_commit text,
  head_commit text,
  pr_number int,
  pr_url text,
  conversation_id text,
  review jsonb,
  verification jsonb,
  fix_rounds int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, key)
);

alter table steps add column subtask_key text, add column round int not null default 0;

-- A decision is signalled to the workflow that asked for it (the run or one of its sub-tasks)
-- and shown in the conversation that holds its card.
alter table approvals add column workflow_id text, add column conversation_id text, add column subtask_key text;

alter table conversations add column subtask_key text;

-- Run events are written by the run workflow and by its sub-task workflows: the sequence number is
-- assigned on insert, and a key per writer makes retries no-ops.
alter table run_events add column event_key text;
create unique index run_events_key_idx on run_events (run_id, event_key) where event_key is not null;
`,
  },
  {
    // Iteration 2, increment 3: plan versions, the design session with the architect agent, sub-issues.
    version: 4,
    sql: `
create table plan_versions (
  run_id text not null references runs(id) on delete cascade,
  version int not null,
  hash text not null,
  document jsonb not null,
  status text not null,
  changes jsonb not null default '[]',
  author text not null,
  prompted_by text,
  created_at timestamptz not null default now(),
  primary key (run_id, version)
);

create table design_sessions (
  run_id text primary key references runs(id) on delete cascade,
  state text not null,
  step_id text,
  repositories jsonb not null default '[]',
  has_checkpoint boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table design_turns (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  seq int not null,
  state text not null,
  input jsonb not null,
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index design_turns_run_idx on design_turns (run_id, seq);

alter table subtasks add column ticket_number int, add column ticket_url text;
`,
  },
  {
    // Iteration 2, increment 4: the requester's check of a change, dependencies between sub-tasks, the story view.
    version: 5,
    sql: `
alter table subtasks
  add column depends_on jsonb not null default '[]',
  add column stacked_on text,
  add column evidence jsonb,
  add column changed_files jsonb,
  add column check_rounds int not null default 0,
  add column warnings jsonb not null default '[]';
`,
  },
  {
    // Iteration 2, increment 5: a design session started afresh from the current plan forgets the conversation before it.
    version: 6,
    sql: `
alter table design_sessions add column history_since timestamptz;
`,
  },
  {
    // User view as pages (AD-44): the orchestrator's cards leave the conversations for the pages of runs and
    // sub-tasks. A link to a run is the one card that stays in a conversation (the chat that started the run).
    version: 7,
    sql: `
create table cards (
  card_key text primary key,
  run_id text not null references runs(id) on delete cascade,
  subtask_key text,
  card jsonb not null,
  version bigint not null default nextval('message_version_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cards_page_idx on cards (run_id, subtask_key, created_at);
create index cards_approval_idx on cards ((card->>'approvalId'));

insert into cards (card_key, run_id, subtask_key, card, version, created_at, updated_at)
  select m.card_key, c.focused_run_id, c.subtask_key, m.components->0, m.version, m.created_at, m.updated_at
  from messages m
  join conversations c on c.id = m.conversation_id
  join runs r on r.id = c.focused_run_id
  where m.role = 'orchestrator' and m.card_key is not null and c.kind in ('run', 'subtask')
    and jsonb_array_length(m.components) > 0 and m.components->0->>'type' <> 'run_link';
delete from messages m using cards k where m.card_key = k.card_key;
-- Copies of cards the assistant showed in a run's conversation: the cards are on the page now.
delete from messages m using conversations c
  where c.id = m.conversation_id and c.kind in ('run', 'subtask') and m.role = 'orchestrator' and m.card_key is null;
`,
  },
  {
    // One conversation per run and agent (AD-38, U2): a run's conversation is the architect's; the assistant's
    // messages there, and the requester's messages it answered, move to a chat of their own. A sub-task's
    // conversation is kept for its implementer (FR-N2); what the assistant said there moves the same way.
    version: 8,
    sql: `
alter table conversations add column agent text;
update conversations set agent = 'architect' where kind = 'run';
update conversations set agent = 'assistant' where kind = 'general';

create temporary table assistant_split on commit drop as
select m.id as message_id, m.conversation_id as from_conversation
from messages m
join conversations c on c.id = m.conversation_id
where c.kind in ('run', 'subtask') and m.role in ('user', 'agent') and 'front-door' = case
  when m.role = 'agent' then coalesce(m.author, 'front-door')
  -- A requester's message went to whoever answered it next; one not answered yet goes to the architect while
  -- the design session is open.
  else coalesce(
    (select coalesce(n.author, 'front-door') from messages n
      where n.conversation_id = m.conversation_id and n.role = 'agent' and (n.created_at, n.version) > (m.created_at, m.version)
      order by n.created_at, n.version limit 1),
    case when c.kind = 'run' and exists (select 1 from design_sessions s where s.run_id = c.focused_run_id and s.state <> 'closed')
      then 'architect' else 'front-door' end)
  end;

insert into conversations (id, title, kind, agent, focused_run_id, created_at, updated_at)
select 'conv_' || substr(md5(s.from_conversation || ':assistant'), 1, 20), left('About ' || c.title, 120), 'general', 'assistant', null,
  min(m.created_at), max(m.created_at)
from assistant_split s
join conversations c on c.id = s.from_conversation
join messages m on m.id = s.message_id
group by s.from_conversation, c.title;

update messages m set conversation_id = 'conv_' || substr(md5(s.from_conversation || ':assistant'), 1, 20)
from assistant_split s where m.id = s.message_id;
`,
  },
];
