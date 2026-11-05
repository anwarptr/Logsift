import type { LiveFileHandle } from './live/watcher';
import { useLogStore } from './store/logStore';

/** The parts of the File Handling API used here (Chromium only; see manifest.webmanifest). */
interface LaunchParams {
  files: readonly LiveFileHandle[];
}
declare global {
  interface Window {
    launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
  }
}

/**
 * Installable-app support: the service worker (public/sw.js) caches the app so it opens offline,
 * and files opened with "Open with → Logsift" from the installed app arrive through launchQueue
 * (as handles, so they are watched for new lines like a live tail).
 * The service worker is registered in production builds only, so development always runs fresh code.
 */
export function setUpApp(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // Not fatal: the app works without it, just not offline.
      });
    });
  }
  window.launchQueue?.setConsumer(async ({ files }) => {
    if (files.length === 0) return;
    await useLogStore.getState().openFileHandles([...files]);
  });
}
