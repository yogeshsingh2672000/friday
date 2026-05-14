/**
 * PCM utilities — encoding, decoding, resampling, level metering.
 * Pure functions, safe in both browser and Node.
 */

export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i]!;
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = Math.max(-1, Math.min(1, input[i]!));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/**
 * Linear resampling — sufficient for downsampling 44.1/48 kHz mic input to
 * 16 kHz for STT. Not perfect (no anti-aliasing) but cheap and bounded.
 */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIdx - i0;
    out[i] = input[i0]! * (1 - t) + input[i1]! * t;
  }
  return out;
}

/**
 * RMS level of an Int16 frame, normalised to [0, 1].
 */
export function rmsLevel(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]! / 0x8000;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

// Base64 helpers are isomorphic — they live in @friday/shared and are
// re-exported here for ergonomic browser-side imports.
export { int16ToBase64, base64ToInt16 } from '@friday/shared';
