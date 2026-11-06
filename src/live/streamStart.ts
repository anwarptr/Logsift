import { useSyncExternalStore } from 'react';
import { useLogStore } from '../store/logStore';
import { openStream, streamParams, type LogStream } from './streamSource';

/**
 * Opens the launcher's stream when the page was opened by `npx logsifter`, and tells the user while it
 * waits for the first lines and when the stream ends.
 */

let waitingFor: string | null = null;
const listeners = new Set<() => void>();
const setWaiting = (name: string | null) => {
  waitingFor = name;
  for (const l of listeners) l();
};

/** The stream's name while waiting for its first lines, else null. */
export function useStreamWaiting(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => waitingFor,
  );
}

export function startStreamFromLocation(loc: { hostname: string; search: string } = location): LogStream | null {
  const params = streamParams(loc);
  if (!params) return null;
  const stream = openStream(params.path, params.fileName);
  setWaiting(params.fileName);
  void stream.firstData.then(() => {
    setWaiting(null);
    const store = useLogStore.getState();
    if (stream.bytes > 0) void store.openFileHandles([stream.handle]);
    else if (stream.state === 'ended') store.setError('The command ended without writing any lines.');
  });
  stream.onEnd((state, error) => {
    const store = useLogStore.getState();
    if (stream.bytes === 0) {
      if (state === 'failed') store.setError(`Could not read the log stream from logsift in the terminal (${error}). Is it still running?`);
      return;
    }
    // Live tail keeps showing what arrived; say why nothing more comes (once it is watching).
    const notice =
      state === 'ended'
        ? 'The command in the terminal ended: no more lines will arrive.'
        : 'Lost the connection to logsift in the terminal (was it stopped?). The lines received are still here.';
    whenLive(() => useLogStore.getState().setLiveNotice(notice));
  });
  return stream;
}

/** Run `then` once the stream is being watched (it may end before it was opened). */
function whenLive(then: () => void): void {
  if (useLogStore.getState().live) return then();
  const unsubscribe = useLogStore.subscribe((s) => {
    if (s.live) {
      unsubscribe();
      then();
    } else if (s.status === 'error') {
      unsubscribe();
    }
  });
}
