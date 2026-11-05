import sampleDocker from '../fixtures/sample-docker.log?raw';
import sampleEventlog from '../fixtures/sample-eventlog.xml?raw';
import sampleFreb from '../fixtures/sample-freb.xml?raw';
import sampleIis from '../fixtures/sample-iis.log?raw';
import sampleLogback from '../fixtures/sample-logback.log?raw';
import sampleLogfmt from '../fixtures/sample-logfmt.log?raw';
import samplePino from '../fixtures/sample-pino.log?raw';
import samplePython from '../fixtures/sample-python.log?raw';
import sampleSerilog from '../fixtures/sample-serilog.log?raw';
import sampleSyslog from '../fixtures/sample-syslog.log?raw';
import sampleCsv from '../fixtures/sample.csv?raw';
import { createLiveDemo, DEMO_FILE, DEMO_INCIDENT_MS, generateIncidentLog } from './demo';
import { useLogStore } from './store/logStore';

/** Small example logs, one per kind, bundled into the app (they are fake data). */
export const SAMPLES: { id: string; label: string; file: string; text: string }[] = [
  { id: 'iis', label: 'IIS web server', file: 'sample-iis.log', text: sampleIis },
  { id: 'serilog', label: 'ASP.NET Core (Serilog)', file: 'sample-serilog.log', text: sampleSerilog },
  { id: 'python', label: 'Python logging', file: 'sample-python.log', text: samplePython },
  { id: 'logback', label: 'Java (logback)', file: 'sample-logback.log', text: sampleLogback },
  { id: 'pino', label: 'Node.js (pino JSON)', file: 'sample-pino.log', text: samplePino },
  { id: 'docker', label: 'Docker container', file: 'sample-docker.log', text: sampleDocker },
  { id: 'logfmt', label: 'Go (logfmt)', file: 'sample-logfmt.log', text: sampleLogfmt },
  { id: 'eventlog', label: 'Windows Event Log', file: 'sample-eventlog.xml', text: sampleEventlog },
  { id: 'freb', label: 'IIS failed request trace', file: 'sample-freb.xml', text: sampleFreb },
  { id: 'syslog', label: 'Linux syslog', file: 'sample-syslog.log', text: sampleSyslog },
  { id: 'csv', label: 'CSV export', file: 'sample.csv', text: sampleCsv },
];

export function loadSampleById(id: string): void {
  const s = SAMPLES.find((x) => x.id === id);
  if (s) useLogStore.getState().loadFile(new File([s.text], s.file, { type: 'text/plain' }));
}

/** Run `then` once the log being opened has finished loading. */
function whenReady(then: () => void): void {
  const unsubscribe = useLogStore.subscribe((s) => {
    if (s.status === 'ready') {
      unsubscribe();
      then();
    } else if (s.status === 'error') {
      unsubscribe();
    }
  });
}

/**
 * The incident demo: two hours of an API's log where payments start failing half an hour ago,
 * opened in the Compare tab with "before / after" set to when the trouble started.
 */
export function openIncidentDemo(): void {
  const now = Date.now();
  const store = useLogStore.getState();
  store.loadFile(new File([generateIncidentLog(now)], 'incident-demo.log', { type: 'text/plain', lastModified: now }));
  whenReady(() => {
    const s = useLogStore.getState();
    s.setCompare({ preset: 'split', splitAt: now - DEMO_INCIDENT_MS });
    s.setTab('compare');
  });
}

let liveDemo: { stop(): void } | null = null;

/** The live demo: the incident log, still being written to, watched with live tail. */
export function startLiveDemo(): void {
  liveDemo?.stop();
  const demo = createLiveDemo();
  liveDemo = demo;
  void useLogStore.getState().openFileHandles([demo.handle]);
  // Stop writing once the demo is no longer watched (Stop, or another log opened).
  let started = false;
  const unsubscribe = useLogStore.subscribe((s) => {
    if (s.live?.label === DEMO_FILE) started = true;
    else if (started || (s.status === 'error' && !s.live)) {
      unsubscribe();
      demo.stop();
      if (liveDemo === demo) liveDemo = null;
    }
  });
}
