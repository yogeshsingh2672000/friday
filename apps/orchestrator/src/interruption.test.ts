import { describe, it, expect } from 'vitest';
import { InterruptionManager } from './interruption.js';

describe('InterruptionManager', () => {
  it('arms then fires, cancelling the token', () => {
    const im = new InterruptionManager();
    const token = im.arm('turn-1');
    expect(token.isCancelled).toBe(false);
    expect(im.fire('user_voice')).toBe(true);
    expect(token.isCancelled).toBe(true);
    expect(token.reason).toBe('user_voice');
  });

  it('fire() is a no-op when nothing is armed', () => {
    const im = new InterruptionManager();
    expect(im.fire('manual')).toBe(false);
  });

  it('arm() while a turn is active cancels the previous turn', () => {
    const im = new InterruptionManager();
    const t1 = im.arm('turn-1');
    const t2 = im.arm('turn-2');
    expect(t1.isCancelled).toBe(true);
    expect(t1.reason).toBe('superseded');
    expect(t2.isCancelled).toBe(false);
    expect(im.armedTurnId).toBe('turn-2');
  });

  it('disarm() clears the armed slot without firing', () => {
    const im = new InterruptionManager();
    const t = im.arm('turn-1');
    im.disarm('turn-1');
    expect(t.isCancelled).toBe(false);
    expect(im.armedTurnId).toBeNull();
  });

  it('disarm() ignores stale ids', () => {
    const im = new InterruptionManager();
    im.arm('turn-1');
    im.disarm('turn-2');
    expect(im.armedTurnId).toBe('turn-1');
  });
});
