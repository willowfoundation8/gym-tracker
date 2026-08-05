import { useState, useEffect, useRef } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ScatterChart, Scatter, ZAxis,
} from 'recharts';
import {
  getWorkouts, getWorkout, saveWorkout, deleteWorkout,
  getExerciseNames, learnAbbrev, nameKey, getModalityMap, learnModality,
  exportAll, importAll, exportCSV, logEvent, getLogs, clearLogs,
} from './db';
import { uid, withRetry, fmtSeconds } from './lib/helpers';
import {
  MODALITY_LABELS, WORKOUT_TYPES, WORKOUT_TYPE_LABELS, REGIONS,
  bodyRegion, emptySet, nextModality, isSledType, seedModality,
} from './lib/modality';
import { fileToImage, extractExercises, resolveNames } from './lib/vision';
import { computeProgressData, exerciseStats, fmtStatVal, CHART_CONFIG } from './lib/metrics';
import {
  SetRowStrength, SetRowBodyweight, SetRowDistance,
  SetRowLoadedDistance, SetRowDuration, SetRowCardio, SET_HEADERS,
} from './components/SetRows';
import { CombinedTooltip, ScatterTooltip, InfoTip, WEIGHT_CONVENTION } from './components/Tooltips';
import { ACCENT, BLUE, S } from './styles';

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
  const [logs, setLogs]           = useState([]);
  const [regionFilter, setRegionFilter] = useState('all');
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
      const read = await withRetry(() => extractExercises(base64), 'vision');
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
      logEvent('error', 'board_read_failed', err.message);
      const m = err.message || '';
      setVisionErr(
        m === 'vision_truncated'
          ? 'The board read was cut off — too many items for the current API limit. Raise max_tokens in vision.js (try 4000), or trim the photo.'
          : m.startsWith('vision_http_42') || m.startsWith('vision_http_52')
          ? 'The AI service is busy right now — give it a few seconds and try again.'
          : "Couldn't read the board automatically — you can enter it by hand."
      );
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
    const d = first ? computeProgressData(ws, first) : [];
    setChartData(d);
    if (d.length === 1) setChartView('scatter'); // per-set dots are the story with one session
    setScreen('progress');
  }
  function pickChart(n) {
    setChartName(n);
    const d = computeProgressData(workouts, n);
    setChartData(d);
    if (d.length === 1) setChartView('scatter');
  }

  async function openLogs() { setLogs(await getLogs(50)); setScreen('logs'); }
  async function onClearLogs() { await clearLogs(); setLogs([]); }

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

  // Latest-known modality per exercise name (workouts sorted desc → first hit wins)
  const modalityByKey = {};
  workouts.forEach((w) => (w.exercises || []).forEach((e) => {
    if (!(e.nameKey in modalityByKey)) modalityByKey[e.nameKey] = e.modality || 'strength';
  }));
  const filteredNames = regionFilter === 'all'
    ? names
    : names.filter((n) => bodyRegion(n, modalityByKey[nameKey(n)]) === regionFilter);

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
            <button style={S.dataBtn} onClick={openLogs}>🪵 Logs</button>
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
                {(() => {
                  const hist = exerciseStats(workouts, ex.name, mod, draft.id);
                  return hist ? (
                    <div style={S.histTag}>📊 {hist.sessions} session{hist.sessions === 1 ? '' : 's'} — avg {fmtStatVal(hist.avg, hist.kind)} · best {fmtStatVal(hist.max, hist.kind)}</div>
                  ) : null;
                })()}

                {/* Set headers. position:relative anchors the InfoTip popover
                    to the full header width so it can't overflow the screen. */}
                <div style={{ ...S.setHeader, position: 'relative' }}>
                  {headers.map((h, hi) => (
                    <span key={hi} style={hi === 0 ? { width: 28 } : hi === headers.length - 1 ? { width: 28 } : S.col}>
                      {h}
                      {(h === 'weight' || h === '+wt') && <InfoTip text={WEIGHT_CONVENTION} />}
                    </span>
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
              <div style={{ ...S.chips, marginBottom: 8 }}>
                {REGIONS.map((r) => (
                  <button key={r} onClick={() => setRegionFilter(r)}
                    style={{ ...S.chip, ...S.chipSm, ...(r === regionFilter ? S.chipOn : {}) }}>{r.toUpperCase()}</button>
                ))}
              </div>
              <div style={S.chips}>
                {filteredNames.length === 0 ? (
                  <div style={S.dataNote}>No {regionFilter} exercises logged yet.</div>
                ) : filteredNames.map((n) => (
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

              {chartData.length < 1 ? (
                <div style={S.empty}>No completed sets of "{chartName}" logged yet.</div>
              ) : (
                <div className="gt-chart-grid">

                  {/* ── COMBINED — always rendered, hidden on mobile if toggle is scatter ── */}
                  <div className="gt-chart-panel" style={chartView !== 'combined' ? { display: 'none' } : {}}>
                    <div style={S.chartCaption}>
                      <span style={{ color: ACCENT }}>━</span> {cfg.primaryLabel} &nbsp;·&nbsp; <span style={{ color: BLUE }}>▪</span> {cfg.secondaryLabel}
                      {cfg.tertiary && <> &nbsp;·&nbsp; <span style={{ color: '#ffb247' }}>┄</span> {cfg.tertiaryLabel}</>}
                    </div>
                    <div className="gt-chart-height" style={{ marginTop: 6 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="#1d2027" strokeDasharray="3 3" />
                          <XAxis dataKey="label" tick={{ fill: '#8b909c', fontSize: 11 }} />
                          <YAxis yAxisId="primary"   orientation="left"  tick={{ fill: '#8b909c', fontSize: 10 }} width={38} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                          <YAxis yAxisId="secondary" orientation="right" tick={{ fill: BLUE,      fontSize: 10 }} width={42} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                          <Tooltip content={<CombinedTooltip />} />
                          {/* Pace rides its own hidden axis — sec/km shares no
                              scale with metres, so putting it on either visible
                              axis would squash it flat. connectNulls={false}
                              leaves gaps for sessions logged without a time. */}
                          {cfg.tertiary && <YAxis yAxisId="tertiary" hide domain={['dataMin - 45', 'dataMax + 45']} />}
                          <Bar  yAxisId="secondary" dataKey={cfg.secondary} fill={BLUE}   opacity={0.45} radius={[3,3,0,0]} />
                          <Line yAxisId="primary"   dataKey={cfg.primary}   stroke={ACCENT} strokeWidth={2.5} dot={{ fill: ACCENT, r: 3 }} connectNulls />
                          {cfg.tertiary && <Line yAxisId="tertiary" dataKey={cfg.tertiary} stroke="#ffb247" strokeWidth={2} strokeDasharray="4 3" dot={{ fill: '#ffb247', r: 3 }} connectNulls={false} />}
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
              {chartData.length === 1 && (
                <div style={S.chartNote}>First session logged — each dot below is one set from it. The trend line starts growing with your next session.</div>
              )}
              <div style={S.note}>Next up (v1.1): personal records and streaks.</div>
            </>
          )}
        </div>
      )}

      {/* ── LOGS ── */}
      {screen === 'logs' && (
        <div style={S.page} className="gt-page">
          <button style={S.back} onClick={() => setScreen('home')}>‹ back</button>
          <h2 style={S.h2} className="gt-h2">DIAGNOSTICS</h2>
          <div style={S.sub} className="gt-sub">Last {logs.length} events, newest first. Board-read failures land here with the reason.</div>
          {logs.length === 0 ? (
            <div style={S.empty}>No events logged yet.</div>
          ) : (
            <>
              {logs.map((l) => (
                <div key={l.id} style={S.logRow}>
                  <div style={S.logHead}>
                    <span style={{ ...S.logLevel, color: l.level === 'error' ? '#ff5a6e' : l.level === 'warn' ? '#ffb247' : '#7fbfa0' }}>{l.level}</span>
                    <span style={S.logEvent}>{l.event}</span>
                    <span style={S.logTs}>{new Date(l.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  {l.detail && <div style={S.logDetail}>{l.detail}</div>}
                </div>
              ))}
              <button style={{ ...S.dataBtn, marginTop: 12 }} onClick={onClearLogs}>Clear log</button>
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
