// AI board reading: image prep, vision extraction, shorthand expansion, name resolution.
import { getAbbrevMap, nameKey, logEvent } from '../db';
import { parseModelJSON } from './helpers';
import { MODALITIES } from './modality';

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
  const t0 = Date.now();
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
  if (!res.ok) {
    logEvent('error', 'vision_http', `status ${res.status}`);
    throw new Error('vision_http_' + res.status);
  }
  const data = await res.json();
  const stop = data.stop_reason || '?';
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const arr = parseModelJSON(text);
  if (!Array.isArray(arr)) {
    // stop_reason 'max_tokens' = response was cut off by the Worker's limit
    logEvent('error', 'vision_parse', `stop=${stop} len=${text.length} head=${text.slice(0, 200)}`);
    throw new Error(stop === 'max_tokens' ? 'vision_truncated' : 'vision_parse');
  }
  if (stop === 'max_tokens') {
    logEvent('warn', 'vision_salvaged', `truncated by max_tokens — recovered ${arr.length} exercises, the last one on the board may be missing. Raise max_tokens in vision.js.`);
  } else {
    logEvent('info', 'vision_ok', `${arr.length} exercises · ${Date.now() - t0}ms · len=${text.length} · stop=${stop}`);
  }
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

const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other'];

// Normalises one expansion. Accepts the old string shape as well as the
// object shape, so a cached/stale/partial response can never turn an exercise
// name into "[object Object]" on screen.
function normalizeExpansion(v) {
  if (typeof v === 'string') return { name: v, family: null, equipment: null };
  if (v && typeof v === 'object' && typeof v.name === 'string') {
    const fam = typeof v.family === 'string' ? v.family.trim().toLowerCase() : '';
    return {
      name: v.name,
      family: fam || null,
      // Validate against the known set — models occasionally return values
      // outside a specified enum. Family stays free text: the set of human
      // movements can't be enumerated.
      equipment: EQUIPMENT.includes(v.equipment) ? v.equipment : 'other',
    };
  }
  return null;
}

async function expandViaAI(rawList) {
  const prompt =
    'These are exercise names written in shorthand on a gym workout board. ' +
    'Expand each to its full, standard exercise name (e.g. "DB SA Row" -> "Dumbbell Single Arm Row", "BB OHP" -> "Barbell Overhead Press"). ' +
    'IMPORTANT: strip any leftover prescription from the name — leading rep/set counts ("28x", "3x"), distances ("5km"), or durations ("30s"). Return ONLY the clean movement name. KEEP qualifiers like "Single Arm", "Single Leg", "Double Under". ' +
    'Keep names concise and standard.\n\n' +
    'Also classify each movement:\n' +
    '- "family": the canonical movement in snake_case, IGNORING equipment and variation. "Dumbbell Bench Press", "Barbell Bench Press" and "Machine Chest Press" all share family "bench_press". Examples: bench_press, squat, deadlift, row, overhead_press, curl, lunge, pulldown, fly, calf_raise.\n' +
    `- "equipment": exactly one of ${JSON.stringify(EQUIPMENT)}.\n\n` +
    'Respond with ONLY a JSON object mapping each EXACT input string to ' +
    '{"name":string,"family":string,"equipment":string} - no prose, no markdown fences.\n\nInputs: ' +
    JSON.stringify(rawList);
  const res = await fetch('/api/expand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    logEvent('warn', 'expand_http', `status ${res.status}`);
    throw new Error('Expand request failed: ' + res.status);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const obj = parseModelJSON(text);
  if (!obj || typeof obj !== 'object') {
    logEvent('warn', 'expand_parse', `len=${text.length} head=${text.slice(0, 120)}`);
    throw new Error('expand_parse');
  }
  return obj;
}

async function resolveNames(rawList) {
  const map = await getAbbrevMap();
  const unknown = rawList.filter((raw) => !map[nameKey(raw)]);
  let sugByKey = {};
  if (unknown.length) {
    try {
      const suggestions = await expandViaAI([...new Set(unknown)]);
      Object.entries(suggestions || {}).forEach(([k, v]) => {
        const norm = normalizeExpansion(v);
        if (norm) sugByKey[nameKey(k)] = norm;
      });
    } catch (e) { logEvent('warn', 'expand_fallback', e.message + ' — names kept raw'); sugByKey = {}; }
  }
  return rawList.map((raw) => {
    const key = nameKey(raw);
    // A remembered name carries no family/equipment — that's fine, the
    // learned store already holds them from when it was first expanded.
    if (map[key]) return { name: map[key], original: raw, status: 'remembered', family: null, equipment: null };
    const s = sugByKey[key];
    if (s) return { name: s.name, original: raw, status: 'suggested', family: s.family, equipment: s.equipment };
    return { name: raw, original: raw, status: 'unknown', family: null, equipment: null };
  });
}

export { fileToImage, extractExercises, expandViaAI, resolveNames, stripPrescription, normalizeExpansion, EQUIPMENT };
