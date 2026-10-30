import { attributes, decodeXml, LEVEL_NAMES } from './freb';
import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
import type { CellValue, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/*
 * Windows Event Log exported as XML: <Events><Event><System>…</System><EventData>…</EventData></Event>…
 * (Event Viewer's "Save as XML", wevtutil, Azure App Service's LogFiles/eventlog.xml). Events may share
 * a line or span several, so text is buffered until each </Event>. One event is one row.
 */

const EVENT_START_RE = /<Event[\s>]/;
const EVENT_END = '</Event>';
const DATA_RE = /<Data\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Data>)/g;
const TAG_RE = /<[^>]+>/g;

const tagText = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]!) : undefined;
};
const tagAttrs = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
  return m ? attributes(m[0]) : {};
};

const KEY_ROLES: Record<string, ColumnRole> = {
  level: 'level',
  provider: 'logger',
  computer: 'host',
  message: 'message',
};

/**
 * The event's text: the rendered message when the export has one; otherwise its data values,
 * unnamed ones as they are and named ones as "Name: value"; otherwise the text of UserData.
 */
function messageOf(xml: string): string | null {
  const rendered = tagText(xml, 'Message');
  if (rendered?.trim()) return rendered.trim();
  const parts: string[] = [];
  for (const m of xml.matchAll(DATA_RE)) {
    const v = decodeXml(m[2] ?? '').trim();
    if (!v) continue;
    const name = attributes(m[1]!).Name;
    parts.push(name ? `${name}: ${v}` : v);
  }
  if (parts.length > 0) return parts.join('\n');
  const user = tagText(xml, 'UserData');
  const text = user && user.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

const toNumber = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function createWinEventParser(): LineParser {
  const schema = new SchemaBuilder();
  const zones = new OffsetTracker();
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let rowId = 0;
  let malformedId = 0;
  /** Text not yet consumed, and the line number its first character is on. */
  let buf = '';
  let bufLine = 1;

  function readEvent(xml: string, lineNo: number): void {
    const values: Record<string, CellValue> = {};
    const set = (key: string, v: CellValue) => {
      schema.observe(key, v, KEY_ROLES[key]);
      values[key] = v;
    };
    const time = tagAttrs(xml, 'TimeCreated').SystemTime;
    const parsed = time ? Date.parse(time) : NaN;
    const ts = Number.isNaN(parsed) ? null : parsed;
    if (time && ts !== null) zones.observe(parseZoneSuffix(time));
    schema.add(TIMESTAMP_COLUMN);
    values.timestamp = ts;

    // Level 0 ("log always") is shown as Information by Event Viewer.
    const level = toNumber(tagText(xml, 'Level'));
    const renderedLevel = /<RenderingInfo\b[\s\S]*?<Level>([^<]*)<\/Level>/.exec(xml)?.[1]?.trim();
    set('level', renderedLevel || (level === null ? null : LEVEL_NAMES[level] || 'Information'));
    const provider = tagAttrs(xml, 'Provider');
    set('provider', provider.Name || provider.EventSourceName || null);
    set('eventId', toNumber(tagText(xml, 'EventID')));
    set('message', messageOf(xml));
    // Optional fields get a column only once some event has them (exports differ).
    const opt = (key: string, v: CellValue) => {
      if (v !== null) set(key, v);
    };
    opt('channel', tagText(xml, 'Channel')?.trim() || null);
    opt('computer', tagText(xml, 'Computer')?.trim() || null);
    opt('processId', toNumber(tagAttrs(xml, 'Execution').ProcessID));
    opt('recordId', toNumber(tagText(xml, 'EventRecordID')));
    rows.push({ id: rowId++, lineNo, ts, values, raw: xml });
  }

  /** Read every complete event in the buffer; keep the rest. */
  function consume(): void {
    for (;;) {
      const start = buf.search(EVENT_START_RE);
      if (start < 0) {
        skip(buf);
        return;
      }
      const end = buf.indexOf(EVENT_END, start);
      if (end < 0) {
        skip(buf.slice(0, start));
        return;
      }
      skip(buf.slice(0, start));
      const len = end - start + EVENT_END.length;
      readEvent(buf.slice(0, len), bufLine);
      advance(len);
    }
  }

  /** Drop the first `n` characters of the buffer, keeping the line count right. */
  function advance(n: number): void {
    for (let i = buf.indexOf('\n'); i >= 0 && i < n; i = buf.indexOf('\n', i + 1)) bufLine++;
    buf = buf.slice(n);
  }

  /** Text between events: the <Events> wrapper, XML declaration and comments are fine; anything else is not. */
  function skip(text: string): void {
    const rest = text.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/?Events\b[^>]*>/g, '').trim();
    if (rest && !rest.startsWith('<')) malformed.push({ id: malformedId++, lineNo: bufLine, raw: rest.slice(0, 2000), reason: 'Not part of an event' });
    advance(text.length);
  }

  function pushLine(line: string, lineNo: number): void {
    if (buf === '') bufLine = lineNo;
    buf += line + '\n';
    if (line.includes(EVENT_END) || !EVENT_START_RE.test(buf)) consume();
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta: [] };
    rows = [];
    malformed = [];
    return out;
  }

  /** Called at the end of every file: an event left open there is incomplete. */
  function finish(): ParsedChunk {
    consume();
    if (buf.trim()) {
      malformed.push({ id: malformedId++, lineNo: bufLine, raw: buf.slice(0, 2000), reason: 'Incomplete event (no closing </Event>)' });
    }
    buf = '';
    return drain();
  }

  return { format: 'winevent', pushLine, drain, finish, schema: () => schema.list(), timeZone: () => zones.result() };
}
