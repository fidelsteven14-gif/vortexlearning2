alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('student', 'teacher', 'class_coordinator', 'school_admin', 'super_admin', 'admin'));

update public.profiles set role = 'super_admin' where role = 'admin';

alter table public.profiles
  alter column username drop not null,
  add column school_id uuid,
  add column assessment_number text,
  add column stream text;

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 160),
  examination_code text not null unique check (char_length(trim(examination_code)) between 2 and 40),
  location text not null check (char_length(trim(location)) between 2 and 200),
  logo_storage_key text,
  email text,
  po_box text,
  principal_name text,
  principal_email text,
  principal_signature_storage_key text,
  created_by uuid not null references public.profiles (id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index schools_name_lower_unique on public.schools (lower(trim(name)));

alter table public.profiles
  add constraint profiles_school_id_fkey foreign key (school_id) references public.schools (id);

create table public.school_classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  grade text not null check (grade ~ '^Grade (?:[1-9]|1[0-2])$'),
  stream text not null check (char_length(trim(stream)) between 1 and 20),
  class_teacher_id uuid references public.profiles (id),
  coordinator_id uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (school_id, grade, stream)
);

create table public.school_subjects (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 100),
  max_marks numeric(7,2) not null default 100 check (max_marks > 0),
  created_at timestamptz not null default now()
);

create unique index school_subjects_name_unique on public.school_subjects (school_id, lower(trim(name)));

create table public.student_rosters (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  class_id uuid not null references public.school_classes (id) on delete restrict,
  assessment_number text not null check (char_length(trim(assessment_number)) between 2 and 40),
  full_name text not null check (char_length(trim(full_name)) between 2 and 160),
  guardian_phone_hash text not null,
  profile_id uuid unique references public.profiles (id) on delete set null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create unique index student_rosters_assessment_unique on public.student_rosters (school_id, lower(trim(assessment_number)));

create index student_rosters_class_idx on public.student_rosters (class_id, full_name);

create table public.student_roster_subjects (
  roster_id uuid not null references public.student_rosters (id) on delete cascade,
  subject_id uuid not null references public.school_subjects (id) on delete restrict,
  primary key (roster_id, subject_id)
);

create table public.teacher_records (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles (id) on delete set null,
  school_id uuid not null references public.schools (id) on delete cascade,
  account_role text not null default 'teacher' check (account_role in ('teacher', 'class_coordinator')),
  full_name text not null check (char_length(trim(full_name)) between 2 and 160),
  phone_number text not null check (char_length(trim(phone_number)) between 7 and 24),
  phone_normalized text not null,
  department_head text,
  subject_head text,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (school_id, phone_normalized)
);

create table public.teacher_activation_codes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teacher_records (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.teacher_class_subjects (
  teacher_id uuid not null references public.teacher_records (id) on delete cascade,
  class_id uuid not null references public.school_classes (id) on delete cascade,
  subject_id uuid not null references public.school_subjects (id) on delete cascade,
  primary key (teacher_id, class_id, subject_id)
);

create table public.school_grading_bands (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  subject_id uuid references public.school_subjects (id) on delete cascade,
  label text not null,
  minimum_percent numeric(5,2) not null check (minimum_percent between 0 and 100),
  maximum_percent numeric(5,2) not null check (maximum_percent between 0 and 100),
  unique (school_id, subject_id, label),
  check (minimum_percent <= maximum_percent)
);

create table public.result_windows (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  grade text not null check (grade ~ '^Grade (?:[1-9]|1[0-2])$'),
  term smallint not null check (term between 1 and 3),
  half text not null check (half in ('mid-term', 'end-term')),
  opens_at timestamptz not null,
  deadline timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'open', 'closed', 'coordinator_review', 'admin_review', 'released')),
  opened_by uuid not null references public.profiles (id),
  principal_remarks text,
  class_teacher_remarks text,
  subject_teacher_remarks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (deadline > opens_at),
  unique (school_id, grade, term, half)
);

create table public.student_results (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.result_windows (id) on delete cascade,
  roster_id uuid not null references public.student_rosters (id) on delete cascade,
  subject_id uuid not null references public.school_subjects (id) on delete restrict,
  mark numeric(7,2),
  result_code text not null default 'pending' check (result_code in ('pending', 'mark', 'X', 'Y')),
  reason text,
  entered_by uuid references public.profiles (id),
  entered_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (window_id, roster_id, subject_id),
  check ((result_code = 'mark' and mark is not null and mark >= 0) or (result_code <> 'mark' and mark is null))
);

create table public.school_announcements (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  class_id uuid references public.school_classes (id) on delete cascade,
  author_id uuid not null references public.profiles (id),
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.class_assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  class_id uuid not null references public.school_classes (id) on delete cascade,
  subject_id uuid not null references public.school_subjects (id) on delete cascade,
  teacher_id uuid not null references public.teacher_records (id) on delete cascade,
  title text not null,
  description text not null default '',
  storage_key text not null,
  original_filename text not null,
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.school_timetables (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  grade text not null check (grade ~ '^Grade (?:[1-9]|1[0-2])$'),
  storage_key text not null,
  original_filename text not null,
  created_by uuid not null references public.profiles (id),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > sent_at)
);

create table public.student_report_copies (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.result_windows (id) on delete cascade,
  roster_id uuid not null references public.student_rosters (id) on delete cascade,
  storage_key text not null,
  generated_by uuid not null references public.profiles (id),
  generated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz,
  unique (window_id, roster_id),
  check (expires_at > generated_at)
);

create table public.student_notices (
  id uuid primary key default gen_random_uuid(),
  roster_id uuid not null references public.student_rosters (id) on delete cascade,
  window_id uuid not null references public.result_windows (id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now(),
  unique (roster_id, window_id)
);

alter table public.profiles
  add column class_id uuid references public.school_classes (id),
  add column phone_number text;

create table public.pending_account_claims (
  user_id uuid primary key references auth.users (id) on delete cascade,
  account_type text not null check (account_type in ('student', 'teacher')),
  roster_id uuid references public.student_rosters (id) on delete cascade,
  teacher_id uuid references public.teacher_records (id) on delete cascade,
  expires_at timestamptz not null,
  check (
    (account_type = 'student' and roster_id is not null and teacher_id is null)
    or (account_type = 'teacher' and teacher_id is not null and roster_id is null)
  )
);

create unique index pending_student_roster_claim_unique
  on public.pending_account_claims (roster_id)
  where roster_id is not null;

create unique index pending_teacher_record_claim_unique
  on public.pending_account_claims (teacher_id)
  where teacher_id is not null;

alter table public.schools enable row level security;
alter table public.school_classes enable row level security;
alter table public.school_subjects enable row level security;
alter table public.student_rosters enable row level security;
alter table public.student_roster_subjects enable row level security;
alter table public.teacher_records enable row level security;
alter table public.teacher_activation_codes enable row level security;
alter table public.teacher_class_subjects enable row level security;
alter table public.school_grading_bands enable row level security;
alter table public.result_windows enable row level security;
alter table public.student_results enable row level security;
alter table public.school_announcements enable row level security;
alter table public.class_assignments enable row level security;
alter table public.school_timetables enable row level security;
alter table public.student_report_copies enable row level security;
alter table public.student_notices enable row level security;
alter table public.pending_account_claims enable row level security;

grant all privileges on all tables in schema public to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'school-documents',
  'school-documents',
  false,
  20971520,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
