# Cloud setup

Run FastAPI on Vercel with Supabase PostgreSQL.

## 1. Save connection details locally

From PowerShell in the nested `Tab_Organizers/backend` directory, run:

```powershell
python scripts/configure_cloud.py
```

The helper asks for:

- **DATABASE_URL:** Supabase's **Connect > Transaction pooler** connection string.
  If it includes `[YOUR-PASSWORD]`, the helper asks for the saved database password
  separately and safely URL-encodes it. Keep `sslmode=require` in the connection
  string; add it if the copied URL omits it.
- **CLOUDFLARE_ACCOUNT_ID** and **CLOUDFLARE_API_TOKEN:** the Workers AI REST API
  account ID and token created earlier.
- **SUPABASE_URL:** the project's HTTPS URL.
- **GEMINI_API_KEY:** retained from the existing local config when already set.
  Use a Google AI project on the free tier to keep generation free.

The helper generates the private connection key and maintenance secret, saving everything in the ignored
`backend/.env.cloud` file. It does not upload data or print secret values. The
ordinary `.env` files continue to control local mode.

To check which fields remain empty, without printing values:

```powershell
python scripts/configure_cloud.py --check
```

## 2. Migration and deployment

The backend must be tested before deployment. Direct database initialization is
available when the local network can reach PostgreSQL; an HTTPS migration route
also supports networks that block database ports.
The migration command first inspects the source and target, preserves a local
backup, and refuse to overwrite an existing cloud library. It will preserve
notes, saved groups, recovery sessions and removed items. Search vectors will be
rebuilt for the new model; different embedding models cannot share old vectors.

From `Tab_Organizers/backend`, inspect first:

```powershell
python scripts/migrate_to_cloud.py
```

After reviewing the dry-run counts, copy into the empty project:

```powershell
python scripts/migrate_to_cloud.py --apply
```

If database ports are blocked locally, deploy the key-protected backend first.
Then use the production URL for both the dry run and the import:

```powershell
python scripts/migrate_to_cloud.py --backend-url https://your-project.vercel.app
python scripts/migrate_to_cloud.py --backend-url https://your-project.vercel.app --apply
```

This sends one compressed SQLite snapshot and whitelisted recovery/configuration
documents over HTTPS, protected by the private connection key. The temporary
server copy is removed after import. The same empty-target guard and transaction
apply. The upload is bounded to 4 MiB compressed and 32 MiB expanded; larger
libraries need direct migration or an explicitly reviewed alternative.

Vercel's project root will be `Tab_Organizers/backend`, using the Hobby plan.
Private configuration values belong in its **Environment Variables**, never in
the repository or the extension bundle. A free Vercel-provided domain is enough.

The extension will connect to the deployed backend URL through Settings. It will
send the private connection key with API requests. Paste `BACKEND_API_KEY` once
into **Settings > Backend connection** with the production Vercel URL. The key
controls this personal library; it is not the Cloudflare token or Gemini key.
Private data remains inaccessible without that connection key.

## Free-tier boundaries

Choose Free/Hobby plans and leave paid upgrades disabled. The backend does not
switch automatically to another AI provider on quota failure. Hosted embedding
results are cached and a database-backed daily input budget bounds new work.
An exhausted embedding allowance uses an explicitly reported text-search
fallback; it does not download a local model on the cloud server.

Vercel functions have finite lifetimes. Recycle cleanup therefore runs through
an authenticated daily cron instead of a permanent background process. Items
become unrestorable at five days; physical cleanup can wait for the next sweep.
Inline image attachments initially remain in the PostgreSQL database, preserving
the current note format. Supabase's separate file-storage allowance is not yet
used, so the database's free size limit also applies to those attachments.
