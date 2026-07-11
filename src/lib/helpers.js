// Shared pure helpers — ids, unit conversion, formatting, model-output parsing.
import { logEvent } from '../db';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

// Parse model output that SHOULD be bare JSON but may carry fences, a prose
// preamble, or trailing text. Last resort: slice first '['/'{' to last ']'/'}'.
// Returns null if nothing parseable (e.g. truncated output).
function parseModelJSON(text) {
  const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const ai = clean.indexOf('['), oi = clean.indexOf('{');
  const arrayRooted = ai > -1 && (oi === -1 || ai < oi);
  if (arrayRooted) {
    // Prose around an intact array
    const b = clean.lastIndexOf(']');
    if (b > ai) { try { return JSON.parse(clean.slice(ai, b + 1)); } catch { /* next */ } }
    // Truncated array (e.g. max_tokens cutoff): keep every complete element,
    // drop the cut one, close the bracket. Partial read beats total failure.
    const lastObj = clean.lastIndexOf('}');
    if (lastObj > ai) { try { return JSON.parse(clean.slice(ai, lastObj + 1) + ']'); } catch { /* next */ } }
  } else if (oi > -1) {
    const b = clean.lastIndexOf('}');
    if (b > oi) { try { return JSON.parse(clean.slice(oi, b + 1)); } catch { /* next */ } }
  }
  return null;
}

// One automatic retry with a short pause — covers transient 429/529 and the
// occasional malformed sample without user intervention.
async function withRetry(fn, label) {
  try { return await fn(); }
  catch (e) {
    logEvent('warn', label + '_retrying', e.message);
    await new Promise((r) => setTimeout(r, 800));
    return fn();
  }
}

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

export { uid, LB_TO_KG, toKg, toMeters, fmtDist, secToInput, parseModelJSON, withRetry, fmtSeconds, parseSeconds };
