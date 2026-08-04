# RMMIS Pilot Site — Setup

A static site (works on GitHub Pages) that talks directly to your Supabase
project. No backend server needed except the one Edge Function you already
deployed.

## 1. Create your first administrator (one-time, manual)

There's no admin yet, so the very first one has to be created by hand in the
Supabase dashboard — after that, admins can be managed through the app.

1. Supabase Dashboard → Authentication → Users → **Add user**
   - Email: `<your-phone-digits>@vendor.rexba.local` (e.g. `0701234567@vendor.rexba.local`)
   - Password: pick something only you know (admins are not on the shared pilot password)
   - Check "Auto Confirm User"
2. Copy the new user's UUID.
3. SQL Editor → run:
   ```sql
   insert into app_users (id, role, full_name, phone, force_password_reset)
   values ('<paste-uuid-here>', 'administrator', 'Your Name', '0701234567', false);
   ```
4. You can now log into the site with `0701234567` and the password you set.

Create your first **market**, **sections**, and **stalls** the same way via
SQL Editor (or the Table Editor UI) — the Admin "Markets & Stalls" tab is
currently read-only for the pilot; let me know if you want an in-app form for
this next.

## 2. Deploy to GitHub Pages

1. Create a new GitHub repo, push everything in this folder to it.
2. Repo → Settings → Pages → Source: deploy from branch → `main` / root.
3. Your site will be live at `https://<username>.github.io/<repo>/`.

No build step, no environment variables to set — the Supabase URL and
publishable key are already in `js/supabase-client.js`.

## 3. Creating managers

Same process as the admin above, but with `role = 'manager'` and
`assigned_market_id` set to the market they'll manage. A dedicated admin UI
for this is a good Phase 2 addition once the pilot data is in.

## 4. Importing your 30 test people

Send the Excel file and I'll write a one-off import script that inserts them
as either pending applications (so the approval flow is tested end-to-end)
or directly as active vendors, whichever you'd prefer for the demo.
