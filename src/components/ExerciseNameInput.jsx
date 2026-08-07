import { useState } from 'react';
import { S } from '../styles';

// Exercise name field with typeahead over names already in the log.
//
// A custom dropdown rather than a native <input list="…"> / <datalist>: iOS
// Safari renders datalist inconsistently (often not at all), and picking an
// option there fires only a change event, so there is no way to distinguish a
// deliberate selection from ordinary typing. That distinction is the whole
// point here — selecting a known exercise is what lets the caller resolve its
// modality and units.
//
// Candidates arrive already ordered by most recent use (getExerciseNames), and
// that order is kept: class programming repeats, so recency beats the alphabet.
function ExerciseNameInput({ value, names, guessed, onChange, onPick }) {
  const [open, setOpen] = useState(false);

  const q = (value || '').trim().toLowerCase();
  const matches = open && q.length >= 2
    ? names.filter((n) => {
        const l = n.toLowerCase();
        return l.includes(q) && l !== q;   // hide the row once it's an exact match
      }).slice(0, 6)
    : [];

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <input
        style={{ ...S.exName, ...(guessed ? S.exNameGuess : {}), width: '100%' }}
        placeholder="Exercise name"
        value={value}
        autoComplete="off"
        onChange={(e) => { setOpen(true); onChange(e.target.value); }}
        onFocus={() => setOpen(true)}
        // Delay so a tap on a suggestion registers before blur tears the list
        // down. onMouseDown below covers pointer devices; this covers touch.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {matches.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4,
          background: '#13151b', border: '1px solid #2a2e38', borderRadius: 8,
          overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}>
          {matches.map((n) => (
            <button
              key={n}
              onMouseDown={(e) => e.preventDefault()}   // keep focus so blur doesn't fire first
              onClick={() => { setOpen(false); onPick(n); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                background: 'transparent', border: 'none', borderBottom: '1px solid #1d2027',
                color: '#e7e9ee', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer',
              }}
            >{n}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export { ExerciseNameInput };
