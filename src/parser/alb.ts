import { parseLooseIso } from './generic';
import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
import type { CellValue, ColumnDef, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/**
 * AWS Application Load Balancer (ALB) and Classic/Network Elastic Load Balancer (ELB) access logs:
 *
 * ALB:
 *   type time elb client:port target:port request_processing_time target_processing_time response_processing_time
 *   elb_status_code target_status_code received_bytes sent_bytes "request" "user_agent" ssl_cipher ssl_protocol
 *   target_group_arn "trace_id" "domain_name" "chosen_cert_arn" matched_rule_priority request_creation_time
 *   "actions_executed" "redirect_url" "error_reason" ...
 *
 * Classic ELB:
 *   time elb client:port target:port request_processing_time target_processing_time response_processing_time
 *   elb_status_code target_status_code received_bytes sent_bytes "request" "user_agent" ssl_cipher ssl_protocol
 */

export const ALB_TYPE_RE = /^(?:h2|http|https|ws|wss|grpc)$/;

/** Split space-delimited text respecting double-quoted fields with backslash-escaping. */
export function splitQuotedSpaces(line: string): string[] {
  const parts: string[] = [];
  let i = 0;
  const len = line.length;
  while (i < len) {
    while (i < len && line[i] === ' ') i++;
    if (i >= len) break;
    if (line[i] === '"') {
      i++; // skip open quote
      let token = '';
      while (i < len) {
        if (line[i] === '"') {
          i++; // skip close quote
          break;
        }
        if (line[i] === '\\' && i + 1 < len) {
          token += line[i + 1];
          i += 2;
        } else {
          token += line[i];
          i++;
        }
      }
      parts.push(token);
    } else {
      let token = '';
      while (i < len && line[i] !== ' ') {
        token += line[i];
        i++;
      }
      parts.push(token);
    }
  }
  return parts;
}

const dash = (s: string | null | undefined): string | null => (s === undefined || s === null || s === '-' || s === '' ? null : s);

const num = (s: string | null | undefined): number | null => {
  const d = dash(s);
  if (d === null) return null;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
};

/** Parse request line into method, stem, query, version. */
export function parseAlbRequest(request: string): {
  method: string | null;
  stem: string | null;
  query: string | null;
  version: string | null;
} {
  const trimmed = request.trim();
  if (!trimmed || trimmed === '-' || trimmed.split(/\s+/).every((p) => p === '-')) {
    return { method: null, stem: null, query: null, version: null };
  }
  const parts = trimmed.split(' ');
  let method: string | null = null;
  let rawUrl: string | null = trimmed;
  let version: string | null = null;
  if (parts.length >= 3) {
    method = parts[0]!;
    rawUrl = parts.slice(1, -1).join(' ');
    version = parts[parts.length - 1]!;
  } else if (parts.length === 2) {
    method = parts[0]!;
    rawUrl = parts[1]!;
  }
  let stem = rawUrl;
  let query: string | null = null;
  try {
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      const u = new URL(rawUrl);
      stem = u.pathname;
      if (u.search) query = u.search.slice(1);
    }
  } catch {
    // fall through to query index check
  }
  if (!query && stem.includes('?')) {
    const q = stem.indexOf('?');
    query = stem.slice(q + 1) || null;
    stem = stem.slice(0, q);
  }
  return { method: dash(method), stem: dash(stem), query: dash(query), version: dash(version) };
}

const BASE_COLUMNS: ColumnDef[] = [
  TIMESTAMP_COLUMN,
  { key: 'type', label: 'type', type: 'string' },
  { key: 'elb', label: 'elb', type: 'string', role: 'site' },
  { key: 'c-ip', label: 'c-ip', type: 'string', role: 'clientIp' },
  { key: 'c-port', label: 'c-port', type: 'number' },
  { key: 'target', label: 'target', type: 'string' },
  { key: 'cs-method', label: 'cs-method', type: 'string', role: 'method' },
  { key: 'cs-uri-stem', label: 'cs-uri-stem', type: 'string', role: 'uri' },
  { key: 'cs-uri-query', label: 'cs-uri-query', type: 'string', role: 'uriQuery' },
  { key: 'sc-status', label: 'sc-status', type: 'number', role: 'status' },
  { key: 'target-status', label: 'target-status', type: 'number' },
  { key: 'time-taken', label: 'time-taken', type: 'number', role: 'duration' },
  { key: 'request-time', label: 'request-time', type: 'number' },
  { key: 'target-time', label: 'target-time', type: 'number' },
  { key: 'response-time', label: 'response-time', type: 'number' },
  { key: 'cs-bytes', label: 'cs-bytes', type: 'number', role: 'bytesReceived' },
  { key: 'sc-bytes', label: 'sc-bytes', type: 'number', role: 'bytesSent' },
  { key: 'cs(User-Agent)', label: 'cs(User-Agent)', type: 'string', role: 'userAgent' },
  { key: 'domain-name', label: 'domain-name', type: 'string', role: 'host' },
  { key: 'trace-id', label: 'trace-id', type: 'string' },
  { key: 'error-reason', label: 'error-reason', type: 'string', role: 'message' },
  { key: 'target-group-arn', label: 'target-group-arn', type: 'string' },
  { key: 'ssl-cipher', label: 'ssl-cipher', type: 'string' },
  { key: 'ssl-protocol', label: 'ssl-protocol', type: 'string' },
  { key: 'cs-version', label: 'cs-version', type: 'string' },
];

export function createAlbParser(): LineParser {
  const schema = new SchemaBuilder();
  BASE_COLUMNS.forEach((c) => schema.add(c));
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let rowId = 0;
  let malformedId = 0;
  const zones = new OffsetTracker();

  function pushLine(line: string, lineNo: number): void {
    if (line.trim().length === 0) return;
    const tokens = splitQuotedSpaces(line);
    if (tokens.length < 12) {
      malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'Line has too few fields for ALB/ELB' });
      return;
    }

    const hasType = ALB_TYPE_RE.test(tokens[0]!);
    const offset = hasType ? 1 : 0;
    const type = hasType ? tokens[0]! : 'http';
    const rawTime = tokens[offset]!;
    const ts = parseLooseIso(rawTime);
    if (ts === null) {
      malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'Invalid timestamp' });
      return;
    }
    const zone = parseZoneSuffix(rawTime);
    if (zone !== null) zones.observe(zone);

    const elb = tokens[offset + 1]!;
    const client = tokens[offset + 2] ?? '';
    const colon = client.lastIndexOf(':');
    const clientIp = colon >= 0 ? client.slice(0, colon) : client;
    const clientPort = colon >= 0 ? Number(client.slice(colon + 1)) : null;

    const target = dash(tokens[offset + 3]);
    const reqSec = num(tokens[offset + 4]);
    const targetSec = num(tokens[offset + 5]);
    const respSec = num(tokens[offset + 6]);

    // Compute total latency in milliseconds (times are seconds in AWS logs, -1 when timed out/disconnected).
    let timeTakenMs: number | null = null;
    if (targetSec !== null && targetSec >= 0) {
      const totalSec = Math.max(0, reqSec ?? 0) + targetSec + Math.max(0, respSec ?? 0);
      timeTakenMs = Math.round(totalSec * 10000) / 10;
    } else if (reqSec !== null && reqSec >= 0) {
      timeTakenMs = Math.round(reqSec * 10000) / 10;
    }

    const elbStatus = num(tokens[offset + 7]);
    const targetStatus = num(tokens[offset + 8]);
    const receivedBytes = num(tokens[offset + 9]);
    const sentBytes = num(tokens[offset + 10]);
    const request = tokens[offset + 11] ?? '';
    const userAgent = dash(tokens[offset + 12]);
    const sslCipher = dash(tokens[offset + 13]);
    const sslProtocol = dash(tokens[offset + 14]);
    const targetGroupArn = dash(tokens[offset + 15]);
    const traceId = dash(tokens[offset + 16]);
    const domainName = dash(tokens[offset + 17]);
    // Extra ALB fields
    const errorReason = dash(tokens[offset + 23]);

    const req = parseAlbRequest(request);

    const values: Record<string, CellValue> = {
      timestamp: ts,
      type,
      elb,
      'c-ip': clientIp || null,
      'c-port': Number.isFinite(clientPort) ? clientPort : null,
      target,
      'cs-method': req.method,
      'cs-uri-stem': req.stem,
      'cs-uri-query': req.query,
      'sc-status': elbStatus,
      'target-status': targetStatus,
      'time-taken': timeTakenMs,
      'request-time': reqSec,
      'target-time': targetSec,
      'response-time': respSec,
      'cs-bytes': receivedBytes,
      'sc-bytes': sentBytes,
      'cs(User-Agent)': userAgent,
      'domain-name': domainName,
      'trace-id': traceId,
      'error-reason': errorReason,
      'target-group-arn': targetGroupArn,
      'ssl-cipher': sslCipher,
      'ssl-protocol': sslProtocol,
      'cs-version': req.version,
    };

    rows.push({ id: rowId++, lineNo, ts, values, raw: line });
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta: [] };
    rows = [];
    malformed = [];
    return out;
  }

  return { format: 'alb', pushLine, drain, finish: drain, schema: () => schema.list(), timeZone: () => zones.result() };
}
