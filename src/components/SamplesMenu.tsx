import { useEffect, useRef, useState } from 'react';
import { loadSampleById, openIncidentDemo, SAMPLES, startLiveDemo } from '../samples';

/** "More samples": the demos and one small example log per kind. */
export function SamplesMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    <div className="popover-root" ref={rootRef}>
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        More samples <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="popover samples-menu" role="menu" aria-label="Samples">
          <p className="samples-group">Demos</p>
          <button type="button" role="menuitem" className="samples-item" onClick={pick(openIncidentDemo)}>
            <b>Find what broke</b>
            <span className="muted">An API whose payments started failing: opens in Compare</span>
          </button>
          <button type="button" role="menuitem" className="samples-item" onClick={pick(startLiveDemo)}>
            <b>Watch a log live</b>
            <span className="muted">The same API, still writing new lines every second</span>
          </button>
          <p className="samples-group">One log of each kind</p>
          {SAMPLES.map((s) => (
            <button key={s.id} type="button" role="menuitem" className="samples-item" onClick={pick(() => loadSampleById(s.id))}>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
