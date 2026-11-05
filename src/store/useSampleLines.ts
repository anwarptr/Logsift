import { useMemo } from 'react';
import { useLogStore } from './logStore';

/** The first `max` lines of the open log, in file order (rows and malformed lines, stack traces included). */
export function useSampleLines(max: number): string[] {
  const rows = useLogStore((s) => s.rows);
  const malformed = useLogStore((s) => s.malformed);
  return useMemo(() => {
    const entries: { lineNo: number; raw: string; file?: string }[] = [];
    for (const r of rows.slice(0, max)) entries.push(r);
    for (const m of malformed.slice(0, max)) entries.push(m);
    entries.sort((a, b) => a.lineNo - b.lineNo);
    const lines: string[] = [];
    for (const e of entries) {
      for (const l of e.raw.split('\n')) {
        lines.push(l);
        if (lines.length >= max) return lines;
      }
    }
    return lines;
  }, [rows, malformed, max]);
}
