import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatNumber } from '../utils/format';

/** Counts lines without splitting, so large pastes stay cheap to re-render. */
function countLines(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Modal with a textarea for pasting log text instead of opening a file. */
export function PasteDialog({ onClose }: { onClose: () => void }) {
  const loadText = useLogStore((s) => s.loadText);
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    textareaRef.current?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  const lines = countLines(text);
  const submit = () => {
    if (text.trim() === '') return;
    loadText(text);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal paste-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <h2 id="paste-title">Paste log text</h2>
        <p className="muted">
          Any supported format: IIS (include the <code>#Fields:</code> line), Apache/Nginx, JSON lines or plain text.
          The text is parsed locally.
        </p>
        <label htmlFor="paste-text" className="visually-hidden">
          Log text
        </label>
        <textarea
          id="paste-text"
          ref={textareaRef}
          value={text}
          spellCheck={false}
          wrap="off"
          placeholder="Paste log lines here (Ctrl+V)"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="modal-footer">
          <span className="muted" aria-live="polite">
            {formatNumber(lines)} {lines === 1 ? 'line' : 'lines'}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={text.trim() === ''} onClick={submit}>
            Parse text
          </button>
        </div>
      </div>
    </div>
  );
}
