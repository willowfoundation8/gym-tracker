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

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const now  = () => new Date().toISOString();
export const nameKey = (n) => (n || '').toLowerCase().trim().replace(/\s+/g, ' ');

// ── Workouts ────────────────────────────────────────────────────────────────
export async function getWorkouts() {
  return (await db.workouts.toArray()).sort((a, b) => new Date(b.date) - new Date(a.date));
}
export async function getWorkout(id) {
  return (await db.workouts.get(id)) || null;
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
  };
  await db.workouts.put(record);
  return id;
}
export async function deleteWorkout(id) {
  await db.workouts.delete(id);
}

// ── Exercise rollups ─────────────────────────────────────────────────────────
// Names ordered by most-recent use (class programming repeats — recency beats
// the alphabet for the progress picker).
export async function getExerciseNames() {
  const all = (await db.workouts.toArray()).sort((a, b) => new Date(b.date) - new Date(a.date));
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
  const all = await db.workouts.toArray();
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
  const [workouts, abbrevs, modalities] = await Promise.all([
    db.workouts.toArray(), db.abbrevs.toArray(), db.modalities.toArray(),
  ]);
  return { app: 'GymTracker', schemaVersion: 2, exportedAt: now(), workouts, abbrevs, modalities };
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
  const ws = (await db.workouts.toArray()).sort((a, b) => new Date(a.date) - new Date(b.date));
  return workoutsToCSV(ws);
}
