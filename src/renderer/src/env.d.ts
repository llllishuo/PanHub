import type { PanhubApi } from '../../preload/index.ts';

declare global {
  interface Window {
    panhub: PanhubApi;
  }
}

export {};
