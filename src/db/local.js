// src/db.js — data layer backed by Dexie (IndexedDB).
// v2: adds modalities table for learned exercise modality cache.
// Phase 2: export/import for backup (JSON) and analysis (CSV).

import Dexie from 'dexie';

export const db = new Dexie('GymTrackerDB');

db.version(1).stores({
  workouts:  'id, date',
  abbrevs:   'key',
});

// Version 2: adds modalities table. Existing data is untouched.
db.version(2).stores({
  workouts:   'id, date',
  abbrevs:    'key',
  modalities: 'key',   // learned exercise modality: { key, modality }
});

// Version 3: adds logs table for on-device diagnostics.
db.version(3).stores({
  workouts:   'id, date',
  abbrevs:    'key',
  modalities: 'key',
  logs:       'id, ts',  // { id, ts, level, event, detail }
});

// Version 4: sync support.
//   `dirty` — indexed flag marking rows that still need pushing.
//   `meta`  — sync bookkeeping: { key, value }.
// Existing records are untouched by this migration; they simply carry no
// `dirty` property until the first-login migration marks them.
//
// IMPORTANT: `dirty` and `deleted` are stored as 1/0, never true/false.
// IndexedDB cannot index booleans — a record with `dirty: true` is absent
// from the index entirely, so `where('dirty').equals(1)` would silently match
// nothing and NOTHING WOULD EVER SYNC, with no error anywhere.
db.version(4).stores({
  workouts:   'id, date, dirty',
  abbrevs:    'key',
  modalities: 'key',
  logs:       'id, ts',
  meta:       'key',     // { key, value }
});

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const now  = () => new Date().toISOString();
export const nameKey = (n) => (n || '').toLowerCase().trim().replace(/\s+/g, ' ');

// ── Workouts ────────────────────────────────────────────────────────────────
// Deletes are soft from v4 on: the row survives as a tombstone so the deletion
// can propagate to other devices, and is hard-deleted locally once pushed.
// Every read path therefore has to exclude tombstones — the design doc claimed
// the UI already did this, but it did not, and without these filters a deleted
// workout simply reappears.
const isLive = (w) => w && !w.deleted;

export async function getWorkouts() {
  return (await db.workouts.toArray()).filter(isLive).sort((a, b) => new Date(b.date) - new Date(a.date));
}
export async function getWorkout(id) {
  const w = await db.workouts.get(id);
  return isLive(w) ? w : null;
}
export async function saveWorkout(w) {
  const id       = w.id || uuid();
  const ts       = now();
  const existing = await db.workouts.get(id);
  const record   = {
    id,
    date:        w.date        || existing?.date        || ts,
    startTime:   w.startTime   ?? existing?.startTime   ?? null,  // "HH:MM"
    duration:    w.duration    ?? existing?.duration    ?? null,  // integer minutes
    workoutType: w.workoutType ?? existing?.workoutType ?? 'general',
    className:   w.className   ?? existing?.className   ?? null,
    notes:       w.notes       ?? existing?.notes       ?? null,
    exercises: (w.exercises || []).map((ex, i) => ({
      id:         ex.id || uuid(),
      name:       ex.name,
      nameKey:    nameKey(ex.name),
      modality:   ex.modality || 'strength',
      sets:       ex.sets || [],
      orderIndex: ex.orderIndex ?? i,
    })),
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
    deleted: 0,   // a save always un-deletes; 1/0 not boolean (see v4 note)
    dirty:   1,   // needs pushing
  };
  await db.workouts.put(record);
  return id;
}

// Soft delete: keep the row as a tombstone so the deletion reaches other
// devices. sync.js hard-deletes it locally once the tombstone is pushed.
// A workout that was never saved to the cloud still goes through the same
// path — the tombstone is cheap and the flow stays uniform.
// `wasSignedIn` distinguishes a normal delete (sync it, even if offline right
// now) from one made while signed out. Signing out says "keeps local data",
// which reads as local scratch space — so deletions made in that state must
// not silently remove workouts from the account on next sign-in. They are
// tagged and held for confirmation instead.
export async function deleteWorkout(id, wasSignedIn = true) {
  const existing = await db.workouts.get(id);
  if (!existing) return;
  await db.workouts.put({
    ...existing,
    deleted: 1,
    dirty: 1,
    offlineDelete: wasSignedIn ? 0 : 1,
    updatedAt: now(),
  });
}

// ── Exercise rollups ─────────────────────────────────────────────────────────
// Names ordered by most-recent use (class programming repeats — recency beats
// the alphabet for the progress picker).
export async function getExerciseNames() {
  const all = (await db.workouts.toArray()).filter(isLive).sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Map();
  all.forEach((w) => (w.exercises || []).forEach((e) => {
    if (!seen.has(e.nameKey)) seen.set(e.nameKey, e.name);
  }));
  return [...seen.values()];
}

// Kept for backwards compatibility — App.jsx no longer calls this directly
// but external tooling or future features may.
export async function getExerciseHistory(name) {
  const key = nameKey(name);
  const all = (await db.workouts.toArray()).filter(isLive);
  const pts = [];
  all.forEach((w) => (w.exercises || []).forEach((e) => {
    if (e.nameKey === key) {
      const weights = (e.sets || []).map((s) => s.weight).filter((v) => typeof v === 'number');
      if (weights.length) pts.push({ date: w.date, weight: Math.max(...weights) });
    }
  }));
  return pts.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ── Learned naming (abbreviations) ───────────────────────────────────────────
export async function getAbbrevMap() {
  const rows = await db.abbrevs.toArray();
  const map  = {};
  rows.forEach((r) => { map[r.key] = r.name; });
  return map;
}
export async function learnAbbrev(entries) {
  const rows = entries
    .map(({ raw, name }) => ({ key: nameKey(raw), name }))
    .filter((r) => r.key && r.name);
  if (rows.length) await db.abbrevs.bulkPut(rows);
}

// ── Learned modalities ───────────────────────────────────────────────────────
// { key: nameKey(exerciseName), modality } — ALL final modalities are learned,
// including 'strength', so a user correction overwrites a stale wrong entry.
export async function getModalityMap() {
  const rows = await db.modalities.toArray();
  const map  = {};
  rows.forEach((r) => { map[r.key] = r.modality; });
  return map;
}
export async function learnModality(entries) {
  // entries: [{ name: string, modality: string }]
  const rows = entries
    .map(({ name, modality }) => ({ key: nameKey(name), modality }))
    .filter((r) => r.key && r.modality);
  if (rows.length) await db.modalities.bulkPut(rows);
}

/* ===========================================================================
   EXPORT / IMPORT — Phase 2 data safety.
   JSON = full-fidelity backup of all three tables (restore via importAll).
   CSV  = one row per set, for spreadsheets.
=========================================================================== */
export async function exportAll() {
  // Deliberately includes tombstones: this is a full-fidelity backup, and a
  // restore that dropped them would resurrect every workout you ever deleted.
  const [workouts, abbrevs, modalities] = await Promise.all([
    db.workouts.toArray(), db.abbrevs.toArray(), db.modalities.toArray(),
  ]);
  return { app: 'GymTracker', schemaVersion: 4, exportedAt: now(), workouts, abbrevs, modalities };
}

// Merge semantics: bulkPut upserts by primary key. Existing records with the
// same id/key are overwritten by the backup; everything else is untouched.
// Returns counts so the UI can report what happened.
export async function importAll(data) {
  if (!data || data.app !== 'GymTracker' || !Array.isArray(data.workouts)) {
    throw new Error('Not a GymTracker backup file');
  }
  const workouts   = data.workouts.filter((w) => w && w.id);
  const abbrevs    = (data.abbrevs    || []).filter((r) => r && r.key);
  const modalities = (data.modalities || []).filter((r) => r && r.key);
  await db.transaction('rw', db.workouts, db.abbrevs, db.modalities, async () => {
    if (workouts.length)   await db.workouts.bulkPut(workouts);
    if (abbrevs.length)    await db.abbrevs.bulkPut(abbrevs);
    if (modalities.length) await db.modalities.bulkPut(modalities);
  });
  return { workouts: workouts.length, abbrevs: abbrevs.length, modalities: modalities.length };
}

// Pure CSV builder (exported for testability).
const CSV_HEADERS = ['date', 'startTime', 'workoutType', 'className', 'exercise', 'modality',
  'setIndex', 'reps', 'weight', 'weightUnit', 'distance', 'distUnit', 'seconds', 'resistance', 'height', 'heightUnit'];

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function workoutsToCSV(workouts) {
  const rows = [CSV_HEADERS.join(',')];
  for (const w of workouts) {
    const date = (w.date || '').slice(0, 10);
    for (const ex of (w.exercises || [])) {
      (ex.sets || []).forEach((s, i) => {
        rows.push([
          date, w.startTime, w.workoutType, w.className, ex.name, ex.modality || 'strength',
          i + 1, s.reps, s.weight, s.weightUnit, s.distance, s.distUnit, s.seconds, s.resistance, s.height, s.heightUnit,
        ].map(csvField).join(','));
      });
    }
  }
  return rows.join('\n');
}

export async function exportCSV() {
  // CSV is for analysis — tombstones would be noise. JSON export keeps them.
  const ws = (await db.workouts.toArray()).filter(isLive).sort((a, b) => new Date(a.date) - new Date(b.date));
  return workoutsToCSV(ws);
}

/* ===========================================================================
   SYNC PRIMITIVES — local bookkeeping only. The push engine lives in sync.js;
   these are the Dexie-level operations it composes.
=========================================================================== */

// meta: small key/value store for sync state (lastPushedAt, migration flags).
export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key);
  return row ? row.value : fallback;
}
export async function setMeta(key, value) {
  await db.meta.put({ key, value });
}

// Rows awaiting push. Matches on the numeric index — see the v4 schema note.
export async function getDirtyWorkouts() {
  return db.workouts.where('dirty').equals(1).toArray();
}

// Deletions made while signed out, awaiting a decision. Held back from push
// until the user says whether they meant to remove them from the account too.
export async function getOfflineDeletes() {
  const dirty = await db.workouts.where('dirty').equals(1).toArray();
  return dirty.filter((w) => w.deleted && w.offlineDelete);
}

// "Yes, remove them from my account" — demote to ordinary tombstones so the
// next push carries them up as deletions.
export async function confirmOfflineDeletes() {
  const rows = await getOfflineDeletes();
  if (rows.length) await db.workouts.bulkPut(rows.map((w) => ({ ...w, offlineDelete: 0 })));
  logEvent('info', 'offline_deletes_confirmed', `${rows.length} removed from account`);
  return rows.length;
}

// "No, keep them" — un-delete locally. Leaving them deleted here but alive in
// the cloud would be incoherent: the next pull would simply bring them back.
export async function restoreOfflineDeletes() {
  const rows = await getOfflineDeletes();
  if (rows.length) {
    await db.workouts.bulkPut(rows.map((w) => ({
      ...w, deleted: 0, offlineDelete: 0, dirty: 1, updatedAt: now(),
    })));
  }
  logEvent('info', 'offline_deletes_restored', `${rows.length} kept`);
  return rows.length;
}

// Which account this device's data belongs to. Local rows carry no user_id of
// their own, and a push stamps whoever is signed in — so without this, signing
// in on a device holding someone else's workouts would upload them under the
// new account. Set on first sync; checked on every sync thereafter.
export const getOwner = () => getMeta('ownerUserId');
export const setOwner = (userId) => setMeta('ownerUserId', userId);

// Destructive: wipes this device's data so a different account can start
// clean. Diagnostics logs are kept deliberately — they are the record of what
// happened, and are not user data.
export async function resetLocalData() {
  await db.transaction('rw', db.workouts, db.abbrevs, db.modalities, db.meta, async () => {
    await Promise.all([db.workouts.clear(), db.abbrevs.clear(), db.modalities.clear(), db.meta.clear()]);
  });
  logEvent('warn', 'local_data_reset', 'device data cleared for account switch');
}

// One-time migration: everything predating sync has no `dirty` property, so
// it is invisible to the index and would never upload. Idempotent — ids are
// UUIDs, so re-running it just re-uploads the same rows.
export async function markAllDirty() {
  const all = await db.workouts.toArray();
  if (all.length) await db.workouts.bulkPut(all.map((w) => ({ ...w, dirty: 1 })));
  return all.length;
}

// Called only after the server has confirmed the write. Tombstones are hard
// -deleted (their job is done once the deletion is recorded server-side);
// everything else just loses its dirty flag.
export async function afterPush(pushed) {
  const tombstones = pushed.filter((p) => p.deleted).map((p) => p.id);
  const survivors  = pushed.filter((p) => !p.deleted).map((p) => p.id);
  await db.transaction('rw', db.workouts, async () => {
    if (tombstones.length) await db.workouts.bulkDelete(tombstones);
    for (const id of survivors) {
      const w = await db.workouts.get(id);
      if (w) await db.workouts.put({ ...w, dirty: 0 });
    }
  });
}

/* ===========================================================================
   DIAGNOSTIC LOG — on-device, capped at 200 entries, never throws.
=========================================================================== */
const LOG_CAP = 200;
export async function logEvent(level, event, detail) {
  try {
    await db.logs.add({ id: uuid(), ts: now(), level, event, detail: detail ? String(detail).slice(0, 500) : null });
    const count = await db.logs.count();
    if (count > LOG_CAP) {
      const overflow = await db.logs.orderBy('ts').limit(count - LOG_CAP).toArray();
      await db.logs.bulkDelete(overflow.map((r) => r.id));
    }
  } catch { /* logging must never break the app */ }
}
export async function getLogs(limit = 50) {
  return db.logs.orderBy('ts').reverse().limit(limit).toArray();
}
export async function clearLogs() {
  await db.logs.clear();
}
