import { epley } from '../lib/metrics';
import { fmtSeconds, fmtDist } from '../lib/helpers';

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

export { CombinedTooltip, ScatterTooltip };
