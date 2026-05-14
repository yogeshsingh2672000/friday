export default /* glsl */ `
uniform float uTime;
uniform float uTtsLevel;
uniform vec3 uColorCool;
uniform vec3 uColorWarm;
uniform vec3 uColorAccent;
uniform float uPhase; // 0 idle, 1 listen, 2 think, 3 speak, 4 alert

varying vec3 vNormal;
varying vec3 vViewPos;
varying float vDisplacement;

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);

  vec3 cool = uColorCool;
  vec3 warm = uColorWarm;
  vec3 accent = uColorAccent;

  // Tint by phase
  float listen = smoothstep(0.5, 1.5, uPhase) - smoothstep(1.5, 2.5, uPhase);
  float think  = smoothstep(1.5, 2.5, uPhase) - smoothstep(2.5, 3.5, uPhase);
  float speak  = smoothstep(2.5, 3.5, uPhase) - smoothstep(3.5, 4.5, uPhase);
  float alert  = smoothstep(3.5, 4.5, uPhase);

  vec3 base = cool;
  base = mix(base, mix(cool, accent, 0.6), listen);
  base = mix(base, warm, think * 0.7);
  base = mix(base, accent, speak * 0.8);
  base = mix(base, vec3(1.0, 0.35, 0.25), alert);

  // Energy band — pulses synced to TTS level
  float band = 0.5 + 0.5 * sin(uTime * 2.0 + vDisplacement * 6.0);
  vec3 energy = mix(base, base + accent * 0.5, band * (0.3 + uTtsLevel * 1.2));

  vec3 col = mix(energy, accent + base * 0.6, fres);
  col += accent * fres * (0.25 + uTtsLevel * 1.0);

  // Inner glow tied to displacement magnitude
  float core = smoothstep(0.0, 0.25, abs(vDisplacement));
  col += base * 0.15 * core;

  // Tighter Reinhard — keeps the orb under the bloom luminance threshold
  // unless the user is actively speaking. Prevents the whole scene from
  // saturating to white during idle.
  col = col / (1.0 + col * 0.45);
  gl_FragColor = vec4(col, 1.0);
}
`;
