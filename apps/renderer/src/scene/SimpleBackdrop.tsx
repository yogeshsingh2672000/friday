import { useFridayStore } from '../lib/state-store';

/**
 * Lightweight CSS-only "presence" — a pulsing radial-gradient orb on a soft
 * vignette background. Reacts to phase + mic/tts levels via inline styles.
 * Costs effectively zero GPU work compared to the Three.js scene.
 *
 * The cinematic Scene.tsx (+ Core/Particles/Rings/Stars/shaders) is still in
 * the repo for when the hardware can take it; swap the import in App.tsx to
 * bring it back.
 */
const PHASE_COLOR: Record<string, string> = {
  idle: '#6df0ff',
  listening: '#6df0ff',
  transcribing: '#aef0ff',
  thinking: '#ffb070',
  tool_calling: '#c9a0ff',
  speaking: '#ff9966',
  interrupted: '#ffe080',
  error: '#ff5050',
};

export function SimpleBackdrop() {
  const phase = useFridayStore((s) => s.phase);
  const mic = useFridayStore((s) => s.micLevel);
  const tts = useFridayStore((s) => s.ttsLevel);

  const color = PHASE_COLOR[phase] ?? '#6df0ff';
  const energy = Math.min(0.35, Math.max(mic * 2.5, tts * 2.2));
  const scale = 1 + energy;
  const glow = 60 + energy * 220;
  const ringOpacity = phase === 'idle' ? 0.18 : 0.32;

  return (
    <div className="backdrop">
      <div className="backdrop-stars" aria-hidden />
      <div
        className={`backdrop-orb phase-${phase}`}
        style={{
          transform: `translate(-50%, -50%) scale(${scale})`,
          boxShadow: `0 0 ${glow}px ${glow * 0.35}px ${color}aa, 0 0 ${glow * 2}px ${glow * 0.8}px ${color}22`,
          background: `radial-gradient(circle at 38% 36%, ${color} 0%, #163048 55%, #050b14 80%)`,
        }}
      />
      <div
        className="backdrop-ring"
        style={{
          borderColor: color,
          opacity: ringOpacity,
          transform: `translate(-50%, -50%) scale(${1.6 + energy * 0.4})`,
        }}
      />
      <div
        className="backdrop-ring outer"
        style={{
          borderColor: color,
          opacity: ringOpacity * 0.6,
          transform: `translate(-50%, -50%) scale(${2.4 + energy * 0.6})`,
        }}
      />
    </div>
  );
}
