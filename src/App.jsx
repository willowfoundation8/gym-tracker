// src/App.jsx — deployed version. Storage comes from ./db (Dexie); AI calls go
// through your Cloudflare Worker proxy (/api/vision, /api/expand) so your
// Anthropic key stays server-side. UI is identical to the artifact build.

import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  getWorkouts, getWorkout, saveWorkout, deleteWorkout,
  getExerciseNames, getExerciseHistory, getAbbrevMap, learnAbbrev, nameKey,
} from './db';

/* ===========================================================================
   IMAGE + VISION — calls go to YOUR Worker proxy, not Anthropic directly.
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
    'You are reading a gym workout board from a photo. Extract the list of exercises. ' +
    'For each "name", use the EXACT text as written on the board, including any abbreviations or shorthand (do not expand them yourself). ' +
    'Respond with ONLY a JSON array, no prose, no markdown fences. Each item: ' +
    '{"name": string, "suggestedSets": number|null, "suggestedReps": number|null}. ' +
    "If a value isn't shown on the board, use null. Preserve the order they appear on the board.";
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
  return arr.map((x) => ({ raw: (x.name || 'Exercise').trim(), suggestedSets: x.suggestedSets ?? null, suggestedReps: x.suggestedReps ?? null }));
}

async function expandViaAI(rawList) {
  const prompt =
    'These are exercise names written in shorthand on a gym workout board. ' +
    'Expand each to its full, standard exercise name (e.g. "DB SA Row" -> "Dumbbell Single Arm Row", "BB OHP" -> "Barbell Overhead Press"). ' +
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

// Resolve raw board names to full names: learned cache first, model for unknowns.
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
   UI
=========================================================================== */
const ACCENT = '#d7ff32';

export default function App() {
  const [screen, setScreen] = useState('home');
  const [workouts, setWorkouts] = useState([]);
  const [names, setNames] = useState([]);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [visionErr, setVisionErr] = useState(null);
  const [chartName, setChartName] = useState(null);
  const [chartData, setChartData] = useState([]);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  async function refresh() {
    setWorkouts(await getWorkouts());
    setNames(await getExerciseNames());
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
      const exercises = resolved.map((r, i) => {
        const count = read[i].suggestedSets ?? 1;
        const sets = Array.from({ length: Math.max(1, count) }, () => ({
          reps: read[i].suggestedReps ?? null,
          weight: null,
          weightUnit: 'kg',
        }));
        return {
          name: r.name,
          original: r.original,
          status: r.status,
          guessed: r.status !== 'remembered',
          sets,
        };
      });
      setDraft({ className: null, date: todayStr(), exercises });
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
    setDraft({ className: null, date: todayStr(), exercises: [{ name: '', sets: [{ reps: null, weight: null, weightUnit: 'kg' }] }] });
    setScreen('edit');
  }

  const setDraftField = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateExercise = (i, patch) => setDraft((d) => ({ ...d, exercises: d.exercises.map((ex, j) => (j === i ? { ...ex, ...patch } : ex)) }));
  const addExercise = () => setDraft((d) => ({ ...d, exercises: [...d.exercises, { name: '', sets: [{ reps: null, weight: null, weightUnit: 'kg' }] }] }));
  const removeExercise = (i) => setDraft((d) => ({ ...d, exercises: d.exercises.filter((_, j) => j !== i) }));
  const addSet = (i) => updateExercise(i, { sets: [...draft.exercises[i].sets, { reps: null, weight: null, weightUnit: draft.exercises[i].sets.at(-1)?.weightUnit || 'kg' }] });
  const updateSet = (i, si, patch) => updateExercise(i, { sets: draft.exercises[i].sets.map((s, k) => (k === si ? { ...s, ...patch } : s)) });
  const removeSet = (i, si) => updateExercise(i, { sets: draft.exercises[i].sets.filter((_, k) => k !== si) });

  async function save() {
    const cleaned = { ...draft, exercises: draft.exercises.filter((ex) => (ex.name || '').trim()) };
    if (!cleaned.exercises.length) { setScreen('home'); setDraft(null); return; }
    // Persist the user-chosen date; fall back to now only if somehow missing
    if (cleaned.date) {
      cleaned.date = new Date(cleaned.date + 'T12:00:00').toISOString();
    } else {
      cleaned.date = new Date().toISOString();
    }
    await learnAbbrev(cleaned.exercises.filter((e) => e.original && e.original !== e.name).map((e) => ({ raw: e.original, name: (e.name || '').trim() })));
    await saveWorkout(cleaned);
    setDraft(null); setPreview(null);
    await refresh();
    setScreen('home');
  }

  async function openWorkout(id) {
    const w = await getWorkout(id);
    if (w) {
      // Convert stored ISO date → YYYY-MM-DD for the date input
      const d = w.date ? new Date(w.date) : new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      setDraft({ ...w, date: dateStr });
      setPreview(null);
      setScreen('edit');
    }
  }
  async function remove(id) {
    await deleteWorkout(id);
    await refresh();
  }

  async function openProgress() {
    await refresh();
    const ns = await getExerciseNames();
    const first = ns[0] || null;
    setChartName(first);
    setChartData(first ? await getExerciseHistory(first) : []);
    setScreen('progress');
  }
  async function pickChart(n) {
    setChartName(n);
    setChartData(await getExerciseHistory(n));
  }

  const num = (v) => (v === null || v === undefined || v === '' ? '' : v);
  const parseNum = (v) => (v === '' ? null : Number(v));
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  return (
    <div style={S.shell}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        input { font-family: inherit; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes rise { from { opacity:0; transform: translateY(6px);} to {opacity:1; transform:none;} }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-thumb { background:#2a2e38; border-radius:3px; }
      `}</style>

      <input ref={fileRef} type="file" accept="image/*" onChange={onPhotoChosen} style={{ display: 'none' }} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onPhotoChosen} style={{ display: 'none' }} />

      {screen === 'home' && (
        <div style={S.page}>
          <div style={S.kicker}>WORKOUT LOG</div>
          <h1 style={S.h1}>GYM&nbsp;TRACKER</h1>
          <div style={S.sub}>{workouts.length} session{workouts.length === 1 ? '' : 's'} · {names.length} exercise{names.length === 1 ? '' : 's'} tracked</div>

          <button style={S.cta} onClick={() => setScreen('capture')}>+ NEW WORKOUT</button>
          <button style={S.ghost} onClick={openProgress}>VIEW PROGRESS</button>

          <div style={S.label}>HISTORY</div>
          {workouts.length === 0 ? (
            <div style={S.empty}>No workouts yet. Tap “New Workout”, snap the board, and log your sets.</div>
          ) : workouts.map((w) => (
            <div key={w.id} style={S.row} onClick={() => openWorkout(w.id)}>
              <div style={{ flex: 1 }}>
                <div style={S.rowDate}>{new Date(w.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                <div style={S.rowName}>{w.className || `${w.exercises.length} exercise${w.exercises.length === 1 ? '' : 's'}`}</div>
                <div style={S.rowMeta}>{w.exercises.slice(0, 3).map((e) => e.name).join(' · ')}{w.exercises.length > 3 ? ' …' : ''}</div>
              </div>
              <button style={S.del} onClick={(ev) => { ev.stopPropagation(); remove(w.id); }}>✕</button>
            </div>
          ))}
        </div>
      )}

      {screen === 'capture' && (
        <div style={S.page}>
          <button style={S.back} onClick={() => setScreen('home')}>‹ back</button>
          <h2 style={S.h2}>NEW WORKOUT</h2>
          <div style={S.sub}>Snap the board and let AI read the exercises — or enter them yourself.</div>

          {preview && <img src={preview} alt="board" style={S.previewImg} />}

          {busy ? (
            <div style={S.loading}><div style={S.spinner} /> Reading the board…</div>
          ) : (
            <>
              <button style={S.cta} onClick={openUpload}>🖼 UPLOAD EXISTING PHOTO</button>
              <button style={S.ghost} onClick={openCamera}>📷 TAKE A PHOTO</button>
              <button style={S.ghost} onClick={startManual}>ENTER MANUALLY</button>
            </>
          )}
          {visionErr && <div style={S.errBox}>{visionErr} <button style={S.inlineBtn} onClick={startManual}>Enter manually →</button></div>}
        </div>
      )}

      {screen === 'edit' && draft && (
        <div style={S.page}>
          <button style={S.back} onClick={() => { setScreen('home'); setDraft(null); }}>‹ cancel</button>
          <h2 style={S.h2}>{draft.id ? 'EDIT WORKOUT' : 'LOG WORKOUT'}</h2>

          {preview && <img src={preview} alt="board" style={S.previewThumb} />}

          <input
            style={{ ...S.input, ...S.dateInput }}
            type="date"
            value={draft.date || ''}
            onChange={(e) => setDraftField({ date: e.target.value })}
          />
          <input style={S.input} placeholder="Class / workout name (optional)" value={num(draft.className)} onChange={(e) => setDraftField({ className: e.target.value })} />

          {draft.exercises.some((e) => e.guessed) && (
            <div style={S.guessBanner}>⚡ Shorthand names were auto-suggested (e.g. “DB SA Row” → “Dumbbell Single Arm Row”). Tap a highlighted name to fix it, or ✓ to confirm. Once saved, each one is remembered — no re-asking next time.</div>
          )}

          {draft.exercises.map((ex, i) => (
            <div key={i} style={S.card}>
              <div style={S.cardHead}>
                <input style={{ ...S.exName, ...(ex.guessed ? S.exNameGuess : {}) }} placeholder="Exercise name" value={ex.name} onChange={(e) => updateExercise(i, { name: e.target.value, guessed: false, status: 'confirmed' })} />
                {ex.guessed && <button style={S.confirmBtn} title="confirm name" onClick={() => updateExercise(i, { guessed: false, status: 'confirmed' })}>✓</button>}
                <button style={S.del} onClick={() => removeExercise(i)}>✕</button>
              </div>
              {ex.guessed && ex.status === 'unknown' && <div style={S.guessTag}>⚠ couldn’t auto-name “{ex.original}” — please check</div>}
              {ex.guessed && ex.status !== 'unknown' && <div style={S.guessTag}>⚡ auto-suggested from “{ex.original}” — confirm ✓ or edit</div>}
              {!ex.guessed && ex.status === 'remembered' && <div style={S.rememberTag}>✓ remembered “{ex.original}” from before</div>}
              <div style={S.setHeader}><span style={{ width: 28 }}>#</span><span style={S.col}>reps</span><span style={S.col}>weight</span><span style={{ width: 56 }}>unit</span><span style={{ width: 28 }} /></div>
              {ex.sets.map((s, si) => (
                <div key={si} style={S.setRow}>
                  <span style={S.setNo}>{si + 1}</span>
                  <input style={S.setInput} type="number" inputMode="numeric" placeholder="–" value={num(s.reps)} onChange={(e) => updateSet(i, si, { reps: parseNum(e.target.value) })} />
                  <input style={S.setInput} type="number" inputMode="decimal" placeholder="–" value={num(s.weight)} onChange={(e) => updateSet(i, si, { weight: parseNum(e.target.value) })} />
                  <button style={S.unitBtn} onClick={() => updateSet(i, si, { weightUnit: s.weightUnit === 'kg' ? 'lb' : 'kg' })}>{s.weightUnit}</button>
                  <button style={S.delSm} onClick={() => removeSet(i, si)}>✕</button>
                </div>
              ))}
              <button style={S.addSet} onClick={() => addSet(i)}>+ add set</button>
            </div>
          ))}

          <button style={S.ghost} onClick={addExercise}>+ ADD EXERCISE</button>
          <button style={S.cta} onClick={save}>SAVE WORKOUT</button>
        </div>
      )}

      {screen === 'progress' && (
        <div style={S.page}>
          <button style={S.back} onClick={() => setScreen('home')}>‹ back</button>
          <h2 style={S.h2}>PROGRESS</h2>
          {names.length === 0 ? (
            <div style={S.empty}>Log a few workouts and your exercise trends will show up here.</div>
          ) : (
            <>
              <div style={S.chips}>
                {names.map((n) => (
                  <button key={n} onClick={() => pickChart(n)} style={{ ...S.chip, ...(n === chartName ? S.chipOn : {}) }}>{n}</button>
                ))}
              </div>
              <div style={S.chartLabel}>{chartName} — top set weight over time</div>
              <div style={{ height: 240, marginTop: 8 }}>
                {chartData.length < 2 ? (
                  <div style={S.empty}>Need at least two logged sessions of “{chartName}” to chart a trend.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData.map((d) => ({ ...d, label: new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }))}>
                      <CartesianGrid stroke="#1d2027" strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fill: '#8b909c', fontSize: 11 }} />
                      <YAxis tick={{ fill: '#8b909c', fontSize: 11 }} width={32} />
                      <Tooltip contentStyle={{ background: '#13151b', border: '1px solid #2a2e38', borderRadius: 8, color: '#e7e9ee' }} />
                      <Line type="monotone" dataKey="weight" stroke={ACCENT} strokeWidth={2.5} dot={{ fill: ACCENT, r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
              <div style={S.note}>Next up (v1.1): personal records and streaks.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const S = {
  shell: { background: '#0c0d10', color: '#e7e9ee', minHeight: '100vh', fontFamily: "'IBM Plex Mono', ui-monospace, monospace" },
  page: { maxWidth: 540, margin: '0 auto', padding: '26px 18px 70px', animation: 'rise .25s ease' },
  kicker: { fontSize: 11, letterSpacing: 3, color: ACCENT, fontWeight: 500 },
  h1: { fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 44, lineHeight: 1, margin: '6px 0 8px', letterSpacing: 1 },
  h2: { fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 30, margin: '4px 0 6px', letterSpacing: 1 },
  sub: { fontSize: 12.5, color: '#8b909c', marginBottom: 22, lineHeight: 1.5 },
  cta: { width: '100%', padding: '15px', background: ACCENT, color: '#0c0d10', border: 'none', borderRadius: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: 1, cursor: 'pointer', marginBottom: 10 },
  ghost: { width: '100%', padding: '13px', background: 'transparent', color: '#cfd3dc', border: '1px solid #2a2e38', borderRadius: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 500, fontSize: 14, letterSpacing: 1, cursor: 'pointer', marginBottom: 10 },
  label: { fontSize: 11, letterSpacing: 2, color: '#8b909c', margin: '24px 0 10px' },
  empty: { padding: '22px 16px', border: '1px dashed #2a2e38', borderRadius: 10, color: '#6b7080', fontSize: 13, textAlign: 'center', lineHeight: 1.6 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', background: '#13151b', border: '1px solid #1d2027', borderRadius: 10, marginBottom: 8, cursor: 'pointer' },
  rowDate: { fontSize: 11, color: ACCENT, marginBottom: 3, letterSpacing: 1 },
  rowName: { fontFamily: "'Oswald', sans-serif", fontWeight: 500, fontSize: 17 },
  rowMeta: { fontSize: 11, color: '#7b8090', marginTop: 3 },
  back: { background: 'none', border: 'none', color: '#8b909c', fontSize: 13, padding: '4px 0', marginBottom: 8, cursor: 'pointer', fontFamily: 'inherit' },
  previewImg: { width: '100%', borderRadius: 12, border: '1px solid #1d2027', margin: '6px 0 16px' },
  previewThumb: { width: '100%', maxHeight: 150, objectFit: 'cover', borderRadius: 10, border: '1px solid #1d2027', margin: '6px 0 14px' },
  loading: { display: 'flex', alignItems: 'center', gap: 12, padding: '20px 4px', color: '#cfd3dc', fontSize: 14 },
  spinner: { width: 22, height: 22, border: '3px solid #2a2e38', borderTopColor: ACCENT, borderRadius: '50%', animation: 'spin .8s linear infinite' },
  errBox: { marginTop: 12, padding: 12, background: '#1a1115', border: '1px solid #5a2330', borderRadius: 10, color: '#ff9aa6', fontSize: 12.5, lineHeight: 1.5 },
  inlineBtn: { background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, padding: 0 },
  input: { width: '100%', padding: '12px 14px', background: '#13151b', border: '1px solid #20232b', borderRadius: 10, color: '#e7e9ee', fontSize: 14, marginBottom: 14 },
  dateInput: { colorScheme: 'dark', marginBottom: 10 },
  card: { background: '#11131a', border: '1px solid #1d2027', borderRadius: 12, padding: 14, marginBottom: 12 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  exName: { flex: 1, padding: '10px 12px', background: '#0c0d10', border: '1px solid #20232b', borderRadius: 8, color: '#e7e9ee', fontFamily: "'Oswald', sans-serif", fontWeight: 500, fontSize: 16 },
  exNameGuess: { borderColor: ACCENT, boxShadow: '0 0 0 1px ' + ACCENT },
  confirmBtn: { width: 40, padding: '8px 0', background: ACCENT, color: '#0c0d10', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  setHeader: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, letterSpacing: 1, color: '#6b7080', marginBottom: 6, paddingLeft: 2 },
  col: { flex: 1 },
  setRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 },
  setNo: { width: 28, fontSize: 12, color: '#7b8090', textAlign: 'center' },
  setInput: { flex: 1, width: '100%', padding: '10px', background: '#0c0d10', border: '1px solid #20232b', borderRadius: 8, color: '#e7e9ee', fontSize: 15, textAlign: 'center' },
  unitBtn: { width: 56, padding: '10px 0', background: '#1a1d24', border: '1px solid #2a2e38', borderRadius: 8, color: ACCENT, fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
  del: { background: 'none', border: 'none', color: '#6b7080', fontSize: 16, cursor: 'pointer', padding: '4px 8px' },
  delSm: { width: 28, background: 'none', border: 'none', color: '#5a5f6b', fontSize: 13, cursor: 'pointer' },
  addSet: { background: 'none', border: '1px dashed #2a2e38', borderRadius: 8, color: '#8b909c', fontFamily: 'inherit', fontSize: 12, padding: '8px', width: '100%', cursor: 'pointer', marginTop: 4 },
  guessBanner: { background: 'rgba(215,255,50,0.08)', border: '1px solid rgba(215,255,50,0.35)', borderRadius: 10, padding: '11px 13px', fontSize: 12, color: '#d7ff32', lineHeight: 1.55, marginBottom: 14 },
  guessTag: { fontSize: 11, color: '#aeb86b', margin: '-4px 0 10px 2px', lineHeight: 1.4 },
  rememberTag: { fontSize: 11, color: '#6b7080', margin: '-4px 0 10px 2px', lineHeight: 1.4 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  chip: { padding: '8px 12px', background: '#13151b', border: '1px solid #2a2e38', borderRadius: 20, color: '#cfd3dc', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
  chipOn: { background: ACCENT, color: '#0c0d10', borderColor: ACCENT, fontWeight: 500 },
  chartLabel: { fontSize: 12, color: '#8b909c', letterSpacing: 1 },
  note: { fontSize: 11, color: '#6b7080', marginTop: 16, textAlign: 'center' },
};
