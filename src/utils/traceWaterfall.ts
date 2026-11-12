import type { CellValue, LogRow } from '../parser';
import { formatNumber, formatTimestamp } from './format';
import { type DisplayZone, UTC_ZONE } from './timezone';

export const ROOT_TRACE_KEYS = [
  'trace-id',
  'traceid',
  'trace_id',
  'operation_id',
  'operationid',
  'operation-id',
  '@tr',
  'traceparent',
  'x-amzn-trace-id',
  'requestid',
  'request_id',
  'x-request-id',
  'correlationid',
  'correlation_id',
  'x-b3-traceid',
  'uber-trace-id',
];

export const SPAN_KEYS = [
  'spanid',
  'span_id',
  'operation_parentid',
  'operationparentid',
  '@sp',
];

export const TRACE_KEYS = [...ROOT_TRACE_KEYS, ...SPAN_KEYS];
const TRACE_KEY_SET = new Set(TRACE_KEYS);

/** Extract the normalized trace ID from W3C traceparent, AWS Root, or raw string. */
export function normalizeTraceId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';

  // W3C traceparent format: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
  const w3cMatch = /^00-([0-9a-fA-F]{32})-[0-9a-fA-F]{16}-[0-9a-fA-F]{2}$/.exec(s);
  if (w3cMatch) return w3cMatch[1]!.toLowerCase();

  // AWS X-Ray format: Root=1-5759e988-bd862e3fe1be46a994272793;Parent=...
  const awsMatch = /Root=([^;]+)/i.exec(s);
  if (awsMatch) return awsMatch[1]!.trim();

  // Jaeger / Uber trace ID: <trace-id>:<span-id>:<parent-span-id>:<flags>
  if (s.includes(':') && /^[0-9a-fA-F]{16,32}:/.test(s)) {
    return s.split(':')[0]!.toLowerCase();
  }

  return s;
}

/** Find the first trace entry in a row's values, prioritizing root trace IDs over span IDs. */
export function extractTraceEntry(values: Record<string, CellValue>): [string, string] | null {
  const entries = Object.entries(values);
  for (const [k, v] of entries) {
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
    if (s && ROOT_TRACE_KEYS.includes(k.toLowerCase())) {
      return [k, s];
    }
  }
  for (const [k, v] of entries) {
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
    if (s && SPAN_KEYS.includes(k.toLowerCase())) {
      return [k, s];
    }
  }
  return null;
}

export interface TraceSpan {
  rowId: number;
  lineNo: number;
  ts: number | null;
  startOffsetMs: number;
  durationMs: number;
  isPointInTime: boolean;
  service: string;
  action: string;
  status: number | null;
  level: string | null;
  isError: boolean;
  raw: string;
}

export interface TraceWaterfallData {
  traceKey: string;
  traceId: string;
  spans: TraceSpan[];
  totalDurationMs: number;
  startTs: number | null;
  endTs: number | null;
  services: string[];
  errorCount: number;
}

/** Check whether a row has an error status or error log level. */
export function isRowError(r: LogRow): boolean {
  const st = Number(
    r.values['sc-status'] ??
      r.values.status ??
      r.values.statusCode ??
      r.values.status_code ??
      r.values.resultCode ??
      r.values.resultcode,
  );
  if (Number.isFinite(st) && st >= 400) return true;
  if (r.values.success === false || r.values.success === 'False' || r.values.success === 'false') return true;
  const lv = String(r.values.level ?? r.values.severity ?? r.values.lvl ?? r.values.loglevel ?? '').toLowerCase();
  return lv.startsWith('err') || lv.startsWith('fatal') || lv.startsWith('crit');
}

/** Extract explicit duration in milliseconds if present in the row. */
export function extractRowDuration(r: LogRow): number | null {
  const candidates = [
    r.values['time-taken'],
    r.values.duration,
    r.values.durationMs,
    r.values.duration_ms,
    r.values.elapsed,
    r.values.elapsedMs,
    r.values.elapsed_ms,
    r.values.latency,
    r.values.latencyMs,
    r.values.latency_ms,
    r.values.responseTime,
    r.values.response_time,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c;
    if (typeof c === 'string') {
      const parsed = parseFloat(c);
      if (Number.isFinite(parsed) && parsed >= 0) {
        if (c.endsWith('s') && !c.endsWith('ms')) return Math.round(parsed * 1000);
        return Math.round(parsed);
      }
    }
  }
  return null;
}

/** Build distributed trace waterfall data from all rows matching the given trace ID. */
export function buildTraceWaterfallData(
  rows: readonly LogRow[],
  targetTraceVal: string,
  keyName = 'trace_id',
): TraceWaterfallData | null {
  const normTarget = normalizeTraceId(targetTraceVal);
  if (!normTarget) return null;

  const matchedRows: LogRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    for (const [k, v] of Object.entries(r.values)) {
      if (TRACE_KEY_SET.has(k.toLowerCase())) {
        const strVal = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
        if (strVal && normalizeTraceId(strVal) === normTarget) {
          matchedRows.push(r);
          break;
        }
      }
    }
  }

  if (matchedRows.length === 0) return null;

  // Sort chronologically by timestamp (fallback to row ID)
  matchedRows.sort((a, b) => {
    if (a.ts !== null && b.ts !== null) return a.ts - b.ts || a.id - b.id;
    if (a.ts !== null) return -1;
    if (b.ts !== null) return 1;
    return a.id - b.id;
  });

  const timestamps = matchedRows.map((r) => r.ts).filter((t): t is number => t !== null);
  const minTs = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : null;

  const servicesSet = new Set<string>();
  let errorCount = 0;

  const spans: TraceSpan[] = matchedRows.map((r, i) => {
    const startOffsetMs = minTs !== null && r.ts !== null ? Math.max(0, r.ts - minTs) : i * 10;
    const explicitDuration = extractRowDuration(r);
    const durationMs = explicitDuration !== null ? explicitDuration : 0;
    const isPointInTime = explicitDuration === null;

    const service = String(
      r.values.service ??
        r.values.app ??
        r.values.application ??
        r.values.cloud_RoleName ??
        r.values.cloud_rolename ??
        r.values.roleName ??
        r.values.sourceFile ??
        r.values.logFormat ??
        'Service',
    );
    servicesSet.add(service);

    // Human readable action
    let action = '';
    const method = r.values['cs-method'] ?? r.values.method;
    const uri = r.values['cs-uri-stem'] ?? r.values.uri ?? r.values.url;
    if (method && uri) {
      action = `${method} ${uri}`;
    } else if (typeof r.values.name === 'string' && r.values.name.trim().length > 0) {
      action = r.values.name.trim();
    } else if (typeof r.values.operation_Name === 'string' && r.values.operation_Name.trim().length > 0) {
      action = r.values.operation_Name.trim();
    } else if (typeof r.values.message === 'string' && r.values.message.trim().length > 0) {
      action = r.values.message.split('\n')[0]!.trim();
    } else if (typeof r.values.msg === 'string' && r.values.msg.trim().length > 0) {
      action = r.values.msg.split('\n')[0]!.trim();
    } else {
      action = r.raw.slice(0, 90).trim();
    }

    const st = Number(
      r.values['sc-status'] ??
        r.values.status ??
        r.values.statusCode ??
        r.values.status_code ??
        r.values.resultCode ??
        r.values.resultcode,
    );
    const status = Number.isFinite(st) ? st : null;
    const lv = r.values.level ?? r.values.severity ?? r.values.lvl;
    const level = typeof lv === 'string' ? lv.toUpperCase() : null;

    const isError = isRowError(r);
    if (isError) errorCount++;

    return {
      rowId: r.id,
      lineNo: r.lineNo,
      ts: r.ts,
      startOffsetMs,
      durationMs,
      isPointInTime,
      service,
      action,
      status,
      level,
      isError,
      raw: r.raw,
    };
  });

  // Calculate total duration (the furthest reaching span end)
  const totalDurationMs = Math.max(
    1,
    ...spans.map((s) => s.startOffsetMs + s.durationMs),
  );

  return {
    traceKey: keyName,
    traceId: targetTraceVal,
    spans,
    totalDurationMs,
    startTs: minTs,
    endTs: maxTs,
    services: Array.from(servicesSet),
    errorCount,
  };
}

/** Format trace waterfall data as a clean Markdown table. */
export function traceToMarkdown(data: TraceWaterfallData, zone: DisplayZone = UTC_ZONE): string {
  const lines: string[] = [];
  lines.push(`### Distributed Trace: \`${data.traceId}\``);
  lines.push(`- **Events:** ${data.spans.length}`);
  lines.push(`- **Services:** ${data.services.join(', ')}`);
  lines.push(`- **Total Duration:** ${formatNumber(data.totalDurationMs)} ms`);
  if (data.startTs !== null && data.endTs !== null) {
    lines.push(`- **Time:** ${formatTimestamp(data.startTs, zone)} → ${formatTimestamp(data.endTs, zone)}`);
  }
  if (data.errorCount > 0) {
    lines.push(`- **Errors:** ${data.errorCount}`);
  }
  lines.push('');
  lines.push('| Offset | Duration | Service | Action / Message | Status / Level | Line |');
  lines.push('| ---: | ---: | :--- | :--- | :--- | ---: |');
  for (const s of data.spans) {
    const durStr = s.durationMs > 0 ? `${formatNumber(s.durationMs)} ms` : '-';
    const stStr = s.status ? String(s.status) : s.level ? s.level : '-';
    const actionEsc = s.action.replace(/\|/g, '\\|');
    lines.push(`| +${formatNumber(s.startOffsetMs)} ms | ${durStr} | ${s.service} | ${actionEsc} | ${stStr} | ${s.lineNo} |`);
  }
  return lines.join('\n');
}
