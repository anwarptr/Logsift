import { APACHE_LINE_RE } from './apache';
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

  const ratio = (pred: (l: string) => boolean) => sample.filter(pred).length / sample.length;
  if (ratio((l) => APACHE_LINE_RE.test(l)) >= MATCH_RATIO) return 'apache';
  if (ratio(isJsonObject) >= MATCH_RATIO) return 'jsonl';
  // IIS data without headers is not supported; everything else falls back to generic text.
  return 'generic';
}
