# Tab Organizer

Tab Organizer is a Chromium extension for saving tabs, collecting links, and
taking notes with video timestamps. Its dashboard includes a searchable library,
collections, session recovery, browsing activity, and a knowledge graph built
from saved content.

Tabs, notes, and collections save to the browser first. If the backend is
unreachable, the extension keeps them pending and uploads them after reconnecting.

The moon button in Open tabs wakes sleeping tabs in the current window and
refreshes their titles. It turns into a golden sun and works through all eligible
tabs, two at a time, without switching the active tab.
It supports sleeping tabs across websites and local files, including restored
website tabs still displaying an address instead of their page title.
If it asks you to keep the panel open, leave it open until waking finishes.

Open tabs load directly from the browser while connection and saved-status
checks run separately. Floating panels close when you switch tabs.
Groups navigation shows cached content while the server refreshes in the
background. On restricted browser pages the extension uses a toolbar popup,
without creating a separate desktop window. Panel styling is isolated from the
website; the extension does not install a browser theme or website dark mode.

Focus the Library search box to choose from colored category pills. Categories
follow content-derived subjects; stale keyword labels cannot override them. Typing switches
to saved-title suggestions, including partial words and common typos; Enter
without selecting a suggestion keeps the normal resource search.

Topic generation interprets titles and descriptions together. Graph discovery
and RAG embeddings exclude saved classification guesses, suggested tags, URLs
and companion notes as subject evidence. Saving never waits for classification.
If contextual AI is unavailable, weak keyword matches remain unclassified.

Activity subjects use recorded page titles and video channels, including unsaved
videos. The popup's **Browsing check-in** estimates entertainment time from
those subjects for today, this browser session and this week. Unclassified
time stays separate; you can correct the current page's estimate.

Use the clock above the popup notes bar to set a page reminder. Confirm a typed
schedule or choose a time manually. Reminders support daily and alternate-day
repeats, multiple times per day, Snooze and Done. Manage them under **Reminders**
in the dashboard. The device catches up on missed alerts when the browser opens
and syncs changes to the backend. With Google Calendar configured on the backend,
connect from Reminders to mirror events to a dedicated calendar and receive phone
alerts. You can also export a calendar file for manual import.

Activity subject headings use recorded content from saved and unsaved
videos. Headings reflect the selected time period, with small interests grouped
together. Subject inference runs on the hosted backend separately from recording
time, uses the configured AI provider, and retries later if it is unavailable.
Old entries with insufficient metadata may remain unclassified.

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
