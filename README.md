# Tab Organizer

Tab Organizer is a Chromium extension for saving tabs, collecting links, and
taking notes with video timestamps. Its dashboard includes a searchable library,
collections, session recovery, browsing activity, and a knowledge graph built
from saved content.

Tabs, notes, and collections save to the browser first. If the backend is
unreachable, the extension keeps them pending and uploads them after reconnecting.

## Install the extension

1. Install Node.js 22.12 or later and clone this repository.
2. Build the extension from the repository root.

   ```sh
   cd Tab_Organizers/extension
   npm ci
   npm run build
   ```

3. Open your browser’s Extensions page, enable Developer mode, and use **Load
   unpacked** to select `Tab_Organizers/extension/dist`. Reload the extension
   from that page after rebuilding it.
4. Open the extension dashboard and go to **Settings → Backend connection**.
   Enter your hosted backend URL and private connection key, or use the local
   backend described below.

Keep the loaded `dist` folder at its original path. The browser reads the
extension files from that folder when it starts.

## Choose a backend

For hosted use, FastAPI runs on Vercel and stores application data in Supabase
PostgreSQL. Cloudflare Workers AI can supply embeddings, and Gemini can generate
answers and topic headings. The extension needs the hosted backend URL and its
private connection key. See [Cloud setup](CLOUD_SETUP.md) for configuration and
migration.

For local development, start FastAPI from `Tab_Organizers/backend`.

```sh
python -m pip install -r requirements.txt
python -m app.main
```

The default local URL is `http://127.0.0.1:8742`, and SQLite stores data in the
backend’s `data/` directory. Optional local embedding dependencies are listed in
`requirements-local.txt`.

## Development checks

- In `Tab_Organizers/extension`, run `npm run build` and `node --test tests/*.test.mjs`.
- In `Tab_Organizers/backend`, install `requirements-dev.txt` and run `python -m pytest -q`.

Keep environment files, connection keys, runtime data, and private backups
outside version control. Use the example configuration files for the names of
the required settings.
