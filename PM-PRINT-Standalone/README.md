# PM PRINT Standalone

Extracted from the latest `bsais-class-portal-main pm print.zip` source uploaded to the Library on 2026-09-28.

## Included

- `public/pmprint.html` — PM PRINT customer/admin application (the current page already contains its admin UI).
- `src/worker.js` — PM PRINT-only Worker/API logic extracted from the source Worker.
- `migrations/` — PM PRINT D1 migrations only.
- `wrangler.toml` — standalone Cloudflare Worker configuration.
- `package.json` — Wrangler + pdf-lib dependencies.

## Deliberately excluded

- `pmadmin.html`
- BSAIS `index.html`
- BSAIS `print.html`
- BSAIS portal APIs
- BSAIS D1 binding
- BSAIS portal migrations

## Existing production connections

This extraction intentionally binds to the existing PM PRINT resources:

- D1: `pm-print` (`d0673f83-6822-4956-8a42-382826a674d0`)
- R2: `bsais-printing-files`
- PM PRINT R2 objects use the existing `pmprint/` prefixes.

This is an extraction, not a database clone. Deploying this Worker will therefore access the same PM PRINT orders/settings/files as the current PM PRINT deployment.

## Admin credentials

No password is stored in this repository. Configure the Worker secret before deployment:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Optional username:

```bash
npx wrangler secret put ADMIN_USERNAME
```

If `ADMIN_USERNAME` is omitted, the Worker uses `admin`.

## Deploy

```bash
npm install
npx wrangler d1 migrations apply PM_DB --remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

Do not apply or deploy this project against a different D1 database unless a separate PM PRINT environment is intentionally desired.
