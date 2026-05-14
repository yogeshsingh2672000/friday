import { create } from 'zustand';
import type { FridayPhase, ToolCallSummary } from '@friday/shared';

export interface UICard {
  id: string;
  kind: 'card' | 'list' | 'image';
  title?: string;
  body?: string;
  items?: string[];
  url?: string;
  tone?: 'info' | 'warn' | 'success' | 'error';
  createdAt: number;
}

export interface FridayUIState {
  connected: boolean;
  phase: FridayPhase;
  partial: string;
  finalTurns: { turnId: string; text: string }[];
  assistantStreaming: string;
  assistantTurns: { turnId: string; text: string }[];
  tools: ToolCallSummary[];
  micLevel: number;
  ttsLevel: number;
  scenePreset: 'calm' | 'alert' | 'focused' | 'celebrate';
  cards: UICard[];
  lastError: string | null;
  // mutators
  setConnected: (v: boolean) => void;
  setPhase: (p: FridayPhase) => void;
  setPartial: (t: string) => void;
  pushFinal: (turnId: string, text: string) => void;
  appendAssistantDelta: (turnId: string, t: string) => void;
  completeAssistant: (turnId: string, t: string) => void;
  upsertTool: (t: ToolCallSummary) => void;
  setMicLevel: (l: number) => void;
  setTtsLevel: (l: number) => void;
  setScene: (p: 'calm' | 'alert' | 'focused' | 'celebrate') => void;
  pushCard: (c: UICard) => void;
  clearCards: (id?: string) => void;
  setError: (m: string | null) => void;
  reset: () => void;
}

export const useFridayStore = create<FridayUIState>((set) => ({
  connected: false,
  phase: 'idle',
  partial: '',
  finalTurns: [],
  assistantStreaming: '',
  assistantTurns: [],
  tools: [],
  micLevel: 0,
  ttsLevel: 0,
  scenePreset: 'calm',
  cards: [],
  lastError: null,
  setConnected: (v) => set({ connected: v }),
  setPhase: (p) => set({ phase: p }),
  setPartial: (t) => set({ partial: t }),
  pushFinal: (turnId, text) =>
    set((s) => ({
      finalTurns: [...s.finalTurns.slice(-50), { turnId, text }],
      partial: '',
    })),
  appendAssistantDelta: (_turnId, t) =>
    set((s) => ({ assistantStreaming: s.assistantStreaming + t })),
  completeAssistant: (turnId, text) =>
    set((s) => ({
      assistantStreaming: '',
      assistantTurns: [...s.assistantTurns.slice(-50), { turnId, text }],
    })),
  upsertTool: (t) =>
    set((s) => {
      const idx = s.tools.findIndex((x) => x.id === t.id);
      const next = [...s.tools];
      if (idx >= 0) next[idx] = t;
      else next.push(t);
      return { tools: next.slice(-20) };
    }),
  setMicLevel: (l) => set({ micLevel: l }),
  setTtsLevel: (l) => set({ ttsLevel: l }),
  setScene: (p) => set({ scenePreset: p }),
  pushCard: (c) => set((s) => ({ cards: [...s.cards.slice(-8), c] })),
  clearCards: (id) =>
    set((s) => ({ cards: id ? s.cards.filter((c) => c.id !== id) : [] })),
  setError: (m) => set({ lastError: m }),
  reset: () =>
    set({
      partial: '',
      finalTurns: [],
      assistantStreaming: '',
      assistantTurns: [],
      tools: [],
      cards: [],
      lastError: null,
    }),
}));
