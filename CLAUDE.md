# CLAUDE.md — operational notes

Short and practical. The *why* behind decisions lives in `BEST_PRACTICES.md`;
the sync/auth design lives in `CLOUD_SYNC_DESIGN.md`. Don't merge them.

## What this is

Mobile-first gym workout tracker PWA, in daily use with real data on a phone.
Core flow: photograph the class-gym whiteboard → Claude vision parses the
exercises → verify → save. Live at **gym-tracker-en7.pages.dev**.

## Stack

- React 18 + Vite SPA, no router (screens are `screen` state in `App.jsx`)
- Dexie / IndexedDB for all user data, **schema v4**
- Supabase (Postgres) for auth + sync; Google SSO
- Recharts for progress charts
- Cloudflare Pages hosting; Pages Functions proxy the two Anthropic calls
- No test runner. Verification is `npm run build` plus a manual walkthrough

## File map

```
functions/api/vision.js    Board photo → exercises (Anthropic proxy)
functions/api/expand.js    Shorthand → full names (Anthropic proxy)
src/App.jsx                Shell: routing, top-level state, all screens
src/styles.js              The `S` style object + ACCENT/BLUE
src/db/index.js            THE public surface — screens import only from here
src/db/local.js            Dexie layer, schema versions, export/import, logs
src/db/supabase.js         Client + auth helpers (signInGoogle, getSession, …)
src/db/sync.js             Push + pull engine, LWW merge, owner gate
src/lib/helpers.js         uid, toKg, toMeters, fmtDist, secToInput, parseModelJSON
src/lib/metrics.js         epley, computeProgressData, exerciseStats, CHART_CONFIG
src/lib/modality.js        MODALITY_SEED, bodyRegion, emptySet, isSledType
src/lib/vision.js          extractExercises, expandViaAI, resolveNames, prompts
src/components/SetRows.jsx Per-modality set row components + SET_HEADERS
src/components/Tooltips.jsx Chart tooltips + InfoTip + WEIGHT_CONVENTION
```

`components/` at the repo root is **dead code** — a leftover from the
phone-only era. Nothing imports it. Safe to delete.

## Working rules

1. **Plan before code.** Present the plan and wait for explicit approval before
   editing. For refactors, give a symbol → destination map.
2. **One phase = one commit**, using the commit message from the design doc.
3. **Never put the Supabase service-role key client-side.** Anon/publishable
   key + RLS is the security boundary. The publishable key is committed
   deliberately; it ships in the bundle and is public by design.
4. **JSON export/import stays intact permanently** — the escape hatch
   regardless of how well sync works.
5. **Dexie version bumps only in the phase that needs them.** This is a
   production app; on-device data is precious. Get a fresh JSON backup from
   the phone before any migration.
6. **Units are canonical kg/m internally.** All-metric. Convert at the display
   or compute boundary, never in storage.
7. **If the code and a design doc conflict, flag it — don't silently resolve.**
   Both doc errors that broke sync were found this way.

## Verification ritual

1. `npm run build` — must pass
2. `npm run dev`, walk every screen: Home, Capture, Edit, Progress, Logs
3. For data-layer changes, inspect IndexedDB directly rather than trusting the
   UI — check the stored shape, not just what renders
4. For sync changes, verify with two accounts and two browser profiles
5. Anything unverifiable locally: **say so explicitly** rather than implying
   it was tested

Note: `npm run dev` needs nvm on PATH — `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.

Browser automation note: synthetic clicks intermittently fail to reach React
on this app. Driving components via their React props
(`el[Object.keys(el).find(k => k.startsWith('__reactProps$'))].onClick(...)`)
is reliable. `window.__sb` exposes the Supabase client for console diagnostics.

## Deploy

`git push` → Cloudflare Pages auto-builds → live. **Push is deploy.** Don't add
other deploy tooling.

Because push deploys straight to the app in daily use:
- Verify locally first; production is a bad place to discover a broken login
- A commit that changes no source produces an identical bundle, so you
  **cannot** tell a successful build from a failed one by fetching the site —
  check the Cloudflare Deployments tab
- The Pages Functions carry `ANTHROPIC_API_KEY` from the Cloudflare dashboard.
  Env var changes need a redeploy to take effect. Locally they come from
  `.dev.vars` (gitignored — it holds a real key)

There is a second, unrelated Cloudflare project called **fitness-tracker**
wired to a different repo, with a broken build config. Its failures are not
this app.
