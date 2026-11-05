import { useEffect, useRef, type ReactNode } from 'react';
import changelog from '../../CHANGELOG.md?raw';
import { useLogStore } from '../store/logStore';
import { inlineParts, parseChangelog, type Release } from '../utils/changelog';

const CHANGELOG_URL = 'https://github.com/anwar-sobha/Logsift/blob/main/CHANGELOG.md';
const RELEASES = parseChangelog(changelog);

/** A line of the changelog with its **bold**, *italic* and `code` parts. */
const Inline = ({ text }: { text: string }) => (
  <>
    {inlineParts(text).map((p, i) =>
      p.style === 'bold' ? <b key={i}>{p.text}</b> : p.style === 'code' ? <code key={i}>{p.text}</code> : p.style === 'italic' ? <i key={i}>{p.text}</i> : <span key={i}>{p.text}</span>,
    )}
  </>
);

function ReleaseNotes({ release }: { release: Release }) {
  return (
    <>
      {release.blocks.map((b, bi) =>
        b.kind === 'text' ? (
          <p key={bi}>
            <Inline text={b.text} />
          </p>
        ) : (
          <div key={bi}>
            {b.title && <h4>{b.title}</h4>}
            <ul>
              {b.items.map((item, i) => (
                <li key={i}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </>
  );
}

/** The latest release in full, older ones folded, and a link to the whole changelog. */
function WhatsNew() {
  const [latest, ...older] = RELEASES;
  if (!latest) return null;
  return (
    <section className="whats-new">
      <h3>
        What&apos;s new in {latest.version}
        {latest.date && <span className="muted"> · {latest.date}</span>}
      </h3>
      <ReleaseNotes release={latest} />
      {older.slice(0, 3).map((r) => (
        <details key={r.version}>
          <summary>
            {r.version}
            {r.date && <span className="muted"> · {r.date}</span>}
          </summary>
          <ReleaseNotes release={r} />
        </details>
      ))}
      <p>
        <a href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer">
          All changes ↗
        </a>
      </p>
    </section>
  );
}

const FORMATS: [name: string, text: ReactNode][] = [
  ['IIS W3C logs', <>u_ex*.log files with a <code>#Fields:</code> header (also from Azure App Service).</>],
  ['IIS failed request traces', <>fr*.xml files: one row per failed request, with its event timeline in the row details.</>],
  ['Windows Event Log', <>XML exports from Event Viewer, wevtutil or Azure's eventlog.xml: one row per event.</>],
  ['Apache / Nginx', 'Access logs in the combined or common format, and Nginx error logs.'],
  ['Text logs', <>Lines starting with a date and time (or just a time, like <code>[11:54:02 INF]</code>): Serilog, Python logging, logback/log4j, Spring Boot and similar. Stack traces stay with their entry.</>],
  ['JSON', 'JSON lines (one object per line), a JSON array, Serilog JSON (CLEF), pino/bunyan, and Docker container logs.'],
  ['logfmt', <><code>key=value</code> lines, as written by Go (slog, logrus), Heroku and Loki.</>],
  ['Syslog', <>Linux and device logs like <code>Oct 27 04:42:03 host app[123]: message</code>.</>],
  ['CSV / TSV', 'Exports with a header row, e.g. from Log Analytics, Application Insights or Excel.'],
  ['Anything else', <>Choose <b>Custom pattern…</b> in the <b>Format</b> menu and describe a line, like <code>{'{time} [{thread}] {level} {logger} - {message}'}</code>. A preview shows the result before you apply it.</>],
];

const SHORTCUTS: [keys: string[], text: string][] = [
  [['/'], 'Search'],
  [['n', 'Shift+N'], 'Next / previous error row'],
  [['↑', '↓', 'PgUp', 'PgDn'], 'Move through rows'],
  [['Enter'], 'Open the row details'],
  [['['], 'Show / hide the filter panel'],
  [['F'], 'Focus mode: the table fills the window'],
  [['Esc'], 'Close details, leave search, leave focus mode'],
  [['?'], 'This help'],
];

const Keys = ({ keys }: { keys: string[] }) => (
  <>
    {keys.map((k, i) => (
      <span key={k}>
        {i > 0 && ' '}
        <kbd>{k}</kbd>
      </span>
    ))}
  </>
);

/** What Logsift reads and how to use it, in short sections. Opened from the header's Help button or "?". */
export function HelpDialog() {
  const setHelpOpen = useLogStore((s) => s.setHelpOpen);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const close = () => setHelpOpen(false);

  useEffect(() => {
    opener.current = document.activeElement;
    closeRef.current?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="modal help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <div className="help-head">
          <h2 id="help-title">Help</h2>
          <span className="muted help-version">Logsift v{__APP_VERSION__}</span>
          <button ref={closeRef} type="button" className="btn small ghost" aria-label="Close help" onClick={close}>
            ✕
          </button>
        </div>
        <div className="help-body">
          <WhatsNew />
          <section>
            <h3>Open a log</h3>
            <ul>
              <li>Drop files anywhere on the page, use <b>Open files…</b>, or paste text (<b>Paste text…</b> or Ctrl+V).</li>
              <li>Several files open as one log in time order, with a <i>source file</i> column. <code>.gz</code> and <code>.zip</code> files are unpacked for you.</li>
              <li>The format is detected automatically; if it guesses wrong, pick one in the <b>Format</b> menu in the file bar. Still wrong? <b>Read wrongly?</b> next to it reports the log (with IPs, e-mails and tokens masked) so the format can be added.</li>
            </ul>
          </section>
          <section>
            <h3>Watch logs live</h3>
            <ul>
              <li><b>Open folder…</b> (Chrome, Edge) opens the log files in a folder and its sub-folders, newest first, and keeps watching it: lines written to the files and new files appear as they arrive. You can also drop a folder on the page.</li>
              <li>The live bar shows what is watched. <b>Follow</b> keeps the newest row in view (scroll up to stop, scroll to the end to resume); <b>Pause</b> and <b>Stop</b> do what they say. Filters, counts and charts update with the new rows.</li>
              <li>The folder is remembered: <b>Reopen</b> on the start page opens it again after the browser asks for permission. Files opened with <i>Open with → Logsift</i> in the installed app are watched too.</li>
            </ul>
          </section>

          <section>
            <h3>Supported formats</h3>
            <dl className="help-formats">
              {FORMATS.map(([name, text]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section>
            <h3>Find what matters</h3>
            <ul>
              <li><b>Search</b> looks through every line; <code>.*</code> turns on regular expressions.</li>
              <li>The <b>filter panel</b> lists each column's values with counts. <b>Only errors</b> and <b>Only slow</b> are one click away.</li>
              <li>Drag across the <b>Requests over time</b> chart to zoom into a time range.</li>
              <li>Active filters show as chips above the table; click × to remove one. The page address keeps your filters, so you can bookmark or share a view.</li>
            </ul>
          </section>

          <section>
            <h3>Views</h3>
            <ul>
              <li><b>Rows</b>: the log itself. Click a column header to sort, drag its edge to resize; <b>Columns</b> shows, hides and reorders them. Your columns are remembered for the next log of the same format (<b>Reset</b> forgets them).</li>
              <li><b>Endpoints</b>: requests grouped by URL, with error rates and response times.</li>
              <li><b>Patterns</b>: similar messages grouped together, so repeated errors stand out.</li>
              <li><b>Charts</b>: response times over time and by range, traffic by hour of day, and a request flow from callers to endpoints to status codes. Click or drag in a chart to filter.</li>
              <li><b>Compare</b>: what changed between two time ranges (the two halves, the last 15 minutes / hour / day against the one before, or before and after a time you pick): endpoints that got more errors, slower or busier, messages that are new or more frequent, and status codes, IPs and other values seen only later. Counts are per minute; your filters apply, except the time range. Click a line to see those rows.</li>
              <li><b>Malformed</b>: lines that could not be read, with the reason.</li>
            </ul>
          </section>

          <section>
            <h3>Row details</h3>
            <ul>
              <li>Click a row to see all its fields. <b>Only this</b> next to a value shows only rows with that value.</li>
              <li><b>Show in full log</b> sets your filters aside to show the row among its neighbours; <b>Restore filters</b> brings them back.</li>
              <li>For an IIS failed request trace, <b>Where the time went</b> shows how long each module took.</li>
              <li><b>Copy as JSON</b> and <b>Copy raw line</b> copy the row; <b>Export</b> saves the filtered rows as CSV or JSON.</li>
            </ul>
          </section>

          <section>
            <h3>Keyboard shortcuts</h3>
            <table className="help-keys">
              <tbody>
                {SHORTCUTS.map(([keys, text]) => (
                  <tr key={text}>
                    <td>
                      <Keys keys={keys} />
                    </td>
                    <td>{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>Time zones</h3>
            <p>
              Times are shown as the log wrote them; the file bar says which zone that is. Switch to <b>Local</b> to see
              your own time. When a log leaves out the date or year, the file bar shows what was assumed.
            </p>
          </section>

          <section>
            <h3>Install and offline use</h3>
            <p>
              In Chrome or Edge, use the install button in the address bar to add Logsift as an app. It then works
              offline and can open log files from Windows' <i>Open with</i> menu.
            </p>
          </section>

          <section>
            <h3>Privacy</h3>
            <p>
              Files are read in your browser and never uploaded: there is no server, account or tracking. The only
              outside link is the optional <i>Look up</i> for public IP addresses, which opens ipinfo.io when you click it.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
