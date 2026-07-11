// Exercise modality system: seed dictionary, lookup helpers, body regions, workout types.
import { nameKey } from '../db';
import { uid } from './helpers';

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

// Body-region classifier for the progress filter. Keyword-based on the name,
// padded with spaces for rough word boundaries. Order matters: core, then
// lower (so "Calf Raise" wins over upper's "raise"), then upper. Cardio-modality
// exercises short-circuit to 'cardio' (so machine "Row" ≠ "DB Row").
const REGIONS = ['all', 'upper', 'lower', 'core', 'cardio'];
const CORE_KEYS  = [' plank ', ' sit-up ', ' sit up ', ' situp ', ' crunch ', ' hollow ', ' v-up ', ' v up ', ' russian ', ' dead bug ', ' bird dog ', ' ab ', ' abs ', ' core ', ' mountain climber '];
const LOWER_KEYS = [' squat ', ' lunge ', ' deadlift ', ' rdl ', ' leg ', ' calf ', ' glute ', ' hip ', ' hamstring ', ' quad ', ' adductor ', ' abductor ', ' step up ', ' step-up ', ' step over ', ' box jump ', ' wall sit ', ' sled ', ' prowler ', ' bridge ', ' thrust '];
const UPPER_KEYS = [' press ', ' bench ', ' row ', ' pull ', ' push ', ' chin ', ' curl ', ' tricep ', ' bicep ', ' shoulder ', ' lat ', ' chest ', ' dip ', ' fly ', ' flye ', ' raise ', ' shrug ', ' snatch ', ' clean ', ' jerk ', ' pullover ', ' extension '];
const CARDIO_KEYS = [' run ', ' sprint ', ' jog ', ' ski ', ' bike ', ' cycle ', ' erg ', ' rowing ', ' treadmill '];
function bodyRegion(name, modality) {
  if (modality === 'cardio') return 'cardio';
  const k = ' ' + nameKey(name) + ' ';
  const has = (arr) => arr.some((w) => k.includes(w));
  if (has(CARDIO_KEYS)) return 'cardio';   // runs/sprints are distance-modality but read as cardio to a human
  if (has(CORE_KEYS))  return 'core';
  if (has(LOWER_KEYS)) return 'lower';
  if (has(UPPER_KEYS)) return 'upper';
  return 'other';
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

export { MODALITIES, MODALITY_LABELS, isSledType, REGIONS, bodyRegion, MODALITY_SEED, seedModality, nextModality, emptySet, WORKOUT_TYPES, WORKOUT_TYPE_LABELS };
