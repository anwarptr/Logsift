/**
 * Module spans of one IIS failed request, read back from the event timeline text the FREB parser
 * stores as the row's raw text ("04:48:28.868 +12 ms  NOTIFY_MODULE_START" lines, then indented
 * "Key: value" lines). Done on demand for the one row being looked at, so loading costs nothing.
 */

export interface ModuleSpan {
  module: string;
  /** IIS pipeline stage, e.g. BEGIN_REQUEST, EXECUTE_REQUEST_HANDLER. */
  notification: string;
  /** Offsets from the first event, in ms. */
  start: number;
  end: number;
}

export interface RequestWaterfall {
  spans: ModuleSpan[];
  /** Offset of the last event (ms). */
  totalMs: number;
  events: number;
  /** Module that set the error status, if any. */
  errorModule: string | null;
}

const EVENT_RE = /^(?:\S+ \+(\d+) ms)?  (\S+)(?: \[\w+\])?$/;
const DATA_RE = /^ {4}(\w+): (.*)$/;

export function frebWaterfall(timeline: string): RequestWaterfall {
  const events: { at: number; name: string; data: Record<string, string> }[] = [];
  for (const line of timeline.split('\n')) {
    const e = EVENT_RE.exec(line);
    if (e) {
      events.push({ at: e[1] === undefined ? 0 : +e[1], name: e[2]!, data: {} });
      continue;
    }
    const d = DATA_RE.exec(line);
    if (d && events.length > 0) events[events.length - 1]!.data[d[1]!] = d[2]!;
  }
  const open = new Map<string, number[]>();
  const spans: ModuleSpan[] = [];
  let errorModule: string | null = null;
  for (const ev of events) {
    const module = ev.data.ModuleName;
    if (ev.name === 'MODULE_SET_RESPONSE_ERROR_STATUS' && module) errorModule = module;
    if (!module || (ev.name !== 'NOTIFY_MODULE_START' && ev.name !== 'NOTIFY_MODULE_END')) continue;
    const key = `${module}\u0000${ev.data.Notification ?? ''}`;
    if (ev.name === 'NOTIFY_MODULE_START') {
      const stack = open.get(key) ?? [];
      stack.push(ev.at);
      open.set(key, stack);
    } else {
      const start = open.get(key)?.pop();
      if (start !== undefined) spans.push({ module, notification: ev.data.Notification ?? '', start, end: ev.at });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return { spans, totalMs: events.length ? Math.max(...events.map((e) => e.at)) : 0, events: events.length, errorModule };
}
