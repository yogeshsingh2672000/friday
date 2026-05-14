import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import vert from './shaders/particles.vert';
import frag from './shaders/particles.frag';
import { useFridayStore } from '../lib/state-store';

const COUNT = 450;

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
 * Orbiting particle halo around the core orb. All attributes are pre-baked
 * into BufferAttributes — no per-frame allocations. The shader handles motion.
 */
export function Particles() {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(COUNT * 3);
    const randoms = new Float32Array(COUNT);
    const speeds = new Float32Array(COUNT);
    const colors = new Float32Array(COUNT * 3);

    const palette = [
      new THREE.Color(0x6df0ff),
      new THREE.Color(0xffa040),
      new THREE.Color(0x8a60ff),
      new THREE.Color(0x60ffd0),
      new THREE.Color(0xffffff),
    ];

    for (let i = 0; i < COUNT; i++) {
      // Distribute on a thick spherical shell
      const radius = 1.6 + Math.random() * 1.1;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      randoms[i] = Math.random();
      speeds[i] = 0.4 + Math.random() * 1.4;
      const c = palette[Math.floor(Math.random() * palette.length)]!;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 1));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    return g;
  }, []);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: 4.0 },
          uMicLevel: { value: 0 },
          uTtsLevel: { value: 0 },
          uPhase: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useFrame((_state, delta) => {
    const u = material.uniforms;
    u.uTime.value += delta;
    const s = useFridayStore.getState();
    u.uMicLevel.value = lerp(u.uMicLevel.value, s.micLevel, 0.2);
    u.uTtsLevel.value = lerp(u.uTtsLevel.value, s.ttsLevel, 0.2);
    u.uPhase.value = lerp(u.uPhase.value, PHASE_TO_FLOAT[s.phase] ?? 0, 0.06);
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}
