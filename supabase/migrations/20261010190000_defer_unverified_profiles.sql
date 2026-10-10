drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

delete from public.profiles as profile
using auth.users as auth_user
where profile.id = auth_user.id
  and profile.role = 'student'
  and auth_user.email_confirmed_at is null;

update auth.users
set raw_user_meta_data = raw_user_meta_data - 'name' - 'username' - 'grade'
where email_confirmed_at is null
  and raw_user_meta_data ?| array['name', 'username', 'grade'];
