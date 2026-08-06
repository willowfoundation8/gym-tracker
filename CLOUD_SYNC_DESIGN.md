# Cloud Sync & Auth — Design Doc (v1)

Decisions locked: **local-first with sync** · **Supabase** (assumed; flag if not) ·
**Google SSO** · **no login wall** — app stays fully usable logged-out.

---

## 0. New constraint unlocked: laptop

The single-file `App.jsx` existed only for the mobile GitHub-web workflow. With a
real dev environment available, split BEFORE building sync — as a standalone
refactor commit with zero behaviour change:

```
src/
  App.jsx                 // shell: routing, top-level state only
  db/
    index.js              // re-exports the SAME public surface as today
    local.js              // current Dexie layer, unchanged logic
    supabase.js           // client init, auth helpers
    sync.js               // push/pull engine
  lib/
    helpers.js            // uid, toKg, toMeters, fmtDist, secToInput, parseModelJSON
    metrics.js            // epley, computeProgressData, exerciseStats, CHART_CONFIG
    modality.js           // MODALITY_SEED, bodyRegion, isSledType
    vision.js             // extractExercises, expandViaAI, resolveNames, prompts
  components/
    SetRows.jsx           // per-modality set row components
    Tooltips.jsx
    screens/ …            // Home, Capture, Edit, Progress, Logs (optional 2nd pass)
```

Because every import today goes through `./db`, `db/index.js` re-exporting the
same names makes the split mechanical. Verify with the existing Babel-parse +
logic-test ritual, deploy, confirm identical behaviour, THEN start sync.

New dev workflow: `npm run dev` for instant local testing (no more
deploy-to-test), `npx wrangler pages dev` to run the vision/expand functions
locally, git push → Cloudflare deploy unchanged.

## 1. Supabase schema

```sql
create table workouts (
  id         uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       timestamptz not null,
  updated_at timestamptz not null,
  deleted    boolean not null default false,   -- tombstone
  data       jsonb not null                    -- the full workout record as-is
);
create index on workouts (user_id, updated_at);

create table abbrevs (
  user_id uuid not null references auth.users(id) on delete cascade,
  key     text not null,
  name    text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table modalities (
  user_id uuid not null references auth.users(id) on delete cascade,
  key      text not null,
  modality text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
```

RLS — same four policies on each table:

```sql
alter table workouts enable row level security;
create policy "own rows" on workouts for select using (auth.uid() = user_id);
create policy "own insert" on workouts for insert with check (auth.uid() = user_id);
create policy "own update" on workouts for update using (auth.uid() = user_id);
create policy "own delete" on workouts for delete using (auth.uid() = user_id);
-- repeat for abbrevs, modalities
```

JSONB `data` means zero schema churn as the app evolves; `date`/`updated_at`
are lifted out only because sync queries them.

## 2. Auth

- Dashboard: enable Google provider; Google Cloud Console OAuth client with
  Supabase's callback URL; register `gym-tracker-en7.pages.dev` in Supabase
  auth URL config.
- Client: `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } })`
  — full-page redirect (required for iOS PWA), session auto-persisted by
  supabase-js in localStorage.
- UI: account block on Home — signed out: "Sign in with Google to sync";
  signed in: email · last synced · Sync now · Sign out. Sign-out keeps local
  data (local-first means the device copy is yours).

## 3. Local changes (Dexie v4)

```js
db.version(4).stores({
  workouts: 'id, date, dirty',   // add dirty index
  abbrevs: 'key', modalities: 'key', logs: 'id, ts',
  meta: 'key',                    // { key: 'lastPulledAt', value }
});
```

- `saveWorkout` sets `dirty: true`; `deleteWorkout` becomes soft:
  `{ deleted: true, dirty: true, updatedAt: now }` (UI already filters
  `deleted` out of lists; purge locally after successful push).
- Abbrevs/modalities: small enough to sync whole-table (push local, pull
  remote, LWW per key on updated_at).

## 4. Sync engine (`sync.js`)

**Push** (phase 3 — ships first, replaces manual backup ritual):
1. `dirty = await db.workouts.where('dirty').equals(1)…` → upsert to Supabase
   (`onConflict: 'id'`), rows shaped `{ id, user_id, date, updated_at, deleted, data }`.
2. On success: clear `dirty`; hard-delete local tombstones.
3. Push abbrev/modality rows newer than lastPushedAt.

**Pull** (phase 4 — true multi-device):
1. `select * from workouts where updated_at > :lastPulledAt` (RLS scopes to user).
2. Merge LWW: apply remote if `remote.updated_at > local.updatedAt` or local
   missing; remote `deleted` ⇒ delete locally. Local dirty rows always win
   until pushed (they're newer by construction).
3. Set `lastPulledAt` = max remote `updated_at` seen (server clock, not device —
   avoids clock-skew gaps).

**Triggers:** fire-and-forget after every save/delete; on app open; manual
"Sync now". Offline/failed pushes just stay dirty — retried next trigger.
Log every sync outcome to the diagnostics log (`sync_ok`, `sync_push_failed`…).

**First login:** everything local is dirty-by-default absent a flag → one-time
"mark all dirty then push" migration. UUID ids make it idempotent.

## 5. Public surface

Unchanged: every existing `db` export keeps its signature — App screens don't
change for storage reasons. New: `getSession`, `onAuthChange`, `signInGoogle`,
`signOut`, `syncNow`, `getSyncState`.

## 6. Phases → commits

1. `refactor: split App.jsx into modules (no behaviour change)`
2. Supabase project + schema + RLS (dashboard/SQL editor only)
3. `feat: Google sign-in with session persistence` (no sync yet)
4. `feat: push sync — cloud backup of workouts and learned caches`
5. `feat: pull sync with LWW merge and tombstones` (multi-device)

Keep JSON export forever as the escape hatch. Anon key in client code is by
design; RLS is the security boundary — never ship the service-role key.

## 7. Risks / notes

- Test RLS with two Google accounts before trusting it.
- iOS PWA: verify redirect flow returns into the installed app (known quirk;
  fallback is Safari-tab usage during auth).
- Supabase free tier pauses inactive projects (~1 week idle) — fine for
  personal use, first request after pause is slow.
- Vision/expand proxies on Cloudflare: untouched.
