// Progress metrics: e1RM, per-modality session aggregation, chart config, history stats.
import { nameKey } from '../db';
import { toKg, toMeters, fmtSeconds, fmtDist } from './helpers';

function epley(weight, reps) {
  if (!weight || !reps || weight <= 0 || reps <= 0) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30));
}

// History summary for an exercise while logging: sessions count, average and
// best of the modality's headline value, in canonical kg/m/seconds.
// excludeId skips the workout currently being edited so it can't inflate itself.
function exerciseStats(workouts, exerciseName, modality, excludeId) {
  const key = nameKey(exerciseName);
  if (!key) return null;
  const vals = [];
  let sessions = 0;
  for (const w of workouts) {
    if (excludeId && w.id === excludeId) continue;
    const matched = w.exercises.filter((e) => nameKey(e.name) === key);
    if (!matched.length) continue;
    const sets = matched.flatMap((e) => e.sets || []);
    let sessionVals = [];
    if (modality === 'strength' || modality === 'loaded_distance') {
      sessionVals = sets.filter((s) => s.weight > 0).map((s) => toKg(s.weight, s.weightUnit));
    } else if (modality === 'bodyweight') {
      sessionVals = sets.filter((s) => s.reps > 0).map((s) => s.reps);
    } else if (modality === 'duration') {
      sessionVals = sets.filter((s) => s.seconds > 0).map((s) => s.seconds);
    } else if (modality === 'distance' || modality === 'cardio') {
      sessionVals = sets.filter((s) => s.distance > 0).map((s) => toMeters(s.distance, s.distUnit));
    }
    if (sessionVals.length) { sessions++; vals.push(...sessionVals); }
  }
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const max = Math.max(...vals);
  const kind = (modality === 'strength' || modality === 'loaded_distance') ? 'kg'
             : modality === 'bodyweight' ? 'reps'
             : modality === 'duration' ? 'sec' : 'm';
  return { sessions, avg, max, kind };
}

// The most recent session containing this exercise. An exercise can appear
// more than once in a workout (warmup + working sets as separate entries), so
// every instance's sets are merged. excludeId skips the workout being edited
// so it can never suggest itself back.
//
// Deliberately separate from exerciseStats: that answers "how am I trending"
// with averages and bests; this answers "what do I load today", which is the
// only question that matters while standing at the rack.
function lastSession(workouts, exerciseName, excludeId) {
  const key = nameKey(exerciseName);
  if (!key) return null;
  let best = null;
  for (const w of workouts) {
    if (excludeId && w.id === excludeId) continue;
    const matched = (w.exercises || []).filter((e) => nameKey(e.name) === key);
    if (!matched.length) continue;
    if (!best || new Date(w.date) > new Date(best.date)) {
      best = {
        date: w.date,
        modality: matched[0].modality || 'strength',
        sets: matched.flatMap((e) => e.sets || []),
      };
    }
  }
  return best;
}

// One set, in the units it was logged in — no conversion. This is a reminder
// of what you actually did, so it should read exactly as you entered it.
function fmtSetSummary(s, modality) {
  const wu = s.weightUnit || 'kg';
  const du = s.distUnit || 'm';
  switch (modality) {
    case 'bodyweight':      return s.weight ? `${s.reps} × ${s.weight}${wu}` : `${s.reps} reps`;
    case 'distance':        return s.seconds ? `${s.distance}${du} in ${fmtSeconds(s.seconds)}` : `${s.distance}${du}`;
    case 'loaded_distance': return `${s.weight}${wu} × ${s.distance}${du}`;
    case 'duration':        return fmtSeconds(s.seconds);
    case 'cardio':          return `${s.distance}${du} in ${fmtSeconds(s.seconds)}`;
    default:                return `${s.weight}${wu} × ${s.reps}`;   // strength
  }
}

// "3 weeks ago" reads better than a date here — the gap is the useful part,
// not the calendar position.
function fmtAgo(date) {
  const days = Math.floor((Date.now() - new Date(date)) / 86400000);
  if (days <= 0)  return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)   return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5)  return weeks === 1 ? 'last week' : `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? 'last month' : `${months} months ago`;
}

function fmtStatVal(v, kind) {
  if (kind === 'sec') return fmtSeconds(Math.round(v));
  if (kind === 'm')   return fmtDist(v);
  if (kind === 'kg')  return `${Math.round(v * 10) / 10} kg`;
  return `${Math.round(v * 10) / 10} reps`;
}

function computeProgressData(workouts, exerciseName) {
  const key = nameKey(exerciseName);

  // Pass 1: collect matching (workout, exercise) pairs so we can decide
  // whether the date range spans multiple years (labels then include 'yy).
  // An exercise can appear MORE THAN ONCE in a workout (e.g. warmup sets +
  // working sets as separate entries, or repeated stations). Merge every
  // instance's sets — .find() would silently drop all but the first.
  const matches = [];
  for (const w of workouts) {
    const matched = w.exercises.filter((e) => nameKey(e.name) === key);
    if (matched.length) {
      matches.push({ w, modality: matched[0].modality || 'strength', sets: matched.flatMap((e) => e.sets || []) });
    }
  }
  const years = new Set(matches.map(({ w }) => new Date(w.date).getFullYear()));
  const multiYear = years.size > 1;
  const fmtLabel = (date) => {
    const d = new Date(date);
    const base = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return multiYear ? `${base} '${String(d.getFullYear()).slice(2)}` : base;
  };

  const sessions = [];
  for (const { w, modality, sets } of matches) {
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
      // Pace is optional: only sets carrying a logged time contribute. Computed
      // from canonical metres, so a 5km and an 800m set are directly comparable.
      // Session pace = the FASTEST set (lowest sec/km). Sessions with no time
      // logged emit null, which the chart renders as a gap rather than
      // interpolating a pace that was never recorded.
      const timed = valid.filter((s) => s.seconds > 0);
      const paceSecPerKm = timed.length
        ? Math.round(Math.min(...timed.map((s) => s.seconds / (s.m / 1000))))
        : null;
      sessions.push({ ...base, totalDist: Math.round(totalDist), bestDist: Math.round(bestDist), paceSecPerKm, totalSets: valid.length,
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

const CHART_CONFIG = {
  strength:        { primary: 'e1rm',        primaryLabel: 'e1RM (kg)',    primaryUnit: 'kg', secondary: 'volume',       secondaryLabel: 'Volume (kg)',    secondaryUnit: 'kg', note: 'e1RM normalises any set to a "max effort" number — heavy singles and volume sets become comparable.' },
  bodyweight:      { primary: 'maxReps',     primaryLabel: 'Max reps',     primaryUnit: '',   secondary: 'totalReps',    secondaryLabel: 'Total reps',     secondaryUnit: '',   note: 'Max reps is the best single set. Total reps shows overall volume done that session.' },
  distance:        { primary: 'bestDist',    primaryLabel: 'Best set (m)', primaryUnit: 'm',  secondary: 'totalDist',    secondaryLabel: 'Total dist (m)', secondaryUnit: 'm',  tertiary: 'paceSecPerKm', tertiaryLabel: 'Pace (/km)', note: 'Best set distance per session. Total shows cumulative distance covered. The dashed pace line only appears for sessions where you logged a time — lower is faster, and a gap means no time was recorded that session.' },
  loaded_distance: { primary: 'work',        primaryLabel: 'Work (kg·m)',  primaryUnit: '',   secondary: 'topWeight',    secondaryLabel: 'Best load (kg)', secondaryUnit: 'kg', note: 'Work = load × distance. The load bar shows whether progression came from heavier weight or more distance.' },
  duration:        { primary: 'bestSeconds', primaryLabel: 'Best hold',    primaryUnit: '',   secondary: 'totalSeconds', secondaryLabel: 'Total (s)',      secondaryUnit: 's',  note: 'Best single hold duration per session.' },
  cardio:          { primary: 'effort',      primaryLabel: 'Effort score', primaryUnit: '',   secondary: 'totalDist',    secondaryLabel: 'Distance (m)',   secondaryUnit: 'm',  note: 'Effort = (distance ÷ time) × (1 + resistance ÷ 20). Rewards going harder at higher resistance.' },
};

export { epley, exerciseStats, fmtStatVal, computeProgressData, CHART_CONFIG, lastSession, fmtSetSummary, fmtAgo };
