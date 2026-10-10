# Supabase backend

The Supabase project is `vortexlearning2` (`dfcgxbfrzwfmbdeceyog`) on the Free plan. Its Edge Function keeps the existing `/api/...` HTTP contract. PostgreSQL migrations and function changes deploy independently of GitHub Pages; changes under `supabase/` do not rebuild or redeploy the frontend.

## One-time setup

1. In the GitHub repository settings, add the Actions secrets `SUPABASE_ACCESS_TOKEN` (create a personal access token in Supabase account settings) and `SUPABASE_DB_PASSWORD` (the database password set when creating the project). Never put either value in source control or chat.
2. Run the **Deploy Supabase backend** workflow. It applies the SQL migrations before deploying the API function.
3. In Supabase Authentication → URL Configuration, set the **Site URL** to `https://fidelsteven14-gif.github.io/vortexlearning2/` and add `https://fidelsteven14-gif.github.io/vortexlearning2/**` to the **Redirect URLs** allow list. Also allow `http://localhost:5173/**` and `http://localhost:4173/**` for local development. Remove any stale `http://localhost:3000` Site URL or redirect entry; otherwise recovery links may send production users to localhost.
4. In Authentication → Email Templates → Confirm sign up, include `{{ .Token }}` in the message body; the app asks learners to enter this six-digit code. Keep `{{ .ConfirmationURL }}` only if you also want the email to offer a confirmation link. Configure custom SMTP for authentication emails; Supabase's default sender is restricted and not suitable for public sign-ups.
5. If Google sign-in is needed, configure Google as a Supabase Auth provider and set the matching `VITE_GOOGLE_CLIENT_ID` for the frontend build.
6. The Pages workflow defaults `VITE_API_BASE_URL` to `https://dfcgxbfrzwfmbdeceyog.supabase.co/functions/v1`. If you later move the API, set the GitHub repository variable `VITE_API_BASE_URL` to override it, then run the **Deploy frontend to GitHub Pages** workflow.
7. Create the first administrator using Supabase Auth, then promote that account in the SQL editor with `update public.profiles set role = 'admin' where email = lower('YOUR_ADMIN_EMAIL');`. Replace the placeholder with the administrator's email and verify that exactly one row was updated.

The migration seeds only the app's curriculum and sample learning material. It does not import local SQLite accounts, invitations, attempts, or other learner data.

The Supabase project uses private Storage for PDFs and Row Level Security with access restricted to the Edge Function's service role. Keep privileged keys in Supabase/GitHub secret stores only. The Free plan can pause inactive projects; resume it from the Supabase dashboard if the API becomes unavailable after inactivity.
