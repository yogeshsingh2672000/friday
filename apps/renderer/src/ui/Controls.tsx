import { useState } from 'react';
import { useFridayStore } from '../lib/state-store';
import type { Controller } from '../lib/controller';

export function Controls({ controller }: { controller: Controller | null }) {
  const phase = useFridayStore((s) => s.phase);
  const [textOpen, setTextOpen] = useState(false);
  const [text, setText] = useState('');

  return (
    <div className="controls">
      <button
        onClick={() => controller?.manualTrigger()}
        disabled={!controller || phase === 'listening' || phase === 'transcribing'}
        title="Manual wake (Space)"
      >
        Wake
      </button>
      <button
        className="danger"
        onClick={() => controller?.interrupt()}
        disabled={!controller || phase === 'idle'}
        title="Stop (Esc)"
      >
        Stop
      </button>
      <button onClick={() => setTextOpen((v) => !v)}>Text</button>
      <button onClick={() => controller?.reset()} title="Reset session">Reset</button>
      {textOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            controller?.sendText(text);
            setText('');
            setTextOpen(false);
          }}
          style={{ display: 'flex', gap: 6, marginLeft: 8 }}
        >
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type to Friday…"
            style={{
              pointerEvents: 'auto',
              background: 'rgba(8, 18, 36, 0.6)',
              color: '#cfe9ff',
              border: '1px solid rgba(109, 240, 255, 0.35)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 12,
              minWidth: 280,
              fontFamily: 'inherit',
            }}
          />
        </form>
      )}
    </div>
  );
}
