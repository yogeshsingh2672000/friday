import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useFridayStore } from '../lib/state-store';

const RING_COUNT = 3;

/**
 * Concentric torus rings around the orb. Uses InstancedMesh for a single
 * draw call across all rings; each ring's rotation, scale, and tint is
 * driven by audio levels and phase.
 */
export function Rings() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colors = useMemo(() => {
    const arr = new Float32Array(RING_COUNT * 3);
    const palette = [
      new THREE.Color(0x6df0ff),
      new THREE.Color(0xff7a3d),
      new THREE.Color(0x8a60ff),
      new THREE.Color(0x60ffd0),
      new THREE.Color(0xffd060),
    ];
    for (let i = 0; i < RING_COUNT; i++) {
      const c = palette[i % palette.length]!;
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    return arr;
  }, []);

  const geometry = useMemo(() => new THREE.TorusGeometry(1.8, 0.005, 6, 128), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );

  const rotations = useMemo(
    () =>
      Array.from({ length: RING_COUNT }, (_, i) => ({
        rx: Math.random() * Math.PI,
        ry: Math.random() * Math.PI,
        rz: Math.random() * Math.PI,
        speed: 0.05 + i * 0.04,
        baseScale: 1 + i * 0.18,
      })),
    [],
  );

  useFrame((_state, delta) => {
    if (!meshRef.current) return;
    const s = useFridayStore.getState();
    const energy = 0.3 + s.ttsLevel * 1.5 + s.micLevel * 0.6;
    for (let i = 0; i < RING_COUNT; i++) {
      const r = rotations[i]!;
      r.rx += delta * r.speed;
      r.ry += delta * r.speed * 0.7;
      r.rz += delta * r.speed * 0.4;
      dummy.position.set(0, 0, 0);
      dummy.rotation.set(r.rx, r.ry, r.rz);
      const scale = r.baseScale + energy * 0.15;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      const c = new THREE.Color(colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!);
      c.multiplyScalar(0.5 + energy);
      meshRef.current.setColorAt(i, c);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[geometry, material, RING_COUNT]} frustumCulled={false} />
  );
}
