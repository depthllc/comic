# Comic30 Production Hardening

Comic30 is currently a launchable MVP scaffold. The backend now exposes readiness, compliance, audit, password reset, email verification, CSRF, rate limiting, LLM, contact import, and build-pipeline surfaces. This document is the path from scaffold to production.

## Runtime Services

- Managed database: run `docs/database-schema.sql` in Supabase and configure `SUPABASE_URL` plus the server-only `SUPABASE_SERVICE_ROLE_KEY` in Vercel.
- Export storage: keep the private `comic30-exports` bucket created by the migration and configure `SUPABASE_STORAGE_BUCKET` if using a different name.
- Email: connect a transactional provider for verification and reset emails.
- LLM: set `OPENAI_API_KEY` and `OPENAI_MODEL` for real project generation.
- Admin review: add comma-separated `ADMIN_EMAILS` and use `/api/admin/audit`.

## Security

- Enable `NODE_ENV=production` and `CSRF_STRICT=true`.
- Keep HttpOnly session cookies.
- Keep rate limits for auth, AI agent, and imports.
- Review audit events before enabling public registration.
- Add CAPTCHA or equivalent abuse control before public launch.

## Build Pipelines

Comic30 export bundles include starter paths for:

- Android and iOS native scaffolds.
- Unity.
- Unreal.
- Flutter.
- React Native.
- Comic30 custom runtime.

Final signed builds require CI runners with the correct platform toolchains, signing certificates, provisioning profiles, and store credentials.

## IAP and Wallet

- Validate Apple and Google purchases server-side.
- Store wallet ledger events in the managed database.
- Add custody provider, fraud monitoring, regional restrictions, and tax/legal review before live crypto features.
- Keep rewards optional and disclosed.

## Privacy and Store Readiness

- Publish privacy policy, terms, contact, and account deletion flow.
- Complete Apple privacy nutrition labels and Google data safety forms.
- Complete age rating questionnaires.
- Run internal testing before public store submission.

## Contact Data Import Rule

Comic30 must only import contact rows when the row includes clear consent and source fields. Purchased or scraped lists without consent should stay out of the production database.
