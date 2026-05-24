# FlowDesk Pro Lead Manager — Phase 1 Standalone Package

This is the clean standalone Phase 1 package for the FlowDesk Pro Lead Manager / CRM product.

## Required deployment flow

1. Run `supabase/lead_manager_records_schema.sql` in the Supabase SQL Editor.
2. Upload this project to GitHub.
3. Connect the repository to Netlify.
4. Add the environment variables from `env.template` in Netlify.
5. Deploy.
6. Test `/intake`, then verify `/dashboard`.

Frontend pages call Netlify Functions only. Supabase and Resend secrets must remain in Netlify environment variables.
