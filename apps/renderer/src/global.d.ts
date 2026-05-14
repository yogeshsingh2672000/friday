/// <reference types="vite/client" />

import type {} from 'react';

declare global {
  interface FridayBootstrap {
    orchestratorUrl: string;
    appVersion: string;
    displaySize: { width: number; height: number };
  }

  interface FridayPreloadAPI {
    bootstrap(): Promise<FridayBootstrap>;
    setFullscreen(flag: boolean): Promise<boolean>;
    minimize(): Promise<void>;
    close(): Promise<void>;
    reload(): Promise<void>;
    toggleDevTools(): Promise<boolean>;
  }

  interface Window {
    friday?: FridayPreloadAPI;
    __FRIDAY_PICOVOICE_KEY__?: string;
  }
}

export {};
