import { openIncidentDemo, startLiveDemo } from '../samples';
import { DropZone } from './DropZone';

const REPO_URL = 'https://github.com/anwar-sobha/Logsift';

const FORMATS = ['IIS logs & failed request traces', 'Apache / Nginx', 'Serilog', 'Python', 'Java (logback, log4j, Spring Boot)', 'JSON (pino, Docker, …)', 'logfmt', 'Windows Event Log', 'Syslog', 'CSV / TSV', 'Plain text', 'Your own pattern', '.gz / .zip'];

const FEATURES: { title: string; text: string; action?: { label: string; run: () => void } }[] = [
  {
    title: 'Find what broke',
    text: 'Compare two time ranges, like before and after a deploy: endpoints with more errors or slower responses, new error messages, new status codes.',
    action: { label: 'Try it on a demo log', run: openIncidentDemo },
  },
  {
    title: 'Watch logs live',
    text: 'Open a folder and see new lines as your app writes them, like tail -f with filters, charts and error counts (Chrome, Edge).',
    action: { label: 'See a live demo', run: startLiveDemo },
  },
  {
    title: 'Filter, chart and share',
    text: 'Filters and search on a table that stays fast at 500k rows; endpoints, message patterns and charts; copy findings as Markdown for a ticket.',
  },
  {
    title: 'Private by design',
    text: 'Files are parsed in your browser. Nothing is uploaded: there is no server, account or tracking.',
  },
];

/** Shown before a log is loaded: what Logsift is, plus the ways to open a log. */
export function HomePage() {
  return (
    <div className="home">
      <header className="home-hero">
        <h2 className="home-title">Logsift</h2>
        <p className="home-tagline">Sift through server and application logs, right in your browser.</p>
      </header>

      <DropZone />

      <ul className="home-formats" aria-label="Supported formats">
        {FORMATS.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>

      <section className="home-features" aria-label="Features">
        {FEATURES.map((f) => (
          <div key={f.title} className="home-feature">
            <h3>{f.title}</h3>
            <p>{f.text}</p>
            {f.action && (
              <button type="button" className="btn small home-feature-action" onClick={f.action.run}>
                {f.action.label} <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        ))}
      </section>

      <p className="home-tips muted">
        Tip: drop several files to merge them into one timeline, or press <kbd>Ctrl</kbd>+<kbd>V</kbd> anywhere to
        paste log text. New here? Press <kbd>?</kbd> or <b>Help</b> at the top.
      </p>

      <footer className="home-footer">
        <span>Logsift v{__APP_VERSION__}</span>
        <Dot />
        <span>Made by Anwar</span>
        <Dot />
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Source on GitHub
        </a>
        <Dot />
        <span>MIT license</span>
      </footer>
    </div>
  );
}

const Dot = () => <span aria-hidden="true">·</span>;
