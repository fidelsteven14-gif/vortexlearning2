alter table public.schools
  add column email_verification_required boolean not null default false,
  add column email_verified_at timestamptz,
  add column email_verification_status text not null default 'not_required'
    check (email_verification_status in ('not_required', 'pending', 'sent', 'failed', 'verified')),
  add column email_verification_user_id uuid;

create unique index schools_email_verification_required_unique
  on public.schools (lower(email))
  where email_verification_required and email is not null;

create function public.create_school_registration(
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
    email_verification_required, email_verification_status
  ) values (
    new_school_id, trim(p_name), upper(trim(p_examination_code)), p_category,
    p_ownership, p_county, trim(p_sub_county), trim(p_location), p_telephone,
    lower(trim(p_email)), nullif(trim(p_po_box), ''), nullif(trim(p_website), ''),
    p_grades, p_created_by, true, 'pending'
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
