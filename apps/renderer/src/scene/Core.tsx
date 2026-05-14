import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import vert from './shaders/orb.vert';
import frag from './shaders/orb.frag';
import { useFridayStore } from '../lib/state-store';

const PHASE_TO_FLOAT: Record<string, number> = {
  idle: 0,
  listening: 1,
  transcribing: 1.5,
  thinking: 2,
  tool_calling: 2.5,
  speaking: 3,
  interrupted: 0.5,
  error: 4,
};

/**
 * The central orb. IcosahedronGeometry (detail=6) gives a smooth sphere with
 * ~10k verts — enough for noise displacement without melting GPUs. Shader-side
 * 3D simplex noise drives the surface deformation; phase + audio levels
 * modulate amplitude and color.
 */
export function Core() {
  const meshRef = useRef<THREE.Mesh | null>(null);

  // detail=4 ≈ 640 verts; previously detail=6 was ~5120. The fragment shader
  // does most of the visual work; we don't need a dense mesh for noise.
  const geometry = useMemo(() => new THREE.IcosahedronGeometry(1, 4), []);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uTime: { value: 0 },
          uAmplitude: { value: 0.05 },
          uMicLevel: { value: 0 },
          uTtsLevel: { value: 0 },
          uColorCool: { value: new THREE.Color(0x0a3a72) },
          uColorWarm: { value: new THREE.Color(0xff7a3d) },
          uColorAccent: { value: new THREE.Color(0x6df0ff) },
          uPhase: { value: 0 },
        },
        transparent: false,
      }),
    [],
  );
  useFrame((_state, delta) => {
    const u = material.uniforms;
    u.uTime.value += delta;
    const s = useFridayStore.getState();
    // Smooth-follow levels to avoid jitter
    u.uMicLevel.value = lerp(u.uMicLevel.value, s.micLevel, 0.2);
    u.uTtsLevel.value = lerp(u.uTtsLevel.value, s.ttsLevel, 0.25);
    u.uPhase.value = lerp(u.uPhase.value, PHASE_TO_FLOAT[s.phase] ?? 0, 0.08);

    // Phase-driven idle amplitude
    const baseAmp = s.phase === 'idle' ? 0.04 : s.phase === 'listening' ? 0.08 : 0.06;
    u.uAmplitude.value = lerp(u.uAmplitude.value, baseAmp + s.micLevel * 0.2 + s.ttsLevel * 0.4, 0.1);

    // Mood palette
    const cool = sceneColorCool(s.scenePreset);
    const warm = sceneColorWarm(s.scenePreset);
    const accent = sceneColorAccent(s.scenePreset);
    (u.uColorCool.value as THREE.Color).lerp(cool, 0.05);
    (u.uColorWarm.value as THREE.Color).lerp(warm, 0.05);
    (u.uColorAccent.value as THREE.Color).lerp(accent, 0.05);

    // Slow rotation for life
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.15;
      meshRef.current.rotation.x += delta * 0.05;
    }
  });

  return <mesh ref={meshRef} geometry={geometry} material={material} />;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

function sceneColorCool(p: string): THREE.Color {
  switch (p) {
    case 'alert':
      return new THREE.Color(0x4a0a0a);
    case 'focused':
      return new THREE.Color(0x0a1530);
    case 'celebrate':
      return new THREE.Color(0x2a0a4a);
    default:
      return new THREE.Color(0x0a3a72);
  }
}
function sceneColorWarm(p: string): THREE.Color {
  switch (p) {
    case 'alert':
      return new THREE.Color(0xff4030);
    case 'celebrate':
      return new THREE.Color(0xffa840);
    default:
      return new THREE.Color(0xff7a3d);
  }
}
function sceneColorAccent(p: string): THREE.Color {
  switch (p) {
    case 'alert':
      return new THREE.Color(0xffd040);
    case 'focused':
      return new THREE.Color(0x60ffd0);
    case 'celebrate':
      return new THREE.Color(0xff60d0);
    default:
      return new THREE.Color(0x6df0ff);
  }
}
