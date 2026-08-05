import { useState } from 'react';
import { epley } from '../lib/metrics';
import { fmtSeconds, fmtDist } from '../lib/helpers';
import { ACCENT } from '../styles';

// Stated with no exception clause on purpose: combined and per-hand never
// actually diverge (a one-arm row with a 30kg dumbbell moves 30kg either way),
// so an unconditional rule removes a judgement call at the moment of entry.
const WEIGHT_CONVENTION =
  'Log the total weight moved. Two 20kg dumbbells is 40kg. One 30kg dumbbell is 30kg. A 40kg barbell is 40kg.\n\n' +
  'For single-arm or single-leg work, log each side as its own set — 8 left and 8 right is two sets of 8, not one set of 16.';

// Tap-to-toggle hint for a set-column header. Hover is useless on a phone, so
// this is an explicit tap target. The popover is positioned against the header
// row (which sets position:relative), so it spans the card width and can never
// overflow the screen regardless of which column it is anchored to.
function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Logging convention"
        style={{ background: 'none', border: 'none', color: open ? ACCENT : '#6b7080', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, padding: '0 4px', lineHeight: 1 }}
      >ⓘ</button>
      {open && (
        <span
          onClick={() => setOpen(false)}
          style={{ position: 'absolute', top: 18, left: 0, right: 0, zIndex: 20, background: '#13151b', border: '1px solid #2a2e38', borderRadius: 8, padding: '11px 13px', fontSize: 11, lineHeight: 1.65, color: '#cfd3dc', letterSpacing: 0, whiteSpace: 'pre-line', textAlign: 'left', boxShadow: '0 6px 20px rgba(0,0,0,0.55)', cursor: 'pointer' }}
        >{text}</span>
      )}
    </>
  );
}

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
      {mod === 'distance'   && <><div style={{ color: '#d7ff32'  }}>Best set: <b>{fmtDist(d.bestDist)}</b></div><div style={{ color: '#6b9fff' }}>Total: <b>{fmtDist(d.totalDist)}</b></div>{d.paceSecPerKm != null && <div style={{ color: '#ffb247' }}>Pace: <b>{fmtSeconds(d.paceSecPerKm)} /km</b></div>}</>}
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

export { CombinedTooltip, ScatterTooltip, InfoTip, WEIGHT_CONVENTION };
