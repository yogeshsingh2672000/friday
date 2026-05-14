import { useEffect, useState } from 'react';
// Lightweight CSS-only presence for low-end hardware. To switch back to the
// Three.js cinematic scene, change this import to `./scene/Scene` (the
// component name `Scene` is preserved by the alias below).
import { SimpleBackdrop as Scene } from './scene/SimpleBackdrop';
import { StatusBar } from './ui/StatusBar';
import { Transcript } from './ui/Transcript';
import { ToolFeed } from './ui/ToolFeed';
import { Cards } from './ui/Cards';
import { Controls } from './ui/Controls';
import { Controller } from './lib/controller';
import { useFridayStore } from './lib/state-store';
import './ui/styles.css';

/**
 * The orchestrator URL. Reads VITE_ORCHESTRATOR_URL if set, otherwise defaults
 * to the local loopback the orchestrator listens on. In a deployment scenario,
 * set VITE_ORCHESTRATOR_URL=wss://your-domain at build time.
 */
const DEFAULT_WS_URL =
  (import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined) ?? 'ws://127.0.0.1:8787';

export function App() {
  const [controller, setController] = useState<Controller | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const error = useFridayStore((s) => s.lastError);

  // Bootstrap the WS + audio pipeline. This effect is StrictMode-safe — the
  // cleanup disposes the in-flight Controller so React's intentional double-
  // invoke in dev doesn't leave an orphan WebSocket. Each effect run creates
  // its own Controller; only the survivor reaches setController.
  useEffect(() => {
    let cancelled = false;
    let ctrl: Controller | null = null;

    (async () => {
      const orchestratorUrl = DEFAULT_WS_URL;
      const accessKey =
        (import.meta.env.VITE_PICOVOICE_ACCESS_KEY as string | undefined) ?? '';
      const keyword =
        (import.meta.env.VITE_PORCUPINE_KEYWORD as string | undefined) ?? 'jarvis';
      const ttsMode = ((import.meta.env.VITE_TTS_MODE as string | undefined) ?? 'browser') as
        | 'browser'
        | 'server';
      const ttsVoiceURI = (import.meta.env.VITE_TTS_VOICE as string | undefined) ?? undefined;

      console.log(
        '[bootstrap] orchestrator URL =', orchestratorUrl,
        '| wake key set:', !!accessKey,
        '| tts mode:', ttsMode,
      );
      ctrl = new Controller({ orchestratorUrl, accessKey, keyword, ttsMode, ttsVoiceURI });
      try {
        await ctrl.start();
      } catch (err) {
        if (!cancelled) setBootError((err as Error).message);
        await ctrl.stop().catch(() => {});
        return;
      }
      if (cancelled) {
        await ctrl.stop().catch(() => {});
        return;
      }
      setController(ctrl);
    })();

    return () => {
      cancelled = true;
      const dying = ctrl;
      ctrl = null;
      void dying?.stop().catch(() => {});
    };
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!controller) return;
    const onKey = (e: KeyboardEvent) => {
      // Avoid hijacking typing inputs.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        controller.manualTrigger();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        controller.interrupt();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  return (
    <>
      <Scene />
      <div className="hud">
        <StatusBar />
        <ToolFeed />
        <Transcript />
        <Cards />
        <Controls controller={controller} />
      </div>
      {(bootError || error) && (
        <div className="error-banner">
          {bootError ?? error}
        </div>
      )}
    </>
  );
}
