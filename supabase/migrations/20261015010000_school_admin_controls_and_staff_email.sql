alter table public.teacher_records
  add column teacher_email text;

create unique index teacher_records_teacher_email_unique
  on public.teacher_records (lower(teacher_email))
  where teacher_email is not null;

alter table public.teacher_records
  drop constraint if exists teacher_records_invitation_status_check;

alter table public.teacher_records
  add constraint teacher_records_invitation_status_check
  check (invitation_status in ('not_applicable', 'pending', 'sent', 'verified', 'failed', 'accepted'));

create function public.delete_school_permanently(p_school_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.schools where id = p_school_id) then
    raise exception 'School not found';
  end if;

  update public.profiles
  set active = false, school_id = null, class_id = null
  where school_id = p_school_id;

  delete from public.student_rosters where school_id = p_school_id;
  delete from public.schools where id = p_school_id;
end;
$$;

revoke all on function public.delete_school_permanently(uuid) from public, anon, authenticated;
grant execute on function public.delete_school_permanently(uuid) to service_role;
