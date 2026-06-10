// src/App.jsx — deployed version. Storage comes from ./db (Dexie); AI calls go
// through your Cloudflare Worker proxy (/api/vision, /api/expand) so your
// Anthropic key stays server-side.

import { useState, useEffect, useRef } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ScatterChart, Scatter, ZAxis,
} from 'recharts';
import {
  getWorkouts, getWorkout, saveWorkout, deleteWorkout,
  getExerciseNames, getAbbrevMap, learnAbbrev, nameKey,
  getModalityMap, learnModality,
  exportAll, importAll, exportCSV,
} from './db';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

/* ===========================================================================
   MODALITY — seed dictionary + helpers
   Lookup order: seed dict → learned store → AI suggestion → 'strength'
=========================================================================== */
const MODALITIES = ['strength', 'bodyweight', 'distance', 'loaded_distance', 'duration', 'cardio'];

const MODALITY_LABELS = {
  strength:        '🏋 Strength',
  bodyweight:      '💪 Bodyweight',
  distance:        '📏 Distance',
  loaded_distance: '🛷 Loaded Carry',
  duration:        '⏱ Duration',
  cardio:          '🚣 Cardio',
};

// Loaded-distance sub-type: sleds log TOTAL weight, carries log PER-HAND weight.
// Display-only — drives the hint text and input placeholder, never the metric.
const SLED_KEYWORDS = ['sled', 'prowler'];
function isSledType(name) {
  const k = (name || '').toLowerCase();
  return SLED_KEYWORDS.some((w) => k.includes(w));
}

// Canonical exercise name (post-expansion, lower-trimmed) → modality
const MODALITY_SEED = {
  // ── Distance (unloaded) ─────────────────────────────────────────────────────
  'sprint':                'distance',
  'run':                   'distance',
  'treadmill run':         'distance',
  'treadmill sprint':      'distance',
  // ── Loaded distance (weight × distance) ─────────────────────────────────────
  'sled push':             'loaded_distance',
  'sled pull':             'loaded_distance',
  'prowler push':          'loaded_distance',
  'prowler pull':          'loaded_distance',
  'farmers carry':         'loaded_distance',
  'farmers walk':          'loaded_distance',
  'farmers hold':          'loaded_distance',
  'waiters walk':          'loaded_distance',
  'waiter carry':          'loaded_distance',
  'suitcase carry':        'loaded_distance',
  'suitcase walk':         'loaded_distance',
  'sandbag carry':         'loaded_distance',
  'dumbbell walk':         'loaded_distance',
  'db walk':               'loaded_distance',
  'kettlebell walk':       'loaded_distance',
  'kb walk':               'loaded_distance',
  'plate carry':           'loaded_distance',
  'plate walk':            'loaded_distance',
  'overhead carry':        'loaded_distance',
  'yoke walk':             'loaded_distance',
  // ── Duration ──────────────────────────────────────────────────────────────
  'plank':                 'duration',
  'side plank':            'duration',
  'wall sit':              'duration',
  'dead hang':             'duration',
  'l-sit':                 'duration',
  'hollow hold':           'duration',
  'arch hold':             'duration',
  'static lunge hold':     'duration',
  'isometric squat hold':  'duration',
  // ── Bodyweight ────────────────────────────────────────────────────────────
  'push-up':               'bodyweight',
  'push up':               'bodyweight',
  'pull-up':               'bodyweight',
  'pull up':               'bodyweight',
  'chin-up':               'bodyweight',
  'chin up':               'bodyweight',
  'dip':                   'bodyweight',
  'burpee':                'bodyweight',
  'box jump':              'bodyweight',
  'jump squat':            'bodyweight',
  'tuck jump':             'bodyweight',
  'mountain climber':      'bodyweight',
  'sit-up':                'bodyweight',
  'sit up':                'bodyweight',
  'v-up':                  'bodyweight',
  'v up':                  'bodyweight',
  'jumping jack':          'bodyweight',
  'broad jump':            'bodyweight',
  'lateral bound':         'bodyweight',
  'skater jump':           'bodyweight',
  'step up':               'bodyweight',
  'bodyweight squat':      'bodyweight',
  'air squat':             'bodyweight',
  'inchworm':              'bodyweight',
  'bear crawl':            'bodyweight',
  'crab walk':             'bodyweight',
  // ── Cardio (machine-based) ────────────────────────────────────────────────
  'row':                   'cardio',
  'rowing':                'cardio',
  'ski erg':               'cardio',
  'skierg':                'cardio',
  'assault bike':          'cardio',
  'echo bike':             'cardio',
  'air bike':              'cardio',
  'concept2 row':          'cardio',
  'c2 row':                'cardio',
  'bike erg':              'cardio',
  'rower':                 'cardio',
  'cycle':                 'cardio',
  'spin bike':             'cardio',
};

function seedModality(canonicalName) {
  return MODALITY_SEED[nameKey(canonicalName)] || null;
}

function nextModality(current) {
  const i = MODALITIES.indexOf(current);
  return MODALITIES[(i + 1) % MODALITIES.length];
}

// Default empty set shape per modality
function emptySet(modality, ref) {
  const unit = ref?.weightUnit || 'kg';
  const distUnit = ref?.distUnit || 'm';
  const id = uid();
  switch (modality) {
    case 'bodyweight':      return { id, reps: null, weight: null, weightUnit: unit };
    case 'distance':        return { id, distance: null, distUnit };
    case 'loaded_distance': return { id, weight: null, weightUnit: unit, distance: null, distUnit };
    case 'duration':        return { id, seconds: null };
    case 'cardio':          return { id, distance: null, distUnit, seconds: null, resistance: 5 };
    default:                return { id, reps: null, weight: null, weightUnit: unit };  // strength
  }
}

/* ===========================================================================
   WORKOUT TYPES
=========================================================================== */
const WORKOUT_TYPES = ['general', 'strength', 'hiit', 'cardio', 'warmup', 'recovery'];
const WORKOUT_TYPE_LABELS = {
  general:   '⚡ General',
  strength:  '🏋 Strength',
  hiit:      '🔥 HIIT',
  cardio:    '🚴 Cardio',
  warmup:    '🌅 Warmup',
  recovery:  '🧘 Recovery',
};

/* ===========================================================================
   IMAGE + VISION
=========================================================================== */
async function fileToImage(file, maxDim = 1024) {
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  let { width, height } = img;
  if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
  else if (height >= width && height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  const out = canvas.toDataURL('image/jpeg', 0.8);
  return { preview: out, base64: out.split(',')[1] };
}

async function extractExercises(base64) {
  const prompt =
    'You are reading a gym workout board from a photo. Extract the list of exercises.\n\n' +
    'CRITICAL RULE — separate the PRESCRIPTION (how much to do) from the NAME (the movement itself):\n' +
    '- "name" must contain ONLY the canonical movement. NEVER put rep counts, set counts, distances, durations, or box heights in the name.\n' +
    '- Movement QUALIFIERS are part of the name and MUST be kept: "Single Arm", "Single Leg", "Double Under", "1-Arm", "Bulgarian", etc. They describe HOW the movement is done, not how much.\n' +
    '- You MAY keep shorthand/abbreviations in the name (e.g. "DB", "BB", "Medball") — those are expanded in a later step. Only strip the prescription numbers.\n' +
    '- Route every prescription number into its OWN field based on what it measures.\n\n' +
    'BLOCK PRESCRIPTIONS — set/round counts often appear as a HEADER above a group of exercises:\n' +
    '- A header like "3 Sets", "5 Sets", "4 Rounds", or "2 Rounds (14 each)" applies to EVERY exercise listed below it, until the next header or section. Set suggestedSets on each of those exercises.\n' +
    '- "Rounds" means the same as sets. "(14 each)" means suggestedReps 14 for every exercise in that block.\n' +
    '- For a rep RANGE like "12-15", use the LOWER bound (suggestedReps: 12).\n' +
    '- A per-set rep scheme like "5-5-4-4-3" means 5 sets with DIFFERENT reps each: use suggestedRepsPerSet [5,5,4,4,3] instead of suggestedSets/suggestedReps.\n\n' +
    'Examples:\n' +
    '- "28x Medball Step Over" -> {"name":"Medball Step Over","suggestedReps":28,"modality":"bodyweight"}\n' +
    '- "Single Arm DB Row" -> {"name":"Single Arm DB Row","modality":"strength"} (no numbers; "Single" stays)\n' +
    '- "Box Jump 24\"" -> {"name":"Box Jump","suggestedHeight":24,"suggestedHeightUnit":"in","modality":"bodyweight"}\n' +
    '- "5km Run" -> {"name":"Run","suggestedDistance":5,"suggestedDistUnit":"km","modality":"distance"}\n' +
    '- "500m Row" -> {"name":"Row","suggestedDistance":500,"suggestedDistUnit":"m","modality":"cardio"}\n' +
    '- "30s Plank" -> {"name":"Plank","suggestedSeconds":30,"modality":"duration"}\n' +
    '- "3x10 Squat" -> {"name":"Squat","suggestedSets":3,"suggestedReps":10,"modality":"strength"}\n' +
    '- Board section "3 Sets" followed by "DB Sumo Squat 12-15", "Add Clamps x 12-15 ES", "DB Calf Raises x 15-20" -> THREE items, each inheriting the header: [{"name":"DB Sumo Squat","suggestedSets":3,"suggestedReps":12,"modality":"strength"},{"name":"Add Clamps","suggestedSets":3,"suggestedReps":12,"modality":"bodyweight"},{"name":"DB Calf Raises","suggestedSets":3,"suggestedReps":15,"modality":"strength"}]\n' +
    '- "5 Sets" followed by "BB Back Squat 5-5-4-4-3" -> {"name":"BB Back Squat","suggestedRepsPerSet":[5,5,4,4,3],"modality":"strength"}\n' +
    '- "Sled Push 100kg x 20m" -> {"name":"Sled Push","suggestedWeight":100,"suggestedWeightUnit":"kg","suggestedDistance":20,"suggestedDistUnit":"m","modality":"loaded_distance"}\n' +
    '- "Farmers Carry 24kg / 40m" -> {"name":"Farmers Carry","suggestedWeight":24,"suggestedWeightUnit":"kg","suggestedDistance":40,"suggestedDistUnit":"m","modality":"loaded_distance"}\n\n' +
    'Modality: "strength" (weighted reps), "bodyweight" (reps, no load), "distance" (unloaded run/sprint), "loaded_distance" (sled push/pull, prowler, farmers/waiters/suitcase carry, weighted walks — weight AND distance), "duration" (plank, holds), "cardio" (rower, ski erg, bike). Default "strength" if unsure.\n\n' +
    'Respond with ONLY a JSON array, no prose, no markdown fences. Each item:\n' +
    '{"name":string,"suggestedSets":number|null,"suggestedReps":number|null,"suggestedRepsPerSet":number[]|null,"suggestedWeight":number|null,"suggestedWeightUnit":"kg"|"lb"|null,"suggestedDistance":number|null,"suggestedDistUnit":"m"|"km"|null,"suggestedSeconds":number|null,"suggestedHeight":number|null,"suggestedHeightUnit":"in"|"cm"|null,"modality":string}\n' +
    'Use null for anything not shown. Preserve board order.';
  const res = await fetch('/api/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
      { type: 'text', text: prompt },
    ] }] }),
  });
  if (!res.ok) throw new Error('Vision request failed: ' + res.status);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const arr = JSON.parse(clean);
  return arr.map((x) => ({
    raw:                 stripPrescription((x.name || 'Exercise').trim()),
    suggestedSets:       x.suggestedSets ?? null,
    suggestedReps:       x.suggestedReps ?? null,
    suggestedRepsPerSet: (Array.isArray(x.suggestedRepsPerSet) && x.suggestedRepsPerSet.some((n) => typeof n === 'number' && n > 0))
                           ? x.suggestedRepsPerSet.filter((n) => typeof n === 'number' && n > 0)
                           : null,
    suggestedWeight:     x.suggestedWeight ?? null,
    suggestedWeightUnit: (x.suggestedWeightUnit === 'lb' || x.suggestedWeightUnit === 'kg') ? x.suggestedWeightUnit : null,
    suggestedDistance:   x.suggestedDistance ?? null,
    suggestedDistUnit:   (x.suggestedDistUnit === 'km' || x.suggestedDistUnit === 'm') ? x.suggestedDistUnit : null,
    suggestedSeconds:    x.suggestedSeconds ?? null,
    suggestedHeight:     x.suggestedHeight ?? null,
    suggestedHeightUnit: (x.suggestedHeightUnit === 'cm' || x.suggestedHeightUnit === 'in') ? x.suggestedHeightUnit : null,
    aiModality:          MODALITIES.includes(x.modality) ? x.modality : 'strength',
  }));
}

// Safety net: strip a LEADING count token (e.g. "28x", "14 × ", "3x") that the
// model may have left in the name. Narrow by design — only matches <number>
// followed by x/×, so it never touches qualifiers ("Single Arm"), bare numbers
// in a name ("180 Jump"), distances ("5km Run" has no x), or trailing heights.
function stripPrescription(name) {
  return name.replace(/^\s*\d+\s*[x×]\s*/i, '').trim() || name;
}

async function expandViaAI(rawList) {
  const prompt =
    'These are exercise names written in shorthand on a gym workout board. ' +
    'Expand each to its full, standard exercise name (e.g. "DB SA Row" -> "Dumbbell Single Arm Row", "BB OHP" -> "Barbell Overhead Press"). ' +
    'IMPORTANT: strip any leftover prescription from the name — leading rep/set counts ("28x", "3x"), distances ("5km"), or durations ("30s"). Return ONLY the clean movement name. KEEP qualifiers like "Single Arm", "Single Leg", "Double Under". ' +
    'Keep names concise and standard. Respond with ONLY a JSON object mapping each EXACT input string to its expanded name - no prose, no markdown fences.\n\nInputs: ' +
    JSON.stringify(rawList);
  const res = await fetch('/api/expand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error('Expand request failed: ' + res.status);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

async function resolveNames(rawList) {
  const map = await getAbbrevMap();
  const unknown = rawList.filter((raw) => !map[nameKey(raw)]);
  let sugByKey = {};
  if (unknown.length) {
    try {
      const suggestions = await expandViaAI([...new Set(unknown)]);
      Object.entries(suggestions || {}).forEach(([k, v]) => { sugByKey[nameKey(k)] = v; });
    } catch { sugByKey = {}; }
  }
  return rawList.map((raw) => {
    const key = nameKey(raw);
    if (map[key]) return { name: map[key], original: raw, status: 'remembered' };
    if (sugByKey[key]) return { name: sugByKey[key], original: raw, status: 'suggested' };
    return { name: raw, original: raw, status: 'unknown' };
  });
}

/* ===========================================================================
   SHARED HELPERS
=========================================================================== */
// Canonical units for ALL metrics: kg and metres. Logged values keep their
// chosen unit in storage; conversion happens once, at the compute boundary.
const LB_TO_KG = 0.45359237;
const toKg     = (w, unit) => (unit === 'lb' ? w * LB_TO_KG : w);
const toMeters = (d, unit) => (unit === 'km' ? d * 1000 : d);

// "5000" → "5 km", "750" → "750 m" — display-only
function fmtDist(m) {
  if (m === null || m === undefined) return '—';
  return m >= 1000 ? `${(m / 1000) % 1 === 0 ? m / 1000 : (m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

// integer seconds → "m:ss" string for inputs (shared by duration + cardio rows)
function secToInput(sec) {
  if (!sec && sec !== 0) return '';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ===========================================================================
   PROGRESS METRICS
=========================================================================== */
function epley(weight, reps) {
  if (!weight || !reps || weight <= 0 || reps <= 0) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30));
}

// mm:ss display from total seconds
function fmtSeconds(s) {
  if (!s && s !== 0) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Parse "mm:ss" or plain seconds string → integer seconds
function parseSeconds(v) {
  if (!v && v !== 0) return null;
  const str = String(v).trim();
  if (str.includes(':')) {
    const [m, s] = str.split(':').map(Number);
    return (m || 0) * 60 + (s || 0);
  }
  const n = Number(str);
  return isNaN(n) ? null : n;
}

function computeProgressData(workouts, exerciseName) {
  const key = nameKey(exerciseName);

  // Pass 1: collect matching (workout, exercise) pairs so we can decide
  // whether the date range spans multiple years (labels then include 'yy).
  const matches = [];
  for (const w of workouts) {
    const ex = w.exercises.find((e) => nameKey(e.name) === key);
    if (ex) matches.push({ w, ex });
  }
  const years = new Set(matches.map(({ w }) => new Date(w.date).getFullYear()));
  const multiYear = years.size > 1;
  const fmtLabel = (date) => {
    const d = new Date(date);
    const base = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return multiYear ? `${base} '${String(d.getFullYear()).slice(2)}` : base;
  };

  const sessions = [];
  for (const { w, ex } of matches) {
    const modality = ex.modality || 'strength';
    const sets = ex.sets || [];
    const label = fmtLabel(w.date);
    const base = { date: w.date, label, modality };

    if (modality === 'strength') {
      // Normalise lb → kg before any math so mixed-unit sessions compare correctly
      const valid = sets.filter((s) => s.weight > 0 && s.reps > 0)
        .map((s) => ({ ...s, kg: toKg(s.weight, s.weightUnit) }));
      if (!valid.length) continue;
      const bestE1rm  = valid.reduce((b, s) => Math.max(b, epley(s.kg, s.reps) || 0), 0);
      const volume    = valid.reduce((sum, s) => sum + s.kg * s.reps, 0);
      const topWeight = Math.max(...valid.map((s) => s.kg));
      const totalReps = valid.reduce((sum, s) => sum + s.reps, 0);
      sessions.push({
        ...base,
        e1rm: Math.round(bestE1rm) || null,
        volume: Math.round(volume),
        topWeight: Math.round(topWeight * 10) / 10, totalReps,
        totalSets: valid.length,
        scatterSets: valid.map((s) => ({ date: w.date, label, mod: 'strength', weight: Math.round(s.kg * 10) / 10, reps: s.reps, z: s.reps })),
      });

    } else if (modality === 'bodyweight') {
      const valid = sets.filter((s) => s.reps > 0);
      if (!valid.length) continue;
      const maxReps   = Math.max(...valid.map((s) => s.reps));
      const totalReps = valid.reduce((sum, s) => sum + s.reps, 0);
      sessions.push({ ...base, maxReps, totalReps, totalSets: valid.length,
        scatterSets: valid.map((s) => ({ date: w.date, label, mod: 'bodyweight', weight: s.reps, reps: s.reps, z: s.reps })) });

    } else if (modality === 'distance') {
      // Normalise km → m so a 5km run and an 800m run aggregate correctly
      const valid = sets.filter((s) => s.distance > 0)
        .map((s) => ({ ...s, m: toMeters(s.distance, s.distUnit) }));
      if (!valid.length) continue;
      const totalDist = valid.reduce((sum, s) => sum + s.m, 0);
      const bestDist  = Math.max(...valid.map((s) => s.m));
      sessions.push({ ...base, totalDist: Math.round(totalDist), bestDist: Math.round(bestDist), totalSets: valid.length,
        scatterSets: valid.map((s) => ({ date: w.date, label, mod: 'distance', weight: Math.round(s.m), unit: 'm', reps: 1, z: 20 })) });

    } else if (modality === 'loaded_distance') {
      // Work = load(kg) × distance(m). Rises if you push more weight OR further.
      const valid = sets.filter((s) => s.weight > 0 && s.distance > 0)
        .map((s) => ({ ...s, kg: toKg(s.weight, s.weightUnit), m: toMeters(s.distance, s.distUnit) }));
      if (!valid.length) continue;
      const bestWork  = valid.reduce((b, s) => Math.max(b, s.kg * s.m), 0);
      const topWeight = Math.max(...valid.map((s) => s.kg));
      const totalDist = valid.reduce((sum, s) => sum + s.m, 0);
      sessions.push({ ...base, work: Math.round(bestWork), topWeight: Math.round(topWeight * 10) / 10, totalDist: Math.round(totalDist), totalSets: valid.length,
        scatterSets: valid.map((s) => ({ date: w.date, label, mod: 'loaded_distance', weight: Math.round(s.kg * 10) / 10, dist: Math.round(s.m), unit: 'm', reps: s.m, z: Math.max(20, s.m) })) });

    } else if (modality === 'duration') {
      const valid = sets.filter((s) => s.seconds > 0);
      if (!valid.length) continue;
      const bestSeconds = Math.max(...valid.map((s) => s.seconds));
      const totalSeconds = valid.reduce((sum, s) => sum + s.seconds, 0);
      sessions.push({ ...base, bestSeconds, totalSeconds, totalSets: valid.length,
        scatterSets: valid.map((s) => ({ date: w.date, label, mod: 'duration', weight: s.seconds, reps: 1, z: 20 })) });

    } else if (modality === 'cardio') {
      // Effort score: (metres / time_s) × (1 + resistance / 20)
      const valid = sets.filter((s) => s.distance > 0 && s.seconds > 0)
        .map((s) => ({ ...s, m: toMeters(s.distance, s.distUnit) }));
      if (!valid.length) continue;
      const bestEffort = valid.reduce((best, s) => {
        const pace = s.m / s.seconds;
        const effort = pace * (1 + (s.resistance || 0) / 20);
        return effort > best ? effort : best;
      }, 0);
      const totalDist = valid.reduce((sum, s) => sum + s.m, 0);
      sessions.push({ ...base,
        effort: Math.round(bestEffort * 1000) / 1000,
        totalDist: Math.round(totalDist), totalSets: valid.length,
        scatterSets: valid.map((s) => ({
          date: w.date, label, mod: 'cardio',
          weight: Math.round(s.m), unit: 'm',
          reps: s.resistance || 0,
          z: Math.max(20, (s.resistance || 0) * 20),
        })),
      });
    }
  }

  sessions.sort((a, b) => new Date(a.date) - new Date(b.date));
  return sessions;
}

/* ===========================================================================
   CUSTOM TOOLTIPS
=========================================================================== */
function CombinedTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const mod = d.modality || 'strength';
  return (
    <div style={{ background: '#13151b', border: '1px solid #2a2e38', borderRadius: 8, padding: '10px 13px', fontSize: 12, lineHeight: 1.8 }}>
      <div style={{ color: '#d7ff32', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {mod === 'strength'   && <><div style={{ color: '#d7ff32'  }}>e1RM: <b>{d.e1rm} kg</b></div><div style={{ color: '#6b9fff' }}>Volume: <b>{d.volume} kg</b></div></>}
      {mod === 'bodyweight' && <><div style={{ color: '#d7ff32'  }}>Max reps: <b>{d.maxReps}</b></div><div style={{ color: '#6b9fff' }}>Total reps: <b>{d.totalReps}</b></div></>}
      {mod === 'distance'   && <><div style={{ color: '#d7ff32'  }}>Best set: <b>{fmtDist(d.bestDist)}</b></div><div style={{ color: '#6b9fff' }}>Total: <b>{fmtDist(d.totalDist)}</b></div></>}
      {mod === 'loaded_distance' && <><div style={{ color: '#d7ff32'  }}>Work: <b>{d.work} kg·m</b></div><div style={{ color: '#6b9fff' }}>Best load: <b>{d.topWeight} kg</b></div></>}
      {mod === 'duration'   && <><div style={{ color: '#d7ff32'  }}>Best hold: <b>{fmtSeconds(d.bestSeconds)}</b></div><div style={{ color: '#6b9fff' }}>Total: <b>{fmtSeconds(d.totalSeconds)}</b></div></>}
      {mod === 'cardio'     && <><div style={{ color: '#d7ff32'  }}>Effort score: <b>{d.effort}</b></div><div style={{ color: '#6b9fff' }}>Distance: <b>{fmtDist(d.totalDist)}</b></div></>}
      <div style={{ color: '#8b909c', marginTop: 4, borderTop: '1px solid #2a2e38', paddingTop: 4 }}>{d.totalSets} set{d.totalSets !== 1 ? 's' : ''}</div>
    </div>
  );
}

function ScatterTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const mod = d.mod || 'strength';
  return (
    <div style={{ background: '#13151b', border: '1px solid #2a2e38', borderRadius: 8, padding: '10px 13px', fontSize: 12, lineHeight: 1.8 }}>
      <div style={{ color: '#d7ff32', fontWeight: 600, marginBottom: 4 }}>{d.label}</div>
      {mod === 'strength'        && <><div style={{ color: '#e7e9ee' }}>{d.weight} kg × {d.reps} reps</div><div style={{ color: '#8b909c' }}>e1RM ≈ {epley(d.weight, d.reps)} kg</div></>}
      {mod === 'bodyweight'      && <div style={{ color: '#e7e9ee' }}>{d.reps} reps</div>}
      {mod === 'distance'        && <div style={{ color: '#e7e9ee' }}>{fmtDist(d.weight)}</div>}
      {mod === 'loaded_distance' && <div style={{ color: '#e7e9ee' }}>{d.weight} kg × {fmtDist(d.dist)}</div>}
      {mod === 'duration'        && <div style={{ color: '#e7e9ee' }}>{fmtSeconds(d.weight)}</div>}
      {mod === 'cardio'          && <div style={{ color: '#e7e9ee' }}>{fmtDist(d.weight)} · resist {d.reps}</div>}
    </div>
  );
}

/* ===========================================================================
   CHART METRIC CONFIG per modality
=========================================================================== */
const CHART_CONFIG = {
  strength:        { primary: 'e1rm',        primaryLabel: 'e1RM (kg)',    primaryUnit: 'kg', secondary: 'volume',       secondaryLabel: 'Volume (kg)',    secondaryUnit: 'kg', note: 'e1RM normalises any set to a "max effort" number — heavy singles and volume sets become comparable.' },
  bodyweight:      { primary: 'maxReps',     primaryLabel: 'Max reps',     primaryUnit: '',   secondary: 'totalReps',    secondaryLabel: 'Total reps',     secondaryUnit: '',   note: 'Max reps is the best single set. Total reps shows overall volume done that session.' },
  distance:        { primary: 'bestDist',    primaryLabel: 'Best set (m)', primaryUnit: 'm',  secondary: 'totalDist',    secondaryLabel: 'Total dist (m)', secondaryUnit: 'm',  note: 'Best set distance per session. Total shows cumulative distance covered.' },
  loaded_distance: { primary: 'work',        primaryLabel: 'Work (kg·m)',  primaryUnit: '',   secondary: 'topWeight',    secondaryLabel: 'Best load (kg)', secondaryUnit: 'kg', note: 'Work = load × distance. The load bar shows whether progression came from heavier weight or more distance.' },
  duration:        { primary: 'bestSeconds', primaryLabel: 'Best hold',    primaryUnit: '',   secondary: 'totalSeconds', secondaryLabel: 'Total (s)',      secondaryUnit: 's',  note: 'Best single hold duration per session.' },
  cardio:          { primary: 'effort',      primaryLabel: 'Effort score', primaryUnit: '',   secondary: 'totalDist',    secondaryLabel: 'Distance (m)',   secondaryUnit: 'm',  note: 'Effort = (distance ÷ time) × (1 + resistance ÷ 20). Rewards going harder at higher resistance.' },
};

/* ===========================================================================
   SET ROW COMPONENTS
=========================================================================== */
function SetRowStrength({ s, onUpdate, num, parseNum }) {
  return (
    <>
      <input style={S.setInput} type="number" inputMode="numeric"  placeholder="–" value={num(s.reps)}   onChange={(e) => onUpdate({ reps:   parseNum(e.target.value) })} />
      <input style={S.setInput} type="number" inputMode="decimal"  placeholder="–" value={num(s.weight)} onChange={(e) => onUpdate({ weight: parseNum(e.target.value) })} />
      <button style={S.unitBtn} onClick={() => onUpdate({ weightUnit: s.weightUnit === 'kg' ? 'lb' : 'kg' })}>{s.weightUnit || 'kg'}</button>
    </>
  );
}

function SetRowBodyweight({ s, onUpdate, num, parseNum }) {
  // When the board specified a box-jump-style height, the set carries a `height`
  // key. Show a height field (+ in/cm toggle) in place of the optional weight.
  const hasHeight = Object.prototype.hasOwnProperty.call(s, 'height');
  return (
    <>
      <input style={{ ...S.setInput, flex: 2 }} type="number" inputMode="numeric" placeholder="reps" value={num(s.reps)} onChange={(e) => onUpdate({ reps: parseNum(e.target.value) })} />
      {hasHeight ? (
        <>
          <input style={S.setInput} type="number" inputMode="decimal" placeholder="ht" value={num(s.height)} onChange={(e) => onUpdate({ height: parseNum(e.target.value) })} />
          <button style={S.unitBtn} onClick={() => onUpdate({ heightUnit: s.heightUnit === 'in' ? 'cm' : 'in' })}>{s.heightUnit || 'in'}</button>
        </>
      ) : (
        <>
          <input style={S.setInput} type="number" inputMode="decimal" placeholder="+wt" value={num(s.weight)} onChange={(e) => onUpdate({ weight: parseNum(e.target.value) })} />
          <button style={S.unitBtn} onClick={() => onUpdate({ weightUnit: s.weightUnit === 'kg' ? 'lb' : 'kg' })}>{s.weightUnit || 'kg'}</button>
        </>
      )}
    </>
  );
}

function SetRowDistance({ s, onUpdate, num, parseNum }) {
  return (
    <>
      <input style={{ ...S.setInput, flex: 2 }} type="number" inputMode="decimal" placeholder="dist" value={num(s.distance)} onChange={(e) => onUpdate({ distance: parseNum(e.target.value) })} />
      <button style={S.unitBtn} onClick={() => onUpdate({ distUnit: s.distUnit === 'm' ? 'km' : 'm' })}>{s.distUnit || 'm'}</button>
    </>
  );
}

function SetRowLoadedDistance({ s, onUpdate, num, parseNum, sled }) {
  // weight × distance. Placeholder hints total (sled) vs per-hand (carry).
  return (
    <>
      <input style={S.setInput} type="number" inputMode="decimal" placeholder={sled ? 'total' : '/hand'} value={num(s.weight)} onChange={(e) => onUpdate({ weight: parseNum(e.target.value) })} />
      <button style={S.unitBtn} onClick={() => onUpdate({ weightUnit: s.weightUnit === 'kg' ? 'lb' : 'kg' })}>{s.weightUnit || 'kg'}</button>
      <input style={S.setInput} type="number" inputMode="decimal" placeholder="dist" value={num(s.distance)} onChange={(e) => onUpdate({ distance: parseNum(e.target.value) })} />
      <button style={S.unitBtn} onClick={() => onUpdate({ distUnit: s.distUnit === 'm' ? 'km' : 'm' })}>{s.distUnit || 'm'}</button>
    </>
  );
}

function SetRowDuration({ s, onUpdate, num }) {
  // Store as integer seconds; display/edit as mm:ss
  const [raw, setRaw] = useState(secToInput(s.seconds));
  useEffect(() => { setRaw(secToInput(s.seconds)); }, [s.seconds]);
  return (
    <input
      style={{ ...S.setInput, flex: 2 }}
      type="text"
      inputMode="numeric"
      placeholder="mm:ss"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => { const sec = parseSeconds(raw); if (sec !== null) onUpdate({ seconds: sec }); }}
    />
  );
}

function SetRowCardio({ s, onUpdate, num, parseNum }) {
  const [rawTime, setRawTime] = useState(secToInput(s.seconds));
  useEffect(() => { setRawTime(secToInput(s.seconds)); }, [s.seconds]);
  const res = s.resistance ?? 5;
  return (
    <>
      <input style={S.setInput} type="number" inputMode="decimal" placeholder="dist" value={num(s.distance)} onChange={(e) => onUpdate({ distance: parseNum(e.target.value) })} />
      <button style={S.unitBtn} onClick={() => onUpdate({ distUnit: s.distUnit === 'm' ? 'km' : 'm' })}>{s.distUnit || 'm'}</button>
      <input
        style={S.setInput}
        type="text"
        inputMode="numeric"
        placeholder="mm:ss"
        value={rawTime}
        onChange={(e) => setRawTime(e.target.value)}
        onBlur={() => { const sec = parseSeconds(rawTime); if (sec !== null) onUpdate({ seconds: sec }); }}
      />
      {/* Resistance stepper */}
      <div style={S.stepper}>
        <button style={S.stepBtn} onClick={() => onUpdate({ resistance: Math.max(1, res - 1) })}>−</button>
        <span style={S.stepVal}>{res}</span>
        <button style={S.stepBtn} onClick={() => onUpdate({ resistance: Math.min(10, res + 1) })}>+</button>
      </div>
    </>
  );
}

/* Column header labels per modality */
const SET_HEADERS = {
  strength:        ['#', 'reps', 'weight', 'unit', ''],
  bodyweight:      ['#', 'reps', '+wt', 'unit', ''],
  distance:        ['#', 'distance', 'unit', ''],
  loaded_distance: ['#', 'weight', 'unit', 'dist', 'unit', ''],
  duration:        ['#', 'time (mm:ss)', ''],
  cardio:          ['#', 'dist', 'unit', 'time', 'resist', ''],
};

/* ===========================================================================
   MAIN APP
=========================================================================== */
const ACCENT = '#d7ff32';
const BLUE   = '#6b9fff';

export default function App() {
  const [screen, setScreen]     = useState('home');
  const [workouts, setWorkouts] = useState([]);
  const [names, setNames]       = useState([]);
  const [draft, setDraft]       = useState(null);
  const [preview, setPreview]   = useState(null);
  const [busy, setBusy]         = useState(false);
  const [visionErr, setVisionErr] = useState(null);
  const [chartName, setChartName] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [chartView, setChartView] = useState('combined');
  const [confirmId, setConfirmId] = useState(null);   // two-tap delete guard
  const [dataMsg, setDataMsg]     = useState(null);    // export/import feedback
  const fileRef   = useRef(null);
  const cameraRef = useRef(null);
  const importRef = useRef(null);

  async function refresh() {
    const ws = await getWorkouts();
    setWorkouts(ws);
    setNames(await getExerciseNames());
    if (chartName) setChartData(computeProgressData(ws, chartName));
  }
  useEffect(() => { refresh(); }, []);

  function openUpload() { setVisionErr(null); fileRef.current?.click(); }
  function openCamera() { setVisionErr(null); cameraRef.current?.click(); }

  async function onPhotoChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setVisionErr(null);
    try {
      const { preview, base64 } = await fileToImage(file);
      setPreview(preview);
      const read = await extractExercises(base64);
      const resolved = await resolveNames(read.map((r) => r.raw));
      // Load learned modality map once for all exercises
      const modalityMap = await getModalityMap();
      const exercises = resolved.map((r, i) => {
        // Modality lookup: seed → learned → AI → fallback
        const canonical = r.name;
        const modality =
          seedModality(canonical) ||
          modalityMap[nameKey(canonical)] ||
          read[i].aiModality ||
          'strength';
        const r0 = read[i];
        // A per-set rep scheme (e.g. 5-5-4-4-3) wins: it defines both the set
        // count and each set's reps. Otherwise fall back to sets × reps.
        const repsArr = (r0.suggestedRepsPerSet && r0.suggestedRepsPerSet.length) ? r0.suggestedRepsPerSet : null;
        const count = repsArr ? repsArr.length : (r0.suggestedSets ?? 1);
        const sets = Array.from({ length: Math.max(1, count) }, (_, k) => {
          const s = emptySet(modality);
          if (modality === 'strength') {
            s.reps = repsArr ? (repsArr[k] ?? null) : (r0.suggestedReps ?? null);
          } else if (modality === 'bodyweight') {
            s.reps = repsArr ? (repsArr[k] ?? null) : (r0.suggestedReps ?? null);
            // Box-jump-style height: only attach the key when the board specified one
            if (r0.suggestedHeight != null) {
              s.height = r0.suggestedHeight;
              s.heightUnit = r0.suggestedHeightUnit || 'in';
            }
          } else if (modality === 'distance') {
            s.distance = r0.suggestedDistance ?? null;
            s.distUnit = r0.suggestedDistUnit || 'm';
          } else if (modality === 'loaded_distance') {
            s.weight   = r0.suggestedWeight ?? null;
            s.weightUnit = r0.suggestedWeightUnit || 'kg';
            s.distance = r0.suggestedDistance ?? null;
            s.distUnit = r0.suggestedDistUnit || 'm';
          } else if (modality === 'duration') {
            s.seconds = r0.suggestedSeconds ?? null;
          } else if (modality === 'cardio') {
            s.distance = r0.suggestedDistance ?? null;
            s.distUnit = r0.suggestedDistUnit || 'm';
            s.seconds = r0.suggestedSeconds ?? null;
          }
          return s;
        });
        return { id: uid(), name: canonical, original: r.original, status: r.status, guessed: r.status !== 'remembered', modality, sets };
      });
      // Flag exercises the board listed more than once (kept separate by design —
      // e.g. paired stations that repeat — but worth a heads-up).
      const counts = {};
      exercises.forEach((ex) => { const k = nameKey(ex.name); counts[k] = (counts[k] || 0) + 1; });
      exercises.forEach((ex) => { const n = counts[nameKey(ex.name)]; if (n > 1) ex.dupCount = n; });
      setDraft({ className: null, date: todayStr(), startTime: null, duration: null, workoutType: 'general', exercises });
      setScreen('edit');
    } catch (err) {
      setVisionErr("Couldn't read the board automatically — you can enter it by hand.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function startManual() {
    setPreview(null);
    setDraft({ className: null, date: todayStr(), startTime: null, duration: null, workoutType: 'general',
      exercises: [{ id: uid(), name: '', modality: 'strength', sets: [emptySet('strength')] }] });
    setScreen('edit');
  }

  const setDraftField   = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateExercise  = (i, patch) => setDraft((d) => ({ ...d, exercises: d.exercises.map((ex, j) => j === i ? { ...ex, ...patch } : ex) }));
  const addExercise     = () => setDraft((d) => ({ ...d, exercises: [...d.exercises, { id: uid(), name: '', modality: 'strength', sets: [emptySet('strength')] }] }));
  const removeExercise  = (i) => setDraft((d) => ({ ...d, exercises: d.exercises.filter((_, j) => j !== i) }));
  const addSet          = (i) => updateExercise(i, { sets: [...draft.exercises[i].sets, emptySet(draft.exercises[i].modality, draft.exercises[i].sets.at(-1))] });
  const updateSet       = (i, si, patch) => updateExercise(i, { sets: draft.exercises[i].sets.map((s, k) => k === si ? { ...s, ...patch } : s) });
  const removeSet       = (i, si) => updateExercise(i, { sets: draft.exercises[i].sets.filter((_, k) => k !== si) });

  // Any meaningful logged/seeded value (defaults like units and resistance:5 don't count)
  const setHasData = (s) =>
    s.reps != null || s.weight != null || s.distance != null || s.seconds != null || s.height != null;

  function cycleModality(i) {
    const ex  = draft.exercises[i];
    if (ex.sets.some(setHasData) &&
        !window.confirm('Switching the exercise type clears its logged sets. Continue?')) {
      return;
    }
    const mod = nextModality(ex.modality);
    updateExercise(i, { modality: mod, sets: ex.sets.map(() => emptySet(mod)) });
  }

  async function save() {
    const cleaned = { ...draft, exercises: draft.exercises.filter((ex) => (ex.name || '').trim()) };
    if (!cleaned.exercises.length) { setScreen('home'); setDraft(null); return; }
    if (cleaned.date) {
      cleaned.date = new Date(cleaned.date + 'T12:00:00').toISOString();
    } else {
      cleaned.date = new Date().toISOString();
    }
    await learnAbbrev(cleaned.exercises
      .filter((e) => e.original && e.original !== e.name)
      .map((e) => ({ raw: e.original, name: (e.name || '').trim() })));
    // Learn the FINAL modality for every exercise — including 'strength' — so a
    // user correction overwrites a stale wrong entry in the learned store.
    await learnModality(cleaned.exercises
      .filter((e) => e.modality)
      .map((e) => ({ name: e.name, modality: e.modality })));
    await saveWorkout(cleaned);
    setDraft(null); setPreview(null);
    await refresh();
    setScreen('home');
  }

  async function openWorkout(id) {
    const w = await getWorkout(id);
    if (w) {
      const d = w.date ? new Date(w.date) : new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // Backfill ids for stable React keys on data saved before sets carried ids
      const exercises = (w.exercises || []).map((ex) => ({
        ...ex, id: ex.id || uid(),
        sets: (ex.sets || []).map((s) => (s.id ? s : { ...s, id: uid() })),
      }));
      setDraft({ ...w, date: dateStr, exercises });
      setPreview(null);
      setScreen('edit');
    }
  }
  async function remove(id) { await deleteWorkout(id); setConfirmId(null); await refresh(); }
  // First tap arms the delete; second tap (within 3s) performs it.
  function askRemove(ev, id) {
    ev.stopPropagation();
    if (confirmId === id) { remove(id); return; }
    setConfirmId(id);
    setTimeout(() => setConfirmId((cur) => (cur === id ? null : cur)), 3000);
  }

  async function openProgress() {
    const ws = await getWorkouts();
    setWorkouts(ws);
    const ns = await getExerciseNames();
    setNames(ns);
    const first = ns[0] || null;
    setChartName(first);
    setChartData(first ? computeProgressData(ws, first) : []);
    setScreen('progress');
  }
  function pickChart(n) { setChartName(n); setChartData(computeProgressData(workouts, n)); }

  // ── Data export / import (Phase 2) ──
  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function onExportJSON() {
    try {
      const data = await exportAll();
      downloadFile(`gym-tracker-backup-${todayStr()}.json`, JSON.stringify(data, null, 2), 'application/json');
      setDataMsg(`Backup saved — ${data.workouts.length} workout${data.workouts.length === 1 ? '' : 's'}.`);
    } catch (e) { setDataMsg('Export failed: ' + e.message); }
  }
  async function onExportCSV() {
    try {
      const csv = await exportCSV();
      downloadFile(`gym-tracker-export-${todayStr()}.csv`, csv, 'text/csv');
      setDataMsg('CSV exported.');
    } catch (e) { setDataMsg('Export failed: ' + e.message); }
  }
  async function onImportChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const counts = await importAll(JSON.parse(text));
      setDataMsg(`Restored ${counts.workouts} workouts, ${counts.abbrevs} names, ${counts.modalities} types.`);
      await refresh();
    } catch (err) {
      setDataMsg('Import failed: ' + (err.message || 'not a valid backup file'));
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  }

  const num      = (v) => (v === null || v === undefined || v === '' ? '' : v);
  const parseNum = (v) => (v === '' ? null : Number(v));
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const scatterPoints  = chartData.flatMap((s) => s.scatterSets || []);
  const modality       = chartData[0]?.modality || 'strength';
  const cfg            = CHART_CONFIG[modality] || CHART_CONFIG.strength;
  const primaryBest    = chartData.length ? Math.max(...chartData.map((d) => d[cfg.primary] || 0)) : null;
  const secondaryBest  = chartData.length ? Math.max(...chartData.map((d) => d[cfg.secondary] || 0)) : null;
  const totalSessions  = chartData.length;

  // Stat-box display: durations as m:ss, big numbers (work kg·m, long distances) as k
  const fmtStatPrimary = (v) => {
    if (v === null || v === undefined) return v;
    if (modality === 'duration') return fmtSeconds(v);
    return v >= 10000 ? `${(v / 1000).toFixed(1)}k` : v;
  };

  return (
    <div style={S.shell}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        input { font-family: inherit; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes rise { from { opacity:0; transform: translateY(6px);} to {opacity:1; transform:none;} }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-thumb { background:#2a2e38; border-radius:3px; }

        /* ── Responsive container ── */
        .gt-page { max-width: 540px; padding: 26px 18px 70px; }
        @media (min-width: 480px) { .gt-page { max-width: 680px; padding: 32px 28px 80px; } }
        @media (min-width: 768px) { .gt-page { max-width: 960px; padding: 44px 48px 100px; } }

        /* ── Fluid typography ── */
        .gt-h1  { font-size: clamp(34px, 8vw, 56px); }
        .gt-h2  { font-size: clamp(24px, 5vw, 38px); }
        .gt-sub { font-size: clamp(12px, 2vw, 15px); }

        /* ── Buttons scale up on desktop ── */
        @media (min-width: 768px) {
          .gt-cta   { font-size: 16px !important; padding: 18px !important; }
          .gt-ghost { font-size: 15px !important; padding: 16px !important; }
          .gt-row-name { font-size: 20px !important; }
        }

        /* ── Progress: side-by-side charts on landscape tablet / desktop ── */
        .gt-chart-grid   { display: flex; flex-direction: column; gap: 16px; }
        .gt-chart-panel  { flex: 1; min-width: 0; }
        .gt-chart-height { height: 260px; }
        .gt-toggle-wrap  { display: block; }
        @media (min-width: 480px) { .gt-chart-height { height: 300px; } }
        @media (min-width: 768px) {
          .gt-chart-grid   { flex-direction: row; align-items: flex-start; }
          .gt-chart-height { height: 380px; }
          .gt-toggle-wrap  { display: none; }
          .gt-chart-panel  { display: block !important; } /* both always visible on desktop */
        }

        /* ── Edit screen: two-col exercise grid on desktop ── */
        .gt-exercise-grid { display: contents; }
        @media (min-width: 768px) {
          .gt-exercise-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
          .gt-exercise-footer { grid-column: 1 / -1; }
        }

        /* ── Stat tiles ── */
        @media (min-width: 768px) {
          .gt-stat-val { font-size: 28px !important; }
          .gt-stat-lbl { font-size: 11px !important; letter-spacing: 2px !important; }
        }
      `}</style>

      <input ref={fileRef}   type="file" accept="image/*"                   onChange={onPhotoChosen} style={{ display: 'none' }} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onPhotoChosen} style={{ display: 'none' }} />
      <input ref={importRef} type="file" accept=".json,application/json" onChange={onImportChosen} style={{ display: 'none' }} />

      {/* ── HOME ── */}
      {screen === 'home' && (
        <div style={S.page} className="gt-page">
          <div style={S.kicker}>WORKOUT LOG</div>
          <h1 style={S.h1} className="gt-h1">GYM&nbsp;TRACKER</h1>
          <div style={S.sub} className="gt-sub">{workouts.length} session{workouts.length === 1 ? '' : 's'} · {names.length} exercise{names.length === 1 ? '' : 's'} tracked</div>
          <button style={S.cta} className="gt-cta" onClick={() => setScreen('capture')}>+ NEW WORKOUT</button>
          <button style={S.ghost} className="gt-ghost" onClick={openProgress}>VIEW PROGRESS</button>
          <div style={S.label}>HISTORY</div>
          {workouts.length === 0 ? (
            <div style={S.empty}>No workouts yet. Tap "New Workout", snap the board, and log your sets.</div>
          ) : workouts.map((w) => (
            <div key={w.id} style={S.row} onClick={() => openWorkout(w.id)}>
              <div style={{ flex: 1 }}>
                <div style={S.rowDate}>
                  {new Date(w.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  {w.startTime && <span style={{ marginLeft: 8, opacity: 0.7 }}>{w.startTime}</span>}
                  {w.workoutType && w.workoutType !== 'general' && (
                    <span style={{ marginLeft: 8, fontSize: 10, background: 'rgba(215,255,50,0.12)', color: ACCENT, borderRadius: 4, padding: '1px 5px' }}>
                      {WORKOUT_TYPE_LABELS[w.workoutType]?.split(' ')[1] || w.workoutType}
                    </span>
                  )}
                </div>
                <div style={S.rowName} className="gt-row-name">{w.className || `${w.exercises.length} exercise${w.exercises.length === 1 ? '' : 's'}`}</div>
                <div style={S.rowMeta}>
                  {w.exercises.slice(0, 3).map((e) => e.name).join(' · ')}{w.exercises.length > 3 ? ' …' : ''}
                  {w.duration ? <span style={{ marginLeft: 8 }}>{w.duration}min</span> : ''}
                </div>
              </div>
              <button
                style={confirmId === w.id ? { ...S.del, color: '#ff5a6e', fontWeight: 700 } : S.del}
                onClick={(ev) => askRemove(ev, w.id)}
              >{confirmId === w.id ? 'sure?' : '✕'}</button>
            </div>
          ))}

          <div style={S.label}>DATA</div>
          <div style={S.dataRow}>
            <button style={S.dataBtn} onClick={onExportJSON}>⬇ Backup</button>
            <button style={S.dataBtn} onClick={onExportCSV}>⬇ CSV</button>
            <button style={S.dataBtn} onClick={() => importRef.current?.click()}>⬆ Restore</button>
          </div>
          {dataMsg && <div style={S.dataMsg}>{dataMsg}</div>}
          <div style={S.dataNote}>Your data lives in this browser only. Back it up occasionally — clearing browser data wipes it.</div>
        </div>
      )}

      {/* ── CAPTURE ── */}
      {screen === 'capture' && (
        <div style={S.page} className="gt-page">
          <button style={S.back} onClick={() => setScreen('home')}>‹ back</button>
          <h2 style={S.h2} className="gt-h2">NEW WORKOUT</h2>
          <div style={S.sub} className="gt-sub">Snap the board and let AI read the exercises — or enter them yourself.</div>
          {preview && <img src={preview} alt="board" style={S.previewImg} />}
          {busy ? (
            <div style={S.loading}><div style={S.spinner} /> Reading the board…</div>
          ) : (
            <>
              <button style={S.cta} className="gt-cta" onClick={openUpload}>🖼 UPLOAD EXISTING PHOTO</button>
              <button style={S.ghost} className="gt-ghost" onClick={openCamera}>📷 TAKE A PHOTO</button>
              <button style={S.ghost} className="gt-ghost" onClick={startManual}>ENTER MANUALLY</button>
            </>
          )}
          {visionErr && <div style={S.errBox}>{visionErr} <button style={S.inlineBtn} onClick={startManual}>Enter manually →</button></div>}
        </div>
      )}

      {/* ── EDIT ── */}
      {screen === 'edit' && draft && (
        <div style={S.page} className="gt-page">
          <button style={S.back} onClick={() => { setScreen('home'); setDraft(null); }}>‹ cancel</button>
          <h2 style={S.h2} className="gt-h2">{draft.id ? 'EDIT WORKOUT' : 'LOG WORKOUT'}</h2>
          {preview && <img src={preview} alt="board" style={S.previewThumb} />}

          {/* Date + time row */}
          <div style={S.rowInputs}>
            <input style={{ ...S.input, ...S.dateInput, flex: 1, marginBottom: 0 }}
              type="date" value={draft.date || ''} onChange={(e) => setDraftField({ date: e.target.value })} />
            <input style={{ ...S.input, ...S.dateInput, width: 110, marginBottom: 0 }}
              type="time" value={draft.startTime || ''} onChange={(e) => setDraftField({ startTime: e.target.value })}
              placeholder="start" />
          </div>

          {/* Duration + class name row */}
          <div style={{ ...S.rowInputs, marginTop: 10 }}>
            <input style={{ ...S.input, width: 90, marginBottom: 0 }}
              type="number" inputMode="numeric" placeholder="mins" value={num(draft.duration)}
              onChange={(e) => setDraftField({ duration: parseNum(e.target.value) })} />
            <input style={{ ...S.input, flex: 1, marginBottom: 0 }}
              placeholder="Class / workout name (optional)" value={num(draft.className)}
              onChange={(e) => setDraftField({ className: e.target.value })} />
          </div>

          {/* Workout type pills */}
          <div style={{ ...S.chips, marginTop: 12, marginBottom: 16 }}>
            {WORKOUT_TYPES.map((t) => (
              <button key={t}
                onClick={() => setDraftField({ workoutType: t })}
                style={{ ...S.chip, ...(draft.workoutType === t ? S.chipOn : {}) }}>
                {WORKOUT_TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          {draft.exercises.some((e) => e.guessed) && (
            <div style={S.guessBanner}>⚡ Shorthand names were auto-suggested. Tap a highlighted name to fix it, or ✓ to confirm. Once saved, they're remembered.</div>
          )}

          <div className="gt-exercise-grid">
          {draft.exercises.map((ex, i) => {
            const mod = ex.modality || 'strength';
            let headers = SET_HEADERS[mod] || SET_HEADERS.strength;
            // Bodyweight with a board-specified height shows ht instead of +wt
            if (mod === 'bodyweight' && ex.sets.some((s) => Object.prototype.hasOwnProperty.call(s, 'height'))) {
              headers = ['#', 'reps', 'ht', 'unit', ''];
            }
            return (
              <div key={ex.id || i} style={S.card}>
                <div style={S.cardHead}>
                  <input style={{ ...S.exName, ...(ex.guessed ? S.exNameGuess : {}) }}
                    placeholder="Exercise name" value={ex.name}
                    onChange={(e) => updateExercise(i, { name: e.target.value, guessed: false, status: 'confirmed' })} />
                  {ex.guessed && <button style={S.confirmBtn} onClick={() => updateExercise(i, { guessed: false, status: 'confirmed' })}>✓</button>}
                  <button style={S.del} onClick={() => removeExercise(i)}>✕</button>
                </div>

                {/* Modality badge — tap to cycle */}
                <button style={{ ...S.modalityBadge, ...S.modalityColors[mod] }} onClick={() => cycleModality(i)}>
                  {MODALITY_LABELS[mod]} ↻
                </button>

                {ex.guessed && ex.status === 'unknown'    && <div style={S.guessTag}>⚠ couldn't auto-name "{ex.original}" — please check</div>}
                {ex.guessed && ex.status !== 'unknown'    && <div style={S.guessTag}>⚡ auto-suggested from "{ex.original}" — confirm ✓ or edit</div>}
                {!ex.guessed && ex.status === 'remembered'&& <div style={S.rememberTag}>✓ remembered "{ex.original}" from before</div>}
                {mod === 'loaded_distance' && (
                  <div style={S.hintTag}>💡 {isSledType(ex.name) ? 'log total sled weight' : 'log weight per hand'}</div>
                )}
                {ex.dupCount > 1 && (
                  <div style={S.hintTag}>↻ appears {ex.dupCount}× on this board — each is logged separately</div>
                )}

                {/* Set headers */}
                <div style={S.setHeader}>
                  {headers.map((h, hi) => (
                    <span key={hi} style={hi === 0 ? { width: 28 } : hi === headers.length - 1 ? { width: 28 } : S.col}>{h}</span>
                  ))}
                </div>

                {ex.sets.map((s, si) => (
                  <div key={s.id || si} style={S.setRow}>
                    <span style={S.setNo}>{si + 1}</span>
                    {mod === 'strength'   && <SetRowStrength   s={s} onUpdate={(p) => updateSet(i, si, p)} num={num} parseNum={parseNum} />}
                    {mod === 'bodyweight' && <SetRowBodyweight s={s} onUpdate={(p) => updateSet(i, si, p)} num={num} parseNum={parseNum} />}
                    {mod === 'distance'   && <SetRowDistance   s={s} onUpdate={(p) => updateSet(i, si, p)} num={num} parseNum={parseNum} />}
                    {mod === 'loaded_distance' && <SetRowLoadedDistance s={s} onUpdate={(p) => updateSet(i, si, p)} num={num} parseNum={parseNum} sled={isSledType(ex.name)} />}
                    {mod === 'duration'   && <SetRowDuration   s={s} onUpdate={(p) => updateSet(i, si, p)} num={num} />}
                    {mod === 'cardio'     && <SetRowCardio     s={s} onUpdate={(p) => updateSet(i, si, p)} num={num} parseNum={parseNum} />}
                    <button style={S.delSm} onClick={() => removeSet(i, si)}>✕</button>
                  </div>
                ))}
                <button style={S.addSet} onClick={() => addSet(i)}>+ add set</button>
              </div>
            );
          })}

          </div>{/* end gt-exercise-grid */}
          <div className="gt-exercise-footer">
            <button style={S.ghost} className="gt-ghost" onClick={addExercise}>+ ADD EXERCISE</button>
            <button style={S.cta} className="gt-cta" onClick={save}>SAVE WORKOUT</button>
          </div>
        </div>
      )}

      {/* ── PROGRESS ── */}
      {screen === 'progress' && (
        <div style={S.page} className="gt-page">
          <button style={S.back} onClick={() => setScreen('home')}>‹ back</button>
          <h2 style={S.h2} className="gt-h2">PROGRESS</h2>
          {names.length === 0 ? (
            <div style={S.empty}>Log a few workouts and your exercise trends will show up here.</div>
          ) : (
            <>
              <div style={S.chips}>
                {names.map((n) => (
                  <button key={n} onClick={() => pickChart(n)}
                    style={{ ...S.chip, ...(n === chartName ? S.chipOn : {}) }}>{n}</button>
                ))}
              </div>

              {chartData.length > 0 && (
                <div style={S.statRow}>
                  <div style={S.statBox}>
                    <div style={S.statVal} className="gt-stat-val">{fmtStatPrimary(primaryBest) ?? '—'}<span style={S.statUnit}>{cfg.primaryUnit}</span></div>
                    <div style={S.statLbl} className="gt-stat-lbl">{cfg.primaryLabel.toUpperCase()}</div>
                  </div>
                  <div style={S.statBox}>
                    <div style={S.statVal} className="gt-stat-val">{secondaryBest ?? '—'}<span style={S.statUnit}>{cfg.secondaryUnit}</span></div>
                    <div style={S.statLbl} className="gt-stat-lbl">{cfg.secondaryLabel.toUpperCase()}</div>
                  </div>
                  <div style={S.statBox}>
                    <div style={S.statVal} className="gt-stat-val">{totalSessions}</div>
                    <div style={S.statLbl} className="gt-stat-lbl">SESSIONS</div>
                  </div>
                </div>
              )}

              {/* Toggle visible on mobile/portrait only — hidden on desktop via CSS */}
              <div className="gt-toggle-wrap" style={S.toggle}>
                <button style={{ ...S.toggleBtn, ...(chartView === 'combined' ? S.toggleOn : {}) }} onClick={() => setChartView('combined')}>COMBINED</button>
                <button style={{ ...S.toggleBtn, ...(chartView === 'scatter'  ? S.toggleOn : {}) }} onClick={() => setChartView('scatter')}>SCATTER</button>
              </div>

              {chartData.length < 2 ? (
                <div style={S.empty}>Need at least two logged sessions of "{chartName}" to chart a trend.</div>
              ) : (
                <div className="gt-chart-grid">

                  {/* ── COMBINED — always rendered, hidden on mobile if toggle is scatter ── */}
                  <div className="gt-chart-panel" style={chartView !== 'combined' ? { display: 'none' } : {}}>
                    <div style={S.chartCaption}>
                      <span style={{ color: ACCENT }}>━</span> {cfg.primaryLabel} &nbsp;·&nbsp; <span style={{ color: BLUE }}>▪</span> {cfg.secondaryLabel}
                    </div>
                    <div className="gt-chart-height" style={{ marginTop: 6 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="#1d2027" strokeDasharray="3 3" />
                          <XAxis dataKey="label" tick={{ fill: '#8b909c', fontSize: 11 }} />
                          <YAxis yAxisId="primary"   orientation="left"  tick={{ fill: '#8b909c', fontSize: 10 }} width={38} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                          <YAxis yAxisId="secondary" orientation="right" tick={{ fill: BLUE,      fontSize: 10 }} width={42} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                          <Tooltip content={<CombinedTooltip />} />
                          <Bar  yAxisId="secondary" dataKey={cfg.secondary} fill={BLUE}   opacity={0.45} radius={[3,3,0,0]} />
                          <Line yAxisId="primary"   dataKey={cfg.primary}   stroke={ACCENT} strokeWidth={2.5} dot={{ fill: ACCENT, r: 3 }} connectNulls />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <div style={S.chartNote}>{cfg.note}</div>
                  </div>

                  {/* ── SCATTER — always rendered, hidden on mobile if toggle is combined ── */}
                  <div className="gt-chart-panel" style={chartView !== 'scatter' ? { display: 'none' } : {}}>
                    <div style={S.chartCaption}>
                      {modality === 'cardio'          ? 'Each dot = one set. Y = distance. Dot size = resistance.'
                     : modality === 'strength'        ? 'Each dot = one set. Y = weight. Dot size = rep count.'
                     : modality === 'loaded_distance' ? 'Each dot = one set. Y = load. Dot size = distance.'
                     : 'Each dot = one set. Y = primary metric over time.'}
                    </div>
                    <div className="gt-chart-height" style={{ marginTop: 6 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="#1d2027" strokeDasharray="3 3" />
                          <XAxis dataKey="label" type="category" allowDuplicatedCategory={false} tick={{ fill: '#8b909c', fontSize: 11 }} name="Date" />
                          <YAxis dataKey="weight" tick={{ fill: '#8b909c', fontSize: 11 }} width={38} name="Value" />
                          <ZAxis dataKey="z" range={[40, 300]} name="Size" />
                          <Tooltip content={<ScatterTooltip />} />
                          <Scatter data={scatterPoints} fill={ACCENT} fillOpacity={0.75} />
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                    <div style={S.chartNote}>
                      {modality === 'strength'   && 'Bigger dots = more reps. High small dot = heavy low-rep set. Low big dot = high-volume set.'}
                      {modality === 'bodyweight' && 'Each dot is one set. Y = rep count.'}
                      {modality === 'distance'   && 'Each dot is one set. Y = distance covered.'}
                      {modality === 'loaded_distance' && 'Each dot is one set. Y = load lifted. Bigger dot = longer distance carried.'}
                      {modality === 'duration'   && 'Each dot is one set. Y = hold duration in seconds.'}
                      {modality === 'cardio'     && 'Each dot is one set. Y = distance. Bigger dot = higher resistance.'}
                    </div>
                  </div>

                </div>
              )}
              <div style={S.note}>Next up (v1.1): personal records and streaks.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ===========================================================================
   STYLES
=========================================================================== */
const S = {
  shell:      { background: '#0c0d10', color: '#e7e9ee', minHeight: '100vh', fontFamily: "'IBM Plex Mono', ui-monospace, monospace" },
  page:       { maxWidth: 540, margin: '0 auto', padding: '26px 18px 70px', animation: 'rise .25s ease' },
  kicker:     { fontSize: 11, letterSpacing: 3, color: ACCENT, fontWeight: 500 },
  h1:         { fontFamily: "'Oswald', sans-serif", fontWeight: 700, lineHeight: 1, margin: '6px 0 8px', letterSpacing: 1 },
  h2:         { fontFamily: "'Oswald', sans-serif", fontWeight: 700, margin: '4px 0 6px', letterSpacing: 1 },
  sub:        { color: '#8b909c', marginBottom: 22, lineHeight: 1.5 },
  cta:        { width: '100%', padding: '15px', background: ACCENT, color: '#0c0d10', border: 'none', borderRadius: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: 1, cursor: 'pointer', marginBottom: 10 },
  ghost:      { width: '100%', padding: '13px', background: 'transparent', color: '#cfd3dc', border: '1px solid #2a2e38', borderRadius: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 500, fontSize: 14, letterSpacing: 1, cursor: 'pointer', marginBottom: 10 },
  label:      { fontSize: 11, letterSpacing: 2, color: '#8b909c', margin: '24px 0 10px' },
  empty:      { padding: '22px 16px', border: '1px dashed #2a2e38', borderRadius: 10, color: '#6b7080', fontSize: 13, textAlign: 'center', lineHeight: 1.6 },
  row:        { display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', background: '#13151b', border: '1px solid #1d2027', borderRadius: 10, marginBottom: 8, cursor: 'pointer' },
  rowDate:    { fontSize: 11, color: ACCENT, marginBottom: 3, letterSpacing: 1 },
  rowName:    { fontFamily: "'Oswald', sans-serif", fontWeight: 500, fontSize: 17 },
  rowMeta:    { fontSize: 11, color: '#7b8090', marginTop: 3 },
  back:       { background: 'none', border: 'none', color: '#8b909c', fontSize: 13, padding: '4px 0', marginBottom: 8, cursor: 'pointer', fontFamily: 'inherit' },
  previewImg: { width: '100%', borderRadius: 12, border: '1px solid #1d2027', margin: '6px 0 16px' },
  previewThumb: { width: '100%', maxHeight: 150, objectFit: 'cover', borderRadius: 10, border: '1px solid #1d2027', margin: '6px 0 14px' },
  loading:    { display: 'flex', alignItems: 'center', gap: 12, padding: '20px 4px', color: '#cfd3dc', fontSize: 14 },
  spinner:    { width: 22, height: 22, border: '3px solid #2a2e38', borderTopColor: ACCENT, borderRadius: '50%', animation: 'spin .8s linear infinite' },
  errBox:     { marginTop: 12, padding: 12, background: '#1a1115', border: '1px solid #5a2330', borderRadius: 10, color: '#ff9aa6', fontSize: 12.5, lineHeight: 1.5 },
  inlineBtn:  { background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, padding: 0 },
  input:      { width: '100%', padding: '12px 14px', background: '#13151b', border: '1px solid #20232b', borderRadius: 10, color: '#e7e9ee', fontSize: 14, marginBottom: 14 },
  dateInput:  { colorScheme: 'dark' },
  rowInputs:  { display: 'flex', gap: 10, alignItems: 'stretch' },
  card:       { background: '#11131a', border: '1px solid #1d2027', borderRadius: 12, padding: 14, marginBottom: 12 },
  cardHead:   { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  exName:     { flex: 1, minWidth: 0, padding: '10px 12px', background: '#0c0d10', border: '1px solid #20232b', borderRadius: 8, color: '#e7e9ee', fontFamily: "'Oswald', sans-serif", fontWeight: 500, fontSize: 16 },
  exNameGuess:{ borderColor: ACCENT, boxShadow: '0 0 0 1px ' + ACCENT },
  confirmBtn: { width: 40, flexShrink: 0, padding: '8px 0', background: ACCENT, color: '#0c0d10', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  // Modality badge
  modalityBadge: { display: 'inline-block', fontSize: 11, padding: '4px 10px', borderRadius: 20, border: '1px solid', cursor: 'pointer', marginBottom: 10, fontFamily: 'inherit', letterSpacing: 0.5 },
  modalityColors: {
    strength:   { background: 'rgba(215,255,50,0.08)',  color: ACCENT,    borderColor: 'rgba(215,255,50,0.3)' },
    bodyweight: { background: 'rgba(107,159,255,0.08)', color: BLUE,      borderColor: 'rgba(107,159,255,0.3)' },
    distance:   { background: 'rgba(255,178,71,0.08)',  color: '#ffb247', borderColor: 'rgba(255,178,71,0.3)' },
    duration:   { background: 'rgba(160,107,255,0.08)', color: '#a06bff', borderColor: 'rgba(160,107,255,0.3)' },
    cardio:     { background: 'rgba(71,225,178,0.08)',  color: '#47e1b2', borderColor: 'rgba(71,225,178,0.3)' },
  },
  setHeader:  { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, letterSpacing: 1, color: '#6b7080', marginBottom: 6, paddingLeft: 2 },
  col:        { flex: 1, minWidth: 0 },
  setRow:     { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7, overflow: 'hidden' },
  setNo:      { width: 20, flexShrink: 0, fontSize: 12, color: '#7b8090', textAlign: 'center' },
  setInput:   { flex: 1, minWidth: 0, padding: '9px 4px', background: '#0c0d10', border: '1px solid #20232b', borderRadius: 8, color: '#e7e9ee', fontSize: 14, textAlign: 'center' },
  unitBtn:    { width: 42, flexShrink: 0, padding: '9px 0', background: '#1a1d24', border: '1px solid #2a2e38', borderRadius: 8, color: ACCENT, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' },
  // Resistance stepper
  stepper:    { display: 'flex', alignItems: 'center', flexShrink: 0, background: '#1a1d24', border: '1px solid #2a2e38', borderRadius: 8, overflow: 'hidden' },
  stepBtn:    { width: 24, padding: '9px 0', background: 'transparent', border: 'none', color: '#8b909c', fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' },
  stepVal:    { width: 20, textAlign: 'center', fontSize: 13, color: '#47e1b2' },
  del:        { background: 'none', border: 'none', color: '#6b7080', fontSize: 16, cursor: 'pointer', padding: '4px 6px', flexShrink: 0 },
  delSm:      { width: 24, flexShrink: 0, background: 'none', border: 'none', color: '#5a5f6b', fontSize: 13, cursor: 'pointer' },
  addSet:     { background: 'none', border: '1px dashed #2a2e38', borderRadius: 8, color: '#8b909c', fontFamily: 'inherit', fontSize: 12, padding: '8px', width: '100%', cursor: 'pointer', marginTop: 4 },
  guessBanner:{ background: 'rgba(215,255,50,0.08)', border: '1px solid rgba(215,255,50,0.35)', borderRadius: 10, padding: '11px 13px', fontSize: 12, color: '#d7ff32', lineHeight: 1.55, marginBottom: 14 },
  guessTag:   { fontSize: 11, color: '#aeb86b', margin: '-2px 0 8px 2px', lineHeight: 1.4 },
  rememberTag:{ fontSize: 11, color: '#6b7080', margin: '-2px 0 8px 2px', lineHeight: 1.4 },
  hintTag:    { fontSize: 11, color: '#7fbfa0', margin: '-2px 0 8px 2px', lineHeight: 1.4 },
  chips:      { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chip:       { padding: '7px 12px', background: '#13151b', border: '1px solid #2a2e38', borderRadius: 20, color: '#cfd3dc', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
  chipOn:     { background: ACCENT, color: '#0c0d10', borderColor: ACCENT, fontWeight: 500 },
  statRow:    { display: 'flex', gap: 8, marginBottom: 16 },
  statBox:    { flex: 1, background: '#11131a', border: '1px solid #1d2027', borderRadius: 10, padding: '10px 8px', textAlign: 'center' },
  statVal:    { fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, color: '#e7e9ee', lineHeight: 1 },
  statUnit:   { fontSize: 11, color: '#8b909c', marginLeft: 2 },
  statLbl:    { fontSize: 9, letterSpacing: 1.5, color: '#6b7080', marginTop: 4 },
  toggle:     { display: 'flex', background: '#11131a', border: '1px solid #1d2027', borderRadius: 10, overflow: 'hidden', marginBottom: 14 },
  toggleBtn:  { flex: 1, padding: '10px', background: 'transparent', border: 'none', color: '#6b7080', fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: 1.5, cursor: 'pointer' },
  toggleOn:   { background: '#1d2027', color: ACCENT },
  chartCaption: { fontSize: 11, color: '#6b7080', marginBottom: 2, lineHeight: 1.5 },
  chartNote:  { fontSize: 11, color: '#6b7080', marginTop: 10, lineHeight: 1.6, padding: '8px 10px', background: '#11131a', borderRadius: 8, border: '1px solid #1d2027' },
  chartLabel: { fontSize: 12, color: '#8b909c', letterSpacing: 1 },
  note:       { fontSize: 11, color: '#6b7080', marginTop: 16, textAlign: 'center' },
  dataRow:    { display: 'flex', gap: 8 },
  dataBtn:    { flex: 1, padding: '10px 0', background: 'transparent', border: '1px solid #2a2e38', borderRadius: 8, color: '#8b909c', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
  dataMsg:    { fontSize: 11.5, color: '#7fbfa0', marginTop: 10, lineHeight: 1.5 },
  dataNote:   { fontSize: 10.5, color: '#5a5f6b', marginTop: 10, lineHeight: 1.6 },
};
