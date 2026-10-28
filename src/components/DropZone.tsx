import { useEffect, useRef, useState } from 'react';
import sampleIis from '../../fixtures/sample-iis.log?raw';
import { ACCEPTED_EXTENSIONS, useLogStore } from '../store/logStore';
import { formatBytes, formatNumber } from '../utils/format';

export function loadSample(): void {
  useLogStore.getState().loadFile(new File([sampleIis], 'sample-iis.log', { type: 'text/plain' }));
}

/** File picker + drag-and-drop target. In compact mode it renders as toolbar buttons. */
export function DropZone({ compact = false }: { compact?: boolean }) {
  const loadFile = useLogStore((s) => s.loadFile);
  const setError = useLogStore((s) => s.setError);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Accept drops anywhere on the window, not only on the visible zone.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      if (files.length > 1) {
        setError('Drop a single file at a time.');
        return;
      }
      loadFile(files[0]!);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [loadFile, setError]);

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPTED_EXTENSIONS.join(',')}
      className="visually-hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) loadFile(f);
        e.target.value = '';
      }}
    />
  );

  const overlay = dragging && (
    <div className="drop-overlay" aria-hidden="true">
      <div>Drop a .log or .txt file to open it</div>
    </div>
  );

  if (compact) {
    return (
      <>
        <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
          Open file…
        </button>
        {input}
        {overlay}
      </>
    );
  }

  return (
    <section className={`dropzone${dragging ? ' dragging' : ''}`} aria-label="Open a log file">
      <svg className="dropzone-icon" viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
        <path
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <h2>Drop a log file here</h2>
      <p className="muted">IIS W3C, Apache/Nginx, JSON lines or plain text logs (.log, .txt). Files are parsed locally and never uploaded.</p>
      <div className="dropzone-actions">
        <button type="button" className="btn primary" onClick={() => inputRef.current?.click()}>
          Choose file…
        </button>
        <button type="button" className="btn" onClick={loadSample}>
          Load sample data
        </button>
      </div>
      {input}
      {overlay}
    </section>
  );
}

export function ParseProgress() {
  const { bytesRead, totalBytes, lines } = useLogStore((s) => s.progress);
  const name = useLogStore((s) => s.file?.name);
  const pct = totalBytes ? Math.round((bytesRead / totalBytes) * 100) : 0;
  return (
    <div className="progress-wrap" role="status" aria-live="polite">
      <div className="progress-label">
        Parsing {name} — {formatBytes(bytesRead)} of {formatBytes(totalBytes)} ({formatNumber(lines)} lines)
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Parse progress"
      >
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
