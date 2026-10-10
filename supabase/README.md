# Supabase backend

The Supabase project is `vortexlearning2` (`dfcgxbfrzwfmbdeceyog`) on the Free plan. Its Edge Function keeps the existing `/api/...` HTTP contract. PostgreSQL migrations and function changes deploy independently of GitHub Pages; changes under `supabase/` do not rebuild or redeploy the frontend.

## One-time setup

1. In the GitHub repository settings, add the Actions secrets `SUPABASE_ACCESS_TOKEN` (create a personal access token in Supabase account settings) and `SUPABASE_DB_PASSWORD` (the database password set when creating the project). Never put either value in source control or chat.
2. Run the **Deploy Supabase backend** workflow. It applies the SQL migrations before deploying the API function.
3. In Supabase Authentication → URL Configuration, set the **Site URL** to `https://fidelsteven14-gif.github.io/vortexlearning2/` and add `https://fidelsteven14-gif.github.io/vortexlearning2/**` to the **Redirect URLs** allow list. Also allow `http://localhost:5173/**` and `http://localhost:4173/**` for local development. Remove any stale `http://localhost:3000` Site URL or redirect entry; otherwise recovery links may send production users to localhost.
4. In Authentication → Email Templates, paste `templates/confirm-sign-up.html` into the **Confirm sign up** body and `templates/reset-password.html` into the **Reset password** body. Set the subjects to `VERIFY YOUR EMAIL — Vortex Learning` and `RESET YOUR PASSWORD — Vortex Learning`. These are live Supabase dashboard settings and are not changed by deploying migrations or the Edge Function. The confirmation email displays the code in large type; email clients do not allow scripts to copy text to the clipboard, so the actual **Copy code** button is on the verification form after the code is entered. Configure custom SMTP for authentication emails; Supabase's default sender is restricted and not suitable for public sign-ups.
5. If Google sign-in is needed, configure Google as a Supabase Auth provider and set the matching `VITE_GOOGLE_CLIENT_ID` for the frontend build.
6. The Pages workflow defaults `VITE_API_BASE_URL` to `https://dfcgxbfrzwfmbdeceyog.supabase.co/functions/v1`. If you later move the API, set the GitHub repository variable `VITE_API_BASE_URL` to override it, then run the **Deploy frontend to GitHub Pages** workflow.
7. Local SQLite accounts and passwords are not migrated to Supabase. To create the platform administrator, first create and confirm the administrator's email account in Supabase Authentication → Users, then run this in the SQL editor, replacing the placeholder with that exact email:

   ```sql
   insert into public.profiles (id, name, username, email, email_verified, role, active)
   select
     u.id,
     coalesce(nullif(trim(u.raw_user_meta_data ->> 'name'), ''), 'Platform Administrator'),
     'admin-' || substr(replace(u.id::text, '-', ''), 1, 10),
     lower(u.email),
     true,
     'admin',
     true
   from auth.users u
   where lower(u.email) = lower('YOUR_ADMIN_EMAIL')
     and u.email_confirmed_at is not null
   on conflict (id) do update
     set role = 'admin', active = true, email_verified = true;
   ```

   Confirm that the query affected one row. Do not put an administrator password in SQL or source control.

## Verification and email behavior

The signup API creates only a Supabase Auth identity with the email and password hash needed to deliver a one-time code. It does not store name, username, grade, or a learner profile until a correct code is verified. After verification, the API inserts the learner profile. The pending form details are retained only in the browser's session storage while verification is in progress. The migration removes existing unverified student profiles and their unverified Auth metadata; those users need to register again and verify with the new flow.

The migration seeds only the app's curriculum and sample learning material. It does not import local SQLite accounts, invitations, attempts, or other learner data.

The Supabase project uses private Storage for PDFs and Row Level Security with access restricted to the Edge Function's service role. Keep privileged keys in Supabase/GitHub secret stores only. The Free plan can pause inactive projects; resume it from the Supabase dashboard if the API becomes unavailable after inactivity.
