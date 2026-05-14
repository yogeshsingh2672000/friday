import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { AdaptiveDpr, AdaptiveEvents, PerformanceMonitor } from '@react-three/drei';
import { KernelSize } from 'postprocessing';
import { Core } from './Core';
import { Particles } from './Particles';
import { Rings } from './Rings';
import { Stars } from './Stars';

/**
 * Scene root. Tuned for integrated GPUs:
 *   - dpr pinned to 1 by default; PerformanceMonitor pushes it up only if
 *     framerate stays above 55fps for a while.
 *   - Single Bloom pass with SMALL kernel and a high luminance threshold so
 *     the orb pops without washing out the screen.
 *   - No ChromaticAberration (was crashing the effect chain on some setups
 *     and adds significant cost). Vignette only.
 *   - AdaptiveDpr drops pixel ratio when frame rate dips during interaction.
 */
export function Scene() {
  const [dpr, setDpr] = useState(1);

  return (
    <Canvas
      gl={{
        antialias: true,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        depth: true,
      }}
      dpr={dpr}
      camera={{ position: [0, 0, 4.5], fov: 35, near: 0.1, far: 100 }}
      style={{ position: 'fixed', inset: 0, background: '#000' }}
      frameloop="always"
    >
      <PerformanceMonitor
        onIncline={() => setDpr(Math.min(1.5, window.devicePixelRatio))}
        onDecline={() => setDpr(1)}
        flipflops={3}
        onFallback={() => setDpr(1)}
      />
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />

      <color attach="background" args={['#020308']} />
      <Stars />
      <Rings />
      <Particles />
      <Core />
      <ambientLight intensity={0.25} />
      <pointLight position={[3, 4, 3]} intensity={0.8} />

      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom
          intensity={0.55}
          luminanceThreshold={0.55}
          luminanceSmoothing={0.25}
          kernelSize={KernelSize.SMALL}
          mipmapBlur={false}
        />
        <Vignette eskil={false} offset={0.25} darkness={0.8} />
      </EffectComposer>
    </Canvas>
  );
}
