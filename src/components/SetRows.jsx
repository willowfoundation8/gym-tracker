import { useState, useEffect } from 'react';
import { secToInput, parseSeconds } from '../lib/helpers';
import { S } from '../styles';

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

// Optional mm:ss time, shared by distance + loaded_distance. Same raw-string-
// while-typing / commit-on-blur pattern as SetRowDuration, with one difference:
// a blank field commits null, so an optional time can be cleared again.
function TimeInput({ s, onUpdate }) {
  const [raw, setRaw] = useState(secToInput(s.seconds));
  useEffect(() => { setRaw(secToInput(s.seconds)); }, [s.seconds]);
  return (
    <input
      style={S.setInput}
      type="text"
      inputMode="numeric"
      placeholder="mm:ss"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => onUpdate({ seconds: parseSeconds(raw) })}
    />
  );
}

function SetRowDistance({ s, onUpdate, num, parseNum }) {
  return (
    <>
      <input style={S.setInput} type="number" inputMode="decimal" placeholder="dist" value={num(s.distance)} onChange={(e) => onUpdate({ distance: parseNum(e.target.value) })} />
      <button style={S.unitBtn} onClick={() => onUpdate({ distUnit: s.distUnit === 'm' ? 'km' : 'm' })}>{s.distUnit || 'm'}</button>
      <TimeInput s={s} onUpdate={onUpdate} />
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
      <TimeInput s={s} onUpdate={onUpdate} />
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
  distance:        ['#', 'distance', 'unit', 'time', ''],
  loaded_distance: ['#', 'weight', 'unit', 'dist', 'unit', 'time', ''],
  duration:        ['#', 'time (mm:ss)', ''],
  cardio:          ['#', 'dist', 'unit', 'time', 'resist', ''],
};

export { SetRowStrength, SetRowBodyweight, SetRowDistance, SetRowLoadedDistance, SetRowDuration, SetRowCardio, SET_HEADERS };
