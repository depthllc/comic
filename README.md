# Comic30 Creator Portal

Comic30 is now scaffolded as an AI-enabled game creation portal with a working local backend and a polished responsive frontend.

## What Is Included

- Account registration, login, logout, and HttpOnly cookie sessions.
- Email verification, password reset token generation, CSRF, rate limiting, and audit events.
- Supabase/Postgres persistence in production, with `data/db.json` retained only for local development.
- Project creation for storyline, genre, audience, art style, and gameplay loop.
- AI-style design pass that can use a real LLM when `OPENAI_API_KEY` is configured.
- Character roster editing.
- Internal wallet ledger for player rewards and debits.
- In-app purchase product configuration.
- Serverless-safe export generation through private Supabase Storage or in-memory download streams.
- Export contents: game data, story, characters, economy, playable HTML prototype, mobile runtime notes, Unity/Unreal/Flutter/React Native/Comic30 runtime pipeline notes, store checklist, and API contract.
- Consent-gated contact import preview tooling.

## Run Locally

```bash
node server.js
```

Then open:

```text
http://127.0.0.1:5173
```

## Production Hardening

This is a launchable MVP scaffold, not a final AAA app-store build pipeline. See `docs/production-hardening.md` and `docs/database-schema.sql` for the production checklist and managed database starter schema.

Useful checks:

```bash
npm run check
```

## Vercel + Supabase deployment

1. Run `docs/database-schema.sql` in the Supabase SQL editor.
2. Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET=comic30-exports` to the Vercel project environment.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side; never prefix it with `NEXT_PUBLIC_` or expose it in browser code.
4. Deploy the repository. Vercel serves `public/` statically and routes `/api/*` through `api/index.js`.

The API intentionally returns a configuration error in production when Supabase is missing. It never falls back to an ephemeral Vercel filesystem.

Preview a consented contact import:

```bash
node tools/import-consented-contacts.js --source contacts.csv
```

Commit only rows that include email, consent/opt-in, and source:

```bash
node tools/import-consented-contacts.js --source contacts.csv --commit
```
