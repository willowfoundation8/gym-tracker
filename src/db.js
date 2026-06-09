// src/db.js — data layer backed by Dexie (IndexedDB).
// Same function contract as the artifact version, so App.jsx is unchanged
// except for where it imports these from. This is the storage swap.

import Dexie from 'dexie';

export const db = new Dexie('GymTrackerDB');
db.version(1).stores({
  workouts: 'id, date', // one row per workout; exercises embedded in the row
  abbrevs: 'key',       // learned shorthand: { key, name }
});

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const now = () => new Date().toISOString();
export const nameKey = (n) => (n || '').toLowerCase().trim().replace(/\s+/g, ' ');

// ---- Workouts ----
export async function getWorkouts() {
  return (await db.workouts.toArray()).sort((a, b) => new Date(b.date) - new Date(a.date));
}
export async function getWorkout(id) {
  return (await db.workouts.get(id)) || null;
}
export async function saveWorkout(w) {
  const id = w.id || uuid();
  const ts = now();
  const existing = await db.workouts.get(id);
  const record = {
    id,
    date: w.date || existing?.date || ts,
    className: w.className ?? existing?.className ?? null,
    notes: w.notes ?? existing?.notes ?? null,
    exercises: (w.exercises || []).map((ex, i) => ({
      id: ex.id || uuid(),
      name: ex.name,
      nameKey: nameKey(ex.name),
      sets: ex.sets || [],
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

// ---- Exercise rollups (for the picker + charts) ----
export async function getExerciseNames() {
  const all = await db.workouts.toArray();
  const seen = new Map();
  all.forEach((w) => (w.exercises || []).forEach((e) => { if (!seen.has(e.nameKey)) seen.set(e.nameKey, e.name); }));
  return [...seen.values()].sort();
}
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

// ---- Learned naming conventions ----
export async function getAbbrevMap() {
  const rows = await db.abbrevs.toArray();
  const map = {};
  rows.forEach((r) => { map[r.key] = r.name; });
  return map;
}
export async function learnAbbrev(entries) {
  const rows = entries.map(({ raw, name }) => ({ key: nameKey(raw), name })).filter((r) => r.key && r.name);
  if (rows.length) await db.abbrevs.bulkPut(rows);
}
