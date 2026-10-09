create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  username text not null check (char_length(username) between 3 and 30 and username ~ '^[a-zA-Z0-9._@#-]+$'),
  email text not null,
  email_verified boolean not null default false,
  user_code text unique,
  role text not null default 'student' check (role in ('student', 'admin')),
  grade text check (grade is null or grade ~ '^Grade (?:[1-9]|1[0-2])$'),
  curriculum_registered boolean not null default false,
  pathway text check (pathway is null or pathway in ('stem', 'arts-sports', 'social-sciences')),
  active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index profiles_username_lower_unique on public.profiles (lower(username));
create unique index profiles_email_lower_unique on public.profiles (lower(email));
create index profiles_role_active_idx on public.profiles (role, active, last_seen_at);

create function public.generate_student_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
  random_bytes bytea;
  i integer;
begin
  loop
    random_bytes := extensions.gen_random_bytes(8);
    candidate := 'VX-';
    for i in 0..7 loop
      candidate := candidate || substr(alphabet, 1 + (get_byte(random_bytes, i) % length(alphabet)), 1);
    end loop;
    exit when not exists (select 1 from public.profiles where user_code = candidate);
  end loop;
  return candidate;
end;
$$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, username, email, email_verified, user_code, role, grade)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1), 'Learner'),
    coalesce(
      nullif(lower(trim(new.raw_user_meta_data ->> 'username')), ''),
      'user-' || substr(replace(new.id::text, '-', ''), 1, 10)
    ),
    lower(new.email),
    new.email_confirmed_at is not null,
    public.generate_student_code(),
    'student',
    case when new.raw_user_meta_data ->> 'grade' ~ '^Grade (?:[1-9]|1[0-2])$'
      then new.raw_user_meta_data ->> 'grade'
      else null
    end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.subjects (
  id text primary key,
  name text not null,
  topic text not null,
  icon text not null,
  color text not null,
  grade text not null check (grade ~ '^Grade (?:[1-9]|1[0-2])$'),
  sort_order integer not null default 0
);

create table public.lessons (
  id text primary key,
  subject_id text not null references public.subjects (id) on delete cascade,
  content_type text not null default 'lesson' check (content_type in ('lesson', 'note')),
  title text not null,
  summary text not null,
  content text not null,
  sort_order integer not null default 0
);

create index lessons_subject_order_idx on public.lessons (subject_id, sort_order);

create table public.user_lesson_completions (
  user_id uuid not null references public.profiles (id) on delete cascade,
  lesson_id text not null references public.lessons (id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create table public.user_subject_progress (
  user_id uuid not null references public.profiles (id) on delete cascade,
  subject_id text not null references public.subjects (id) on delete cascade,
  completed_lessons integer not null default 0,
  total_lessons integer not null default 0,
  primary key (user_id, subject_id)
);

create table public.student_subject_registrations (
  user_id uuid not null references public.profiles (id) on delete cascade,
  subject_id text not null references public.subjects (id) on delete cascade,
  primary key (user_id, subject_id)
);

create function public.save_curriculum_registration(p_user_id uuid, p_pathway text, p_subject_ids text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.student_subject_registrations where user_id = p_user_id;
  insert into public.student_subject_registrations (user_id, subject_id)
  select p_user_id, subjects.subject_id from unnest(p_subject_ids) as subjects(subject_id)
  on conflict (user_id, subject_id) do nothing;
  update public.profiles
  set curriculum_registered = true, pathway = p_pathway
  where id = p_user_id and role = 'student';
  if not found then
    raise exception 'Student profile not found';
  end if;
end;
$$;

revoke all on function public.save_curriculum_registration(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.save_curriculum_registration(uuid, text, text[]) to service_role;

create table public.assessments (
  id text primary key,
  title text not null,
  subject_id text not null references public.subjects (id),
  kind text not null default 'PRACTICE' check (kind in ('PRACTICE', 'QUIZ', 'EXAM')),
  duration_minutes integer not null check (duration_minutes between 1 and 240),
  opens_at timestamptz not null,
  published boolean not null default false,
  created_by uuid references public.profiles (id)
);

create index assessments_opens_idx on public.assessments (published, opens_at);

create table public.questions (
  id text primary key,
  assessment_id text not null references public.assessments (id) on delete cascade,
  prompt text not null,
  options_json jsonb not null check (jsonb_typeof(options_json) = 'array'),
  correct_option integer not null,
  points integer not null default 1 check (points > 0),
  sort_order integer not null default 0
);

create function public.save_assessment(
  p_assessment_id text,
  p_title text,
  p_subject_id text,
  p_kind text,
  p_duration_minutes integer,
  p_opens_at timestamptz,
  p_published boolean,
  p_admin_id uuid,
  p_questions jsonb,
  p_update boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  question jsonb;
  question_order integer := 0;
begin
  if p_update then
    if exists (select 1 from public.attempts where assessment_id = p_assessment_id) then
      raise exception 'ASSESSMENT_HAS_ATTEMPTS';
    end if;
    update public.assessments
    set title = p_title, subject_id = p_subject_id, kind = p_kind,
        duration_minutes = p_duration_minutes, opens_at = p_opens_at, published = p_published
    where id = p_assessment_id;
    if not found then
      raise exception 'ASSESSMENT_NOT_FOUND';
    end if;
    delete from public.questions where assessment_id = p_assessment_id;
  else
    insert into public.assessments (id, title, subject_id, kind, duration_minutes, opens_at, published, created_by)
    values (p_assessment_id, p_title, p_subject_id, p_kind, p_duration_minutes, p_opens_at, p_published, p_admin_id);
  end if;

  for question in select value from jsonb_array_elements(p_questions)
  loop
    question_order := question_order + 1;
    insert into public.questions (id, assessment_id, prompt, options_json, correct_option, points, sort_order)
    values (
      gen_random_uuid()::text,
      p_assessment_id,
      question ->> 'prompt',
      question -> 'options',
      (question ->> 'correctOption')::integer,
      (question ->> 'points')::integer,
      question_order
    );
  end loop;
end;
$$;

revoke all on function public.save_assessment(text, text, text, text, integer, timestamptz, boolean, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.save_assessment(text, text, text, text, integer, timestamptz, boolean, uuid, jsonb, boolean) to service_role;

create table public.attempts (
  id text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  assessment_id text not null references public.assessments (id),
  status text not null check (status in ('in_progress', 'submitted', 'marked')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  score integer,
  total_points integer not null,
  unique (user_id, assessment_id)
);

create index attempts_user_status_idx on public.attempts (user_id, status);

create table public.answers (
  attempt_id text not null references public.attempts (id) on delete cascade,
  question_id text not null references public.questions (id) on delete cascade,
  selected_option integer not null,
  updated_at timestamptz not null default now(),
  primary key (attempt_id, question_id)
);

create table public.learning_resources (
  id text primary key,
  subject_id text not null references public.subjects (id) on delete restrict,
  title text not null,
  description text not null default '',
  topic text not null,
  term text not null,
  category text not null check (category in ('revision-paper', 'study-guide', 'syllabus', 'topic-summary', 'reference-document')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  original_filename text,
  storage_key text,
  size_bytes bigint,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index learning_resources_grade_status_idx on public.learning_resources (status, subject_id);

create table public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles (id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_logs_created_idx on public.admin_audit_logs (created_at desc);

create table public.invitations (
  code_hash text primary key,
  grade text not null check (grade ~ '^Grade (?:[1-9]|1[0-2])$'),
  created_by uuid not null references public.profiles (id),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.api_rate_limits (
  rate_key text primary key,
  request_count integer not null,
  window_started_at timestamptz not null
);

create function public.consume_api_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count integer;
begin
  if p_key = '' or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'Invalid rate limit parameters';
  end if;

  insert into public.api_rate_limits (rate_key, request_count, window_started_at)
  values (p_key, 1, now())
  on conflict (rate_key) do update set
    request_count = case
      when public.api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then 1
      else public.api_rate_limits.request_count + 1
    end,
    window_started_at = case
      when public.api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then now()
      else public.api_rate_limits.window_started_at
    end
  returning request_count into current_count;

  if random() < 0.01 then
    delete from public.api_rate_limits where window_started_at < now() - interval '1 day';
  end if;

  return current_count <= p_limit;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, integer, integer) to service_role;

alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.lessons enable row level security;
alter table public.user_lesson_completions enable row level security;
alter table public.user_subject_progress enable row level security;
alter table public.student_subject_registrations enable row level security;
alter table public.assessments enable row level security;
alter table public.questions enable row level security;
alter table public.attempts enable row level security;
alter table public.answers enable row level security;
alter table public.learning_resources enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.invitations enable row level security;
alter table public.api_rate_limits enable row level security;

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('learning-resources', 'learning-resources', false, 20971520, array['application/pdf'])
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
