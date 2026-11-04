import { useEffect, useMemo, useRef, useState } from 'react';
import { parseText, type CellValue } from '../parser';
import { compilePattern } from '../parser/custom';
import { useLogStore } from '../store/logStore';
import { formatNumber } from '../utils/format';

const SAMPLE_LINES = 200;
const PREVIEW_ROWS = 6;

const EXAMPLES: { label: string; pattern: string }[] = [
  { label: 'Time level message', pattern: '{time} {level} {message}' },
  { label: 'logback', pattern: '{time} [{thread}] {level} {logger} - {message}' },
  { label: 'Python', pattern: '{time} - {logger} - {level} - {message}' },
  { label: 'Pipe-separated', pattern: '{time} | {level} | {logger} | {message}' },
  { label: 'Request line', pattern: '{time} {ip} {method} {path} {status} {duration}ms' },
];

/** The first lines of the open log, in file order, to try a pattern on. */
function useSampleLines(): string[] {
  const rows = useLogStore((s) => s.rows);
  const malformed = useLogStore((s) => s.malformed);
  return useMemo(() => {
    const entries: { lineNo: number; raw: string }[] = [];
    for (const r of rows.slice(0, SAMPLE_LINES)) entries.push(r);
    for (const m of malformed.slice(0, SAMPLE_LINES)) entries.push(m);
    entries.sort((a, b) => a.lineNo - b.lineNo);
    const lines: string[] = [];
    for (const e of entries) {
      for (const l of e.raw.split('\n')) {
        lines.push(l);
        if (lines.length >= SAMPLE_LINES) return lines;
      }
    }
    return lines;
  }, [rows, malformed]);
}

function show(v: CellValue | undefined, isTime: boolean): string {
  if (v === null || v === undefined) return '';
  if (isTime && typeof v === 'number') return new Date(v).toISOString().replace('T', ' ').replace('Z', '');
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** Describe a log layout with {fields}, preview it on the open file, and re-parse with it. */
export function CustomPatternDialog({ onClose }: { onClose: () => void }) {
  const saved = useLogStore((s) => s.customPattern);
  const setCustomPattern = useLogStore((s) => s.setCustomPattern);
  const [pattern, setPattern] = useState(saved || EXAMPLES[0]!.pattern);
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const sample = useSampleLines();

  useEffect(() => {
    opener.current = document.activeElement;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  const compiled = useMemo(() => compilePattern(pattern), [pattern]);
  const preview = useMemo(() => {
    if (!compiled.ok || sample.length === 0) return null;
    const r = parseText(sample.join('\n'), 'custom', undefined, pattern);
    return { ...r, matched: r.rows.length };
  }, [compiled, pattern, sample]);

  const submit = () => {
    if (!compiled.ok) return;
    setCustomPattern(pattern.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal pattern-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pattern-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter' && e.target === inputRef.current) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <h2 id="pattern-title">Custom log pattern</h2>
        <p className="muted">
          Describe one log line with <code>{'{fields}'}</code>; the text between them must match as written. Names with
          a meaning: <code>{'{time}'}</code> (or <code>{'{date} {time}'}</code>), <code>{'{level}'}</code>,{' '}
          <code>{'{message}'}</code>, <code>{'{logger}'}</code>, <code>{'{status}'}</code>, <code>{'{path}'}</code>,{' '}
          <code>{'{method}'}</code>, <code>{'{ip}'}</code>, <code>{'{duration}'}</code> (ms). Any other name becomes a
          column; <code>{'{_}'}</code> skips text. Lines that don&apos;t match are added to the previous entry (stack
          traces). Advanced: start with <code>^</code> for a regular expression with named groups.
        </p>
        <label htmlFor="pattern-input" className="visually-hidden">
          Pattern
        </label>
        <input
          id="pattern-input"
          ref={inputRef}
          className="mono pattern-input"
          value={pattern}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setPattern(e.target.value)}
          aria-invalid={!compiled.ok}
          aria-describedby="pattern-status"
        />
        <div className="pattern-examples" aria-label="Examples">
          {EXAMPLES.map((ex) => (
            <button key={ex.label} type="button" className="btn small" title={ex.pattern} onClick={() => setPattern(ex.pattern)}>
              {ex.label}
            </button>
          ))}
        </div>
        <p id="pattern-status" className={compiled.ok ? 'muted' : 'error-text'} aria-live="polite">
          {!compiled.ok
            ? compiled.error
            : preview
              ? `${formatNumber(preview.matched)} entries in the first ${formatNumber(sample.length)} lines` +
                (preview.malformed.length ? ` · ${formatNumber(preview.malformed.length)} lines before the first match` : '')
              : 'Open a log to preview the pattern.'}
        </p>
        {preview && preview.rows.length > 0 && (
          <div className="pattern-preview">
            <table>
              <thead>
                <tr>
                  {preview.schema.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, PREVIEW_ROWS).map((r) => (
                  <tr key={r.id}>
                    {preview.schema.map((c) => (
                      <td key={c.key} className="mono">
                        {show(r.values[c.key], c.type === 'timestamp')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="modal-footer">
          <span className="muted">Saved in this browser.</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!compiled.ok} onClick={submit}>
            Use pattern
          </button>
        </div>
      </div>
    </div>
  );
}
