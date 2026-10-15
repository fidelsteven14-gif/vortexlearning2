update public.schools
set active = false,
    operational_status = 'suspended',
    updated_at = now(),
    status_updated_at = now()
where email_verification_required
  and email_verified_at is null
  and operational_status = 'active';

create or replace function public.create_school_registration(
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
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_school_id uuid := gen_random_uuid();
begin
  insert into public.schools (
    id, name, examination_code, category, ownership, county, sub_county,
    location, telephone, email, po_box, website, grades, created_by,
    email_verification_required, email_verification_status, active,
    operational_status
  ) values (
    new_school_id, trim(p_name), upper(trim(p_examination_code)), p_category,
    p_ownership, p_county, trim(p_sub_county), trim(p_location), p_telephone,
    lower(trim(p_email)), nullif(trim(p_po_box), ''), nullif(trim(p_website), ''),
    p_grades, p_created_by, true, 'pending', false, 'suspended'
  );

  return new_school_id;
end;
$$;

revoke all on function public.create_school_registration(
  text, text, text, text, text, text, text, text, text, text, text, text[], uuid
) from public, anon, authenticated;
grant execute on function public.create_school_registration(
  text, text, text, text, text, text, text, text, text, text, text, text[], uuid
) to service_role;
