import { useFridayStore } from '../lib/state-store';

export function Transcript() {
  const partial = useFridayStore((s) => s.partial);
  const finalTurns = useFridayStore((s) => s.finalTurns);
  const streaming = useFridayStore((s) => s.assistantStreaming);
  const phase = useFridayStore((s) => s.phase);

  const lastFinal = finalTurns[finalTurns.length - 1];

  // Show what's relevant for the current phase
  let primary: { kind: 'user' | 'assistant' | 'partial'; text: string } | null = null;
  if (phase === 'listening' || phase === 'transcribing') {
    if (partial) primary = { kind: 'partial', text: partial };
    else if (lastFinal) primary = { kind: 'user', text: lastFinal.text };
  } else if (phase === 'thinking' || phase === 'tool_calling' || phase === 'speaking') {
    if (streaming) primary = { kind: 'assistant', text: streaming };
    else if (lastFinal) primary = { kind: 'user', text: lastFinal.text };
  } else if (phase === 'idle') {
    if (streaming) primary = { kind: 'assistant', text: streaming };
  }

  if (!primary) return null;

  return (
    <div className="pane transcript">
      <div className={primary.kind}>{primary.text}</div>
    </div>
  );
}
