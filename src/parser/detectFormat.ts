import { APACHE_LINE_RE } from './apache';
import { isSyslogLine } from './syslog';
import type { LogFormat } from './types';

const SAMPLE_SIZE = 50;
const MATCH_RATIO = 0.6;

function isJsonObject(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('{')) return false;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** Whether text starts like an XML document (used to reject XML that is not a FREB trace). */
export function looksLikeXml(lines: readonly string[]): boolean {
  const first = lines.find((l) => l.trim().length > 0)?.trimStart() ?? '';
  return first.startsWith('<?xml') || /^<[A-Za-z][\w:.-]*[\s>/]/.test(first);
}

/** Guess the log format from the first lines of a file. */
export function detectFormat(lines: readonly string[]): LogFormat {
  const sample: string[] = [];
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    sample.push(l.charCodeAt(0) === 0xfeff ? l.slice(1) : l);
    if (sample.length >= SAMPLE_SIZE) break;
  }
  if (sample.length === 0) return 'generic';
  if (sample.some((l) => l.startsWith('#Software:') || l.startsWith('#Fields:'))) return 'iis';
  if (sample.some((l) => l.trimStart().startsWith('<failedRequest'))) return 'freb';
  if (looksLikeXml(sample) && sample.some((l) => /<Event[\s>]/.test(l))) return 'winevent';

  const ratio = (pred: (l: string) => boolean) => sample.filter(pred).length / sample.length;
  if (ratio((l) => APACHE_LINE_RE.test(l)) >= MATCH_RATIO) return 'apache';
  if (ratio(isJsonObject) >= MATCH_RATIO) return 'jsonl';
  if (ratio(isSyslogLine) >= MATCH_RATIO) return 'syslog';
  // IIS data without headers is not supported; everything else falls back to generic text.
  return 'generic';
}
