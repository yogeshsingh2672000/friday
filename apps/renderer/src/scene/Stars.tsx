import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * Distant starfield. Static buffer geometry — no per-frame work.
 */
export function Stars() {
  const { geometry, material } = useMemo(() => {
    const count = 250;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Sphere of radius 30 around camera
      const r = 25 + Math.random() * 15;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      sizes[i] = Math.random() < 0.05 ? 2.5 : 1.2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const m = new THREE.PointsMaterial({
      size: 0.04,
      color: 0xa8c8ff,
      transparent: true,
      opacity: 0.55,
      sizeAttenuation: true,
      depthWrite: false,
    });
    return { geometry: g, material: m };
  }, []);

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
