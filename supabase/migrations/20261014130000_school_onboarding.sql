alter table public.schools
  add column category text
    check (category in ('Primary', 'Junior', 'Senior', 'Combined')),
  add column ownership text
    check (ownership in ('Public', 'Private')),
  add column county text not null default '',
  add column sub_county text not null default '',
  add column telephone text not null default '',
  add column website text,
  add column grades text[] not null default '{}',
  add column verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected')),
  add column operational_status text not null default 'active'
    check (operational_status in ('active', 'suspended', 'archived')),
  add column updated_at timestamptz not null default now(),
  add column status_updated_by uuid references public.profiles (id),
  add column status_updated_at timestamptz not null default now();

update public.schools
set operational_status = case when active then 'active' else 'suspended' end,
    updated_at = created_at,
    status_updated_at = created_at;

alter table public.schools
  add constraint schools_grades_valid
  check (grades <@ array[
    'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
    'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'
  ]::text[]);

create unique index schools_examination_code_lower_unique
  on public.schools (lower(trim(examination_code)));

alter table public.teacher_records
  add column administrator_email text,
  add column designation text,
  add column invitation_status text not null default 'not_applicable'
    check (invitation_status in ('not_applicable', 'pending', 'sent', 'failed', 'accepted'));

create unique index teacher_records_school_admin_unique
  on public.teacher_records (school_id)
  where account_role = 'school_admin' and administrator_email is not null;

create unique index teacher_records_administrator_email_unique
  on public.teacher_records (lower(administrator_email))
  where administrator_email is not null;

create function public.create_school_onboarding_records(
  p_name text,
  p_examination_code text,
  p_category text,
  p_ownership text,
  p_county text,
  p_sub_county text,
  p_location text,
  p_telephone text,
  p_email text,
  p_po_box text,
  p_website text,
  p_grades text[],
  p_created_by uuid,
  p_administrator_name text,
  p_administrator_email text,
  p_administrator_phone text,
  p_administrator_designation text
)
returns table (school_id uuid, administrator_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_school_id uuid := gen_random_uuid();
  new_administrator_id uuid;
begin
  insert into public.schools (
    id, name, examination_code, category, ownership, county, sub_county,
    location, telephone, email, po_box, website, grades, created_by
  ) values (
    new_school_id, trim(p_name), upper(trim(p_examination_code)), p_category,
    p_ownership, p_county, trim(p_sub_county), trim(p_location), p_telephone,
    nullif(trim(p_email), ''), nullif(trim(p_po_box), ''), nullif(trim(p_website), ''),
    p_grades, p_created_by
  );

  insert into public.teacher_records (
    school_id, account_role, full_name, phone_number, phone_normalized,
    administrator_email, designation, invitation_status, created_by
  ) values (
    new_school_id, 'school_admin', trim(p_administrator_name), p_administrator_phone,
    p_administrator_phone, lower(trim(p_administrator_email)),
    trim(p_administrator_designation), 'pending', p_created_by
  )
  returning id into new_administrator_id;

  return query select new_school_id, new_administrator_id;
end;
$$;

revoke all on function public.create_school_onboarding_records(
  text, text, text, text, text, text, text, text, text, text, text, text[], uuid,
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_school_onboarding_records(
  text, text, text, text, text, text, text, text, text, text, text, text[], uuid,
  text, text, text, text
) to service_role;
