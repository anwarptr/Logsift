import { useEffect, useMemo, useRef, useState } from 'react';
import { FORMAT_LABELS } from '../parser';
import { useLogStore } from '../store/logStore';
import { useSampleLines } from '../store/useSampleLines';
import { redactLines } from '../utils/redact';

export const ISSUES_URL = 'https://github.com/anwarptr/Logsift/issues/new';
const SAMPLE_LINES = 15;
/** GitHub rejects very long URLs (and percent-encoding makes log text up to 3× longer): cut the body to fit. */
export const MAX_URL_LENGTH = 7000;

/** Build the "new issue" URL for a parsing problem report, cutting the body so the encoded URL fits. */
export function issueUrl(title: string, body: string): string {
  const build = (b: string) => `${ISSUES_URL}?${new URLSearchParams({ title, body: b }).toString()}`;
  let url = build(body);
  if (url.length <= MAX_URL_LENGTH) return url;
  const cut = (n: number) => `${body.slice(0, n)}\n…(cut)\n\`\`\`\n`;
  // Longest prefix of the body that fits (binary search on its length).
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(cut(mid)).length <= MAX_URL_LENGTH) lo = mid;
    else hi = mid - 1;
  }
  url = build(cut(lo));
  return url;
}

/**
 * Report a log that Logsift reads wrongly: shows the first lines with IPs, e-mails, GUIDs and
 * tokens masked, lets the user edit them, then opens a GitHub issue with them. Nothing is sent
 * from here: the text goes into GitHub's form, where the user reviews and submits it.
 */
export function ReportDialog({ onClose }: { onClose: () => void }) {
  const format = useLogStore((s) => s.format);
  const detected = useLogStore((s) => s.detectedFormat);
  const override = useLogStore((s) => s.formatOverride);
  const rowCount = useLogStore((s) => s.rows.length);
  const malformedCount = useLogStore((s) => s.malformed.length);
  const sample = useSampleLines(SAMPLE_LINES);
  const masked = useMemo(() => redactLines(sample).join('\n'), [sample]);
  const [lines, setLines] = useState(masked);
  const [problem, setProblem] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    textRef.current?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  const formatText = format
    ? `${FORMAT_LABELS[format]}${override !== 'auto' && detected ? ` (chosen; detected ${FORMAT_LABELS[detected]})` : ' (detected)'}`
    : 'unknown';
  const body = [
    '**What is wrong**',
    problem.trim() || '_Describe what Logsift shows and what you expected (e.g. "the level column is empty")._',
    '',
    `**Format:** ${formatText} · ${rowCount} rows, ${malformedCount} malformed`,
    '',
    '**Sample lines** (masked by Logsift: IPs, e-mails, GUIDs and tokens replaced)',
    '```text',
    lines,
    '```',
    '',
  ].join('\n');
  const title = `Log not read correctly${format ? ` (${FORMAT_LABELS[format]})` : ''}`;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="report-title">Report a log that isn&apos;t read correctly</h2>
        <p className="muted">
          This opens a new GitHub issue with the lines below, so the format can be added. IP addresses, e-mail
          addresses, GUIDs and tokens are already masked: <b>check the lines and remove anything private</b>. Nothing is
          sent until you submit the issue on GitHub.
        </p>
        <label htmlFor="report-problem">What is wrong? (optional)</label>
        <input
          id="report-problem"
          className="pattern-input"
          value={problem}
          placeholder="e.g. the level column is empty, or every line is malformed"
          onChange={(e) => setProblem(e.target.value)}
        />
        <label htmlFor="report-lines">Sample lines</label>
        <textarea
          id="report-lines"
          ref={textRef}
          className="report-lines"
          value={lines}
          spellCheck={false}
          wrap="off"
          onChange={(e) => setLines(e.target.value)}
        />
        <div className="modal-footer">
          <span className="muted">Format: {formatText}</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <a
            className="btn primary"
            href={issueUrl(title, body)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setTimeout(onClose, 0)}
          >
            Open GitHub issue ↗
          </a>
        </div>
      </div>
    </div>
  );
}
