import { describe, it, expect } from 'vitest';
import { FridayStateMachine } from './state-machine.js';

describe('FridayStateMachine', () => {
  it('begins in idle with no turn', () => {
    const sm = new FridayStateMachine();
    expect(sm.phase).toBe('idle');
    expect(sm.snapshot().turnId).toBeNull();
  });

  it('transitions idle -> listening -> transcribing -> thinking -> speaking -> idle', () => {
    const sm = new FridayStateMachine();
    sm.startTurn();
    sm.transition('listening');
    sm.transition('transcribing');
    sm.transition('thinking');
    sm.transition('speaking');
    sm.transition('idle');
    expect(sm.phase).toBe('idle');
  });

  it('rejects illegal transitions', () => {
    const sm = new FridayStateMachine();
    sm.transition('listening');
    expect(() => sm.transition('speaking')).toThrow();
  });

  it('allows interruption from any active phase', () => {
    const sm = new FridayStateMachine();
    sm.startTurn();
    sm.transition('listening');
    sm.transition('transcribing');
    sm.transition('thinking');
    sm.transition('speaking');
    sm.transition('interrupted');
    sm.transition('idle');
    expect(sm.phase).toBe('idle');
  });

  it('emits state events on every mutation', async () => {
    const sm = new FridayStateMachine();
    let count = 0;
    sm.bus.on('state', () => {
      count++;
    });
    sm.startTurn();
    sm.transition('listening');
    sm.appendPartialTranscript('hello');
    sm.appendFinalTranscript('hello');
    await new Promise((r) => setTimeout(r, 5));
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('reset() returns to idle and emits phase event', async () => {
    const sm = new FridayStateMachine();
    sm.startTurn();
    sm.transition('listening');
    let lastPhase: string | null = null;
    sm.bus.on('phase', ({ phase }) => {
      lastPhase = phase;
    });
    sm.reset();
    await new Promise((r) => setTimeout(r, 5));
    expect(sm.phase).toBe('idle');
    expect(lastPhase).toBe('idle');
  });
});
