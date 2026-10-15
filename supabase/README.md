# Supabase backend

The Supabase project is `vortexlearning2` (`dfcgxbfrzwfmbdeceyog`) on the Free plan. Its Edge Function keeps the existing `/api/...` HTTP contract. PostgreSQL migrations and function changes deploy independently of GitHub Pages; changes under `supabase/` do not rebuild or redeploy the frontend.

## One-time setup

1. In the GitHub repository settings, add the Actions secrets `SUPABASE_ACCESS_TOKEN` (create a personal access token in Supabase account settings) and `SUPABASE_DB_PASSWORD` (the database password set when creating the project). Never put either value in source control or chat.
2. Run the **Deploy Supabase backend** workflow. It applies the SQL migrations before deploying the API function.
3. In Supabase Authentication → URL Configuration, set the **Site URL** to `https://fidelsteven14-gif.github.io/vortexlearning2/` and add `https://fidelsteven14-gif.github.io/vortexlearning2/**` to the **Redirect URLs** allow list. Also allow `http://localhost:5173/**` and `http://localhost:4173/**` for local development. Remove any stale `http://localhost:3000` Site URL or redirect entry; otherwise recovery links may send production users to localhost.
4. In Authentication → Email Templates, paste `templates/confirm-sign-up.html` into the **Confirm sign up** body and `templates/reset-password.html` into the **Reset password** body. Set the subjects to `VERIFY YOUR EMAIL — Vortex Learning` and `RESET YOUR PASSWORD — Vortex Learning`. Template content and custom SMTP remain Supabase dashboard settings; the backend workflow sets six-digit email codes to expire after three hours. Student email verification uses the code form, while staff activation emails also include a one-click button. Configure custom SMTP for authentication emails; Supabase's default sender is restricted and not suitable for public sign-ups.
5. The frontend defaults `VITE_API_BASE_URL` to `https://dfcgxbfrzwfmbdeceyog.supabase.co/functions/v1` for local and Pages builds. Set `VITE_API_BASE_URL` in `.env` or as a GitHub repository variable to override it if you move the API. The Supabase CORS allow list includes local preview origins.
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

   Confirm that the query affected one row. The Super Admin signs in using the shared Teacher / Staff flow, leaving School name blank and entering this registered phone number or email address and the password set in Supabase Authentication. Do not put an administrator password in SQL or source control.

## Verification and email behavior

The Super Admin school registration workflow is backed by the additive
`20261014130000_school_onboarding.sql` and
`20261015020000_school_email_activation.sql`, and
`20261015030000_require_school_email_before_activation.sql` migrations. School
registration creates a visible pending record so the Super Admin can track and
resend activation, but the school remains inactive and suspended until its
official email is verified. The Supabase Auth invite API accepting an email
request does not confirm delivery; check the recipient's inbox and spam folder,
and use the SMTP provider's delivery logs if it does not arrive. The Super Admin
cannot approve the school or create its School Administrator account before
email verification. After the school email link is used, the school becomes
active and the Super Admin can create the School Administrator account, which
receives a separate activation email. The school email link is single-use; its
temporary authentication identity is removed after verification. Existing
principal details and signatures remain untouched. A Super Admin must still
approve platform verification separately. Selected grades are stored with the
school and are used to constrain new class and results configuration.

School Administrators and teachers receive a one-click activation link, choose
their password after confirming their email, and are signed in automatically.
As with school email activation, an accepted invitation request is not proof
that the recipient's provider delivered the message.
Their accounts remain inactive until activation is complete. Configure custom
SMTP and paste `templates/invite-user.html` into Authentication → Email
Templates → **Invite user**. Make sure the GitHub Pages URL remains on the Auth
redirect allowlist. A failed school email send does not roll back the school
record; resend its verification email from the school profile. A failed
administrator or teacher invitation can likewise be resent after correcting
Auth email delivery settings.

School logos are kept in the existing private `school-documents` bucket. The
API validates image signatures and size, associates each object with its school,
and serves short-lived signed image URLs; no public bucket or new secret is
required. The registration form includes all 47 counties. Since this repository
does not contain an authoritative Sub-County mapping, Sub-County is entered as
text after selecting a county rather than populated from invented mappings.
Existing schools retain blank/unknown category, ownership, location, and grade
metadata rather than being assigned fabricated values.

Super Admin school profiles show live verification and operational status from
the database. Verify, suspend/reactivate, and archive actions are available
there; archiving retains school data and disables access. Permanent deletion is
separate, requires an archived school and exact-name confirmation, and removes
school records. The Super Admin can open each school's student and teacher
databases from its profile. Logo uploads can be retried from the profile if the
initial upload fails.

School Administrators enter each teacher's email during onboarding. Supabase
sends a one-time code and a secure activation button to that address. The code
and link expire after three hours (`auth.email.otp_expiry = 10800` in
`supabase/config.toml`). This Supabase setting applies to all email OTPs and
confirmation links for the project. Teachers can activate independently while
the School Administrator continues adding other teachers; the Teachers list
shows **Not verified**, **Email verified · activation pending**, or **Verified**
and refreshes every 15 seconds. Pending activation emails can be resent there.
The teacher's completed account can sign in with their school name and
registered phone number or email.

The school-based target onboarding flow is documented in `CBC-PLATFORM-PLAN.md`. The `20261014050000_school_platform.sql` migration adds school, class, roster, teacher-assignment, results, report-copy, timetable, and notice tables. It is a data-model foundation; do not treat it as a completed rollout until the API and frontend workflows are also deployed and verified.

The migration seeds only the app's curriculum and sample learning material. It does not import local SQLite accounts, invitations, attempts, or other learner data.

The Supabase project uses private Storage for PDFs and Row Level Security with access restricted to the Edge Function's service role. Keep privileged keys in Supabase/GitHub secret stores only. The Free plan can pause inactive projects; resume it from the Supabase dashboard if the API becomes unavailable after inactivity.

The school redesign no longer uses Google sign-in, student usernames, or student codes as its intended sign-in identifiers. Existing legacy columns and data are retained by the additive migration to avoid deleting records before their replacement flows are tested; remove them only in a later, explicitly reviewed cleanup migration.
