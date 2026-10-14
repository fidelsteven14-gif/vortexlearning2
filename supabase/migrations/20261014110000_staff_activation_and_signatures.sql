alter table public.teacher_records
  drop constraint if exists teacher_records_account_role_check;

alter table public.teacher_records
  add constraint teacher_records_account_role_check
  check (account_role in ('teacher', 'class_coordinator', 'school_admin'));

alter table public.teacher_records
  add column class_teacher_signature_storage_key text;

alter table public.schools
  add column if not exists principal_signature_storage_key text;

create table public.class_teacher_remarks (
  window_id uuid not null references public.result_windows (id) on delete cascade,
  class_id uuid not null references public.school_classes (id) on delete cascade,
  teacher_id uuid not null references public.profiles (id),
  remark text not null default '',
  updated_at timestamptz not null default now(),
  primary key (window_id, class_id)
);

create table public.subject_teacher_remarks (
  window_id uuid not null references public.result_windows (id) on delete cascade,
  class_id uuid not null references public.school_classes (id) on delete cascade,
  subject_id uuid not null references public.school_subjects (id) on delete cascade,
  teacher_id uuid not null references public.profiles (id),
  remark text not null default '',
  updated_at timestamptz not null default now(),
  primary key (window_id, class_id, subject_id)
);

alter table public.class_teacher_remarks enable row level security;
alter table public.subject_teacher_remarks enable row level security;

grant all privileges on public.class_teacher_remarks, public.subject_teacher_remarks to service_role;
