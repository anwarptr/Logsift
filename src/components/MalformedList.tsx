import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { copyText } from '../utils/clipboard';

const ROW_H = 44;

/** Lines whose shape didn't match the schema. Never dropped silently; shown here with the reason. */
export function MalformedList() {
  const malformed = useLogStore((s) => s.malformed);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const virtualizer = useVirtualizer({
    count: malformed.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  if (malformed.length === 0) {
    return <div className="table-empty">No malformed lines. Every line matched the detected format.</div>;
  }

  return (
    <div ref={scrollRef} className="table-scroll malformed-scroll" role="list" aria-label="Malformed lines" tabIndex={0}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const m = malformed[vi.index]!;
          return (
            <div
              key={m.id}
              role="listitem"
              className="malformed-row"
              style={{ transform: `translateY(${vi.start}px)`, height: ROW_H }}
            >
              <div className="malformed-meta">
                <span className="mono">
                  {m.file ? `${m.file}, line` : 'Line'} {m.lineNo.toLocaleString()}
                </span>
                <span className="warn-text">{m.reason}</span>
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={async () => {
                    if (await copyText(m.raw)) setCopiedId(m.id);
                  }}
                >
                  {copiedId === m.id ? 'Copied' : 'Copy raw'}
                </button>
              </div>
              <div className="malformed-raw mono" title={m.raw}>
                {m.raw}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
