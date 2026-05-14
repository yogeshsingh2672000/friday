import { useFridayStore } from '../lib/state-store';

export function StatusBar() {
  const phase = useFridayStore((s) => s.phase);
  const connected = useFridayStore((s) => s.connected);
  const micLevel = useFridayStore((s) => s.micLevel);
  const ttsLevel = useFridayStore((s) => s.ttsLevel);

  return (
    <div className="pane status">
      <h3>FRIDAY</h3>
      <div className="row">
        <span className={`dot ${connected ? 'connected' : 'disconnected'}`} />
        <span style={{ opacity: 0.7 }}>{connected ? 'Linked' : 'Reconnecting…'}</span>
      </div>
      <div className={`phase-pill ${phase}`}>
        <span className="dot" /> {phase.replace('_', ' ')}
      </div>
      <div className="level-meter">
        <span>MIC</span>
        <div className="bar"><div className="fill" style={{ width: `${Math.min(100, micLevel * 600)}%` }} /></div>
      </div>
      <div className="level-meter">
        <span>TTS</span>
        <div className="bar"><div className="fill" style={{ width: `${Math.min(100, ttsLevel * 300)}%` }} /></div>
      </div>
    </div>
  );
}
