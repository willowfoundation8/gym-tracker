# Gym Tracker — Best Practices & Learnings

A running log of architectural decisions, hard-won lessons, and patterns that
worked. Updated as the project evolves.

---

## Architecture

**Isolate the data layer from day one**
All storage access goes through `db.js` with stable `async` function signatures.
Components never touch Dexie or IndexedDB directly. When the cloud migration
happens (Supabase/Firebase), only the *internals* of `db.js` change — every
call site in `App.jsx` stays untouched. Making functions `async` even when local
reads are instant means no refactor later.

**Shape local data like database rows now**
Store records with the fields a server would expect: UUIDs, ISO timestamps,
normalised keys. When you migrate, the data already fits the schema.

**Two-phase AI is cleaner than one-shot**
Separating board vision (extract raw text) from abbreviation expansion (resolve
shorthand) keeps each model call focused and easier to debug. One prompt doing
both produced inconsistent output; two focused prompts are reliable.

**Learned naming > hard-coded dictionaries**
A persistent user-confirmed mapping store is more robust and personalised than
maintaining a static abbreviation list. Unknown shorthand triggers an AI
suggestion the user confirms or edits; once saved it's remembered permanently
with no re-querying. The same pattern scales to any domain-specific vocabulary.

**Seed dict + learned store > pure AI for classification**
For exercise modality detection: a small hardcoded seed dictionary (~45 common
exercises) handles the 80% case instantly with zero latency and zero API cost.
The learned store handles gym-specific or unusual exercises after first
confirmation. AI suggestion is the fallback for truly unknown entries, not the
primary path. This hierarchy keeps the app fast and cheap at scale.

**Versioned schema migrations with Dexie**
Use `db.version(N).stores({...})` for every schema change. Dexie handles the
upgrade automatically on first load — existing user data is preserved. Never
edit an existing version; always add a new one. Document what each version adds
in a comment.

---

## AI Integration

**Diagnostic shims are worth the throwaway code**
When diagnosing deployment issues, adding a temporary GET handler that reports
API key presence, length, prefix, and Anthropic's raw error response was the
key to catching a retired model string. The throwaway code saved hours of
guessing. Remove it once the issue is resolved, but don't hesitate to add it.

**Model strings go stale — treat them as config, not constants**
The model string `claude-sonnet-4-20250514` was retired without warning mid-
deployment. Store the model string in one place (the proxy function) so it's
one edit to update. Never hardcode it in multiple locations.

**`anthropic-version` is the API spec version, not the model version**
`2023-06-01` is correct and stable — it applies to all current models and does
not need to change when the model string changes.

**Extend prompts incrementally, don't redesign them**
The vision prompt started returning `name`, `suggestedSets`, `suggestedReps`.
Adding `modality` was a one-line addition to the JSON spec in the prompt. Each
field addition is low risk because the model already understands the task.
Avoid redesigning a working prompt; append to it.

**Validate AI-returned enums before trusting them**
The vision prompt asks for `modality` as one of five values. Always validate
against the known set (`MODALITIES.includes(x.modality)`) before storing —
models occasionally hallucinate field values outside the specified enum.

---

## UI & Mobile

**Resistance steppers beat number inputs on mobile**
For small integer ranges (1–10 resistance levels), a `−` / value / `+` stepper
is faster and less error-prone than a keyboard input on a phone. The user
adjusts by one notch at a time on the machine anyway — the UI should match that
mental model.

**`mm:ss` time inputs need an intermediate display state**
Storing duration as integer seconds (clean for arithmetic) but editing as
`mm:ss` (natural for humans) requires a local `useState` in the input component
that holds the raw string while typing, only committing to seconds `onBlur`.
Don't try to parse on every keystroke.

**`colorScheme: 'dark'` on date/time inputs prevents flash**
Native `<input type="date">` and `<input type="time">` default to a light
picker sheet on iOS even inside a dark app. Adding `colorScheme: 'dark'` to the
inline style (not just CSS) suppresses this.

**Date storage: always store ISO, edit as `YYYY-MM-DD`**
`<input type="date">` requires a `YYYY-MM-DD` string. Convert to/from ISO on
the boundary (`save()` and `openWorkout()`). Use `T12:00:00` local time when
constructing the ISO string to avoid midnight UTC boundary drift for users in
negative-offset timezones.

**Weight logging convention: total moved, stated without an exception clause**
Log the total weight moved — two 20kg dumbbells is 40kg, one 30kg dumbbell is
30kg, a 40kg barbell is 40kg. Single-arm and single-leg work is logged as one
set per side (8 left + 8 right is two sets of 8, not one set of 16).

The phrasing matters as much as the rule. "Combined unless single-handed" reads
as two rules, but they never actually diverge: a one-arm row with a 30kg
dumbbell moves 30kg either way. The unconditional wording removes a judgement
call at the exact moment of entry, when the user is mid-workout and least
inclined to think about it. History logged before this was written down was
already combined, so no records need reinterpreting — the rule documents
existing behaviour rather than changing it.

Surfaced in-app as a tap-to-reveal `InfoTip` on the weight column header.
Tap-to-toggle, not hover — hover doesn't exist on a phone.

---

## Progress & Metrics

**One metric per exercise modality — don't force everything into reps × weight**
Exercises fall into five distinct modalities, each with the right primary
metric:

| Modality | Primary metric | Secondary |
|---|---|---|
| Strength | e1RM (Epley) | Volume load (sets × reps × weight) |
| Bodyweight | Max reps (best set) | Total reps volume |
| Distance | Best set distance | Total session distance |
| Duration | Longest hold (seconds) | Total time |
| Cardio | Effort score | Distance |

Forcing a plank or sled push into a reps × weight chart produces meaningless
numbers. Match the metric to the movement.

**Epley e1RM is the right normaliser for strength**
`weight × (1 + reps / 30)` maps any set (heavy singles, volume sets) to a
comparable "max effort" number. A 1×3 at 100kg and a 4×12 at 60kg become
directly comparable. This is what the major strength apps (Hevy, Strong) use
as their primary trend line.

**Cardio effort score factors in resistance**
`(distance ÷ time_seconds) × (1 + resistance ÷ 20)` rewards sessions done at
higher damper/resistance settings rather than treating all pace equally. The
`÷ 20` term scales resistance 1–10 to a 5–50% pace bonus, keeping the formula
proportionate.

**Optional metrics need a null-emitting series, not a backfilled one**
Time on a distance set is optional, so pace only exists for sessions where a
time was logged. Those sessions emit `paceSecPerKm: null` and the chart draws
them with `connectNulls={false}`. Interpolating across the gap would draw a
pace the user never ran. A visible gap is honest; a smooth line is a lie.

Pace also can't share an axis with distance — sec/km (~240–420) against metres
(~800–10000) squashes it flat. It rides a third `hide`-ed Y axis scaled to its
own domain, so the shape of the trend is readable even though the absolute
value is only available in the tooltip. Lower is faster, which means a falling
line is an improvement — counterintuitive enough that the chart note says so.

**Two chart views serve different questions**
The combined chart (e1RM line + volume bars) answers "am I getting stronger
over time?" The scatter chart (one dot per set, size = reps or resistance)
answers "what is my weight/volume tradeoff within and across sessions?" Both
are needed; neither replaces the other.

---

## Deployment

**Cloudflare Pages ≠ Cloudflare Workers**
Easy to accidentally initialise the wrong project type. Pages Functions live in
`functions/api/` and use `export async function onRequestPost(ctx)`. Redeploy
after setting environment variables — they don't take effect on the running
build.

**GitHub web editor creates folder structures from file paths**
Without CLI access, entering `functions/api/vision.js` as the filename in the
GitHub web editor auto-creates the nested directory. No need for a terminal to
scaffold the folder structure.

**Environment variables require a redeploy to take effect on Cloudflare Pages**
Setting a secret in the Cloudflare dashboard does not hot-reload the running
deployment. Always trigger a new deploy after adding or changing secrets.

---

## Process

**Defer non-core features to ship a focused v1**
PRs and streaks are valuable but they're a layer on top of clean logging. Get
logging solid first; the stats fall out easily afterward. Every deferred feature
is a decision, not an oversight.

**Design the migration path before you need it**
The cloud sync upgrade (Supabase/Firebase) was identified as the next major
upgrade from day one, so `db.js` was designed with it in mind. When that work
starts, the call sites are already correct — only the internals change.
