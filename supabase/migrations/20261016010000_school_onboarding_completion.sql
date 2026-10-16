alter table public.schools
  add column onboarding_completed_at timestamptz;

update public.schools s
set onboarding_completed_at = coalesce(s.onboarding_completed_at, s.updated_at, s.created_at)
from public.teacher_records administrator
join public.profiles p on p.id = administrator.profile_id
where administrator.school_id = s.id
  and administrator.account_role = 'school_admin'
  and p.active
  and p.email_verified
  and (not s.email_verification_required or s.email_verified_at is not null)
  and s.onboarding_completed_at is null;

update public.schools
set active = false,
    operational_status = 'suspended',
    updated_at = now(),
    status_updated_at = now()
where email_verification_required
  and onboarding_completed_at is null
  and (active or operational_status = 'active');

create function public.activate_school_staff_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_role text;
  target_school_id uuid;
begin
  select role, school_id
  into target_role, target_school_id
  from public.profiles
  where id = p_user_id and not active
  for update;

  if not found then
    raise exception 'School staff account is missing or already active';
  end if;

  if target_role not in ('school_admin', 'teacher', 'class_coordinator') then
    raise exception 'This account is not a school staff account';
  end if;

  update public.profiles
  set active = true, email_verified = true
  where id = p_user_id;

  update public.teacher_records
  set invitation_status = 'accepted'
  where profile_id = p_user_id
    and school_id = target_school_id
    and account_role = target_role;

  if not found then
    raise exception 'The school staff invitation record could not be found';
  end if;

  if target_role = 'school_admin' then
    update public.schools
    set onboarding_completed_at = coalesce(onboarding_completed_at, now()),
        active = operational_status <> 'archived',
        operational_status = case
          when operational_status = 'archived' then 'archived'
          else 'active'
        end,
        status_updated_at = now(),
        updated_at = now()
    where id = target_school_id
      and (not email_verification_required or email_verified_at is not null);

    if not found then
      raise exception 'The school email must be verified before completing school registration';
    end if;
  end if;
end;
$$;

revoke all on function public.activate_school_staff_account(uuid) from public, anon, authenticated;
grant execute on function public.activate_school_staff_account(uuid) to service_role;
