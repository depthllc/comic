# Comic30 Creator Portal

Comic30 is now scaffolded as an AI-enabled game creation portal with a working local backend and a polished responsive frontend.

## What Is Included

- Account registration, login, logout, and HttpOnly cookie sessions.
- File-backed persistence in `data/db.json`.
- Project creation for storyline, genre, audience, art style, and gameplay loop.
- AI-style design pass that expands a project with a new story arc and character.
- Character roster editing.
- Internal wallet ledger for player rewards and debits.
- In-app purchase product configuration.
- Export generation for mobile project kits as ZIP files in `exports/`.
- Export contents: game data, story, characters, economy, playable HTML prototype, mobile runtime notes, store checklist, and API contract.

## Run Locally

```bash
node server.js
```

Then open:

```text
http://127.0.0.1:5173
```

## Production Hardening

This is a launchable MVP scaffold, not a final AAA app-store build pipeline. Before production, Comic30 should add:

- Managed database storage.
- Email verification and password reset.
- Rate limiting, CSRF protection, and audit review tooling.
- Real LLM integration for project generation.
- Native build pipeline for Unity, Unreal, Flutter, React Native, or a custom Comic30 runtime.
- Apple and Google IAP integrations.
- Wallet custody, crypto compliance, fraud controls, and regional disclosures.
- Privacy policy, age rating, data safety forms, and account deletion flow.
