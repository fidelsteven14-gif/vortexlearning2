# Supabase backend

The Supabase project is `vortexlearning2` (`dfcgxbfrzwfmbdeceyog`) on the Free plan. Its Edge Function keeps the existing `/api/...` HTTP contract. PostgreSQL migrations and function changes deploy independently of GitHub Pages; changes under `supabase/` do not rebuild or redeploy the frontend.

## One-time setup

1. In the GitHub repository settings, add the Actions secrets `SUPABASE_ACCESS_TOKEN` (create a personal access token in Supabase account settings) and `SUPABASE_DB_PASSWORD` (the database password set when creating the project). Never put either value in source control or chat.
2. Run the **Deploy Supabase backend** workflow. It applies the SQL migrations before deploying the API function.
3. In Supabase Authentication → URL Configuration, set the **Site URL** to `https://fidelsteven14-gif.github.io/vortexlearning2/` and add `https://fidelsteven14-gif.github.io/vortexlearning2/**` to the **Redirect URLs** allow list. Also allow `http://localhost:5173/**` and `http://localhost:4173/**` for local development. Remove any stale `http://localhost:3000` Site URL or redirect entry; otherwise recovery links may send production users to localhost.
4. In Authentication → Email Templates, paste `templates/confirm-sign-up.html` into the **Confirm sign up** body and `templates/reset-password.html` into the **Reset password** body. Set the subjects to `VERIFY YOUR EMAIL — Vortex Learning` and `RESET YOUR PASSWORD — Vortex Learning`. These are live Supabase dashboard settings and are not changed by deploying migrations or the Edge Function. The confirmation email displays the code in large type and its button opens the app with the code prefilled. Email clients do not allow scripts to copy text to the clipboard, so the working **Copy code** button is in the verification form. Configure custom SMTP for authentication emails; Supabase's default sender is restricted and not suitable for public sign-ups.
5. The Pages workflow defaults `VITE_API_BASE_URL` to `https://dfcgxbfrzwfmbdeceyog.supabase.co/functions/v1`. If you later move the API, set the GitHub repository variable `VITE_API_BASE_URL` to override it, then run the **Deploy frontend to GitHub Pages** workflow.
6. Local SQLite accounts and passwords are not migrated to Supabase. To bootstrap the first Super Admin, first create and confirm the administrator's email account in Supabase Authentication → Users, then run this in the SQL editor, replacing the email and phone placeholders with the account details:

   ```sql
   insert into public.profiles (id, name, username, email, email_verified, role, active, phone_number)
   select
     u.id,
     coalesce(nullif(trim(u.raw_user_meta_data ->> 'name'), ''), 'Platform Administrator'),
     'admin-' || substr(replace(u.id::text, '-', ''), 1, 10),
     lower(u.email),
     true,
     'super_admin',
     true,
     'YOUR_ADMIN_PHONE'
   from auth.users u
   where lower(u.email) = lower('YOUR_ADMIN_EMAIL')
     and u.email_confirmed_at is not null
   on conflict (id) do update
     set role = 'super_admin', active = true, email_verified = true,
         phone_number = excluded.phone_number;
   ```

   Confirm that the query affected one row. The Super Admin signs in using the shared Teacher / Staff flow, school name `Vortex Learning`, this registered phone number, and the password set in Supabase Authentication. Do not put an administrator password in SQL or source control.

## Verification and email behavior

The Super Admin school registration workflow is backed by the additive
`20261014130000_school_onboarding.sql` migration. It extends the existing school
and staff records, creates a school and its initial administrator record in one
database transaction, and leaves existing principal details and signatures
untouched. Newly registered schools start as **Pending Verification** and
**Active**; a Super Admin must explicitly update verification and operational
status in the school directory. Selected grades are stored with the school and
are used to constrain new class and results configuration.

The initial School Administrator is invited through Supabase Auth. Configure
custom SMTP and paste `templates/invite-user.html` into Authentication → Email
Templates → **Invite user**. Make sure the GitHub Pages URL remains on the Auth
redirect allowlist. The administrator follows the secure invitation link and
sets their own password; the account remains inactive until that step
completes. A failed email send does not roll back the school record; use
**Resend invitation** in the school directory after correcting Auth email
delivery settings.

School logos are kept in the existing private `school-documents` bucket. The
API validates image signatures and size, associates each object with its school,
and serves short-lived signed image URLs; no public bucket or new secret is
required. The registration form includes all 47 counties. Since this repository
does not contain an authoritative Sub-County mapping, Sub-County is entered as
text after selecting a county rather than populated from invented mappings.
Existing schools retain blank/unknown category, ownership, location, and grade
metadata rather than being assigned fabricated values.

The school-based target onboarding flow is documented in `CBC-PLATFORM-PLAN.md`. The `20261014050000_school_platform.sql` migration adds school, class, roster, teacher-assignment, results, report-copy, timetable, and notice tables. It is a data-model foundation; do not treat it as a completed rollout until the API and frontend workflows are also deployed and verified.

The migration seeds only the app's curriculum and sample learning material. It does not import local SQLite accounts, invitations, attempts, or other learner data.

The Supabase project uses private Storage for PDFs and Row Level Security with access restricted to the Edge Function's service role. Keep privileged keys in Supabase/GitHub secret stores only. The Free plan can pause inactive projects; resume it from the Supabase dashboard if the API becomes unavailable after inactivity.

The school redesign no longer uses Google sign-in, student usernames, or student codes as its intended sign-in identifiers. Existing legacy columns and data are retained by the additive migration to avoid deleting records before their replacement flows are tested; remove them only in a later, explicitly reviewed cleanup migration.
