import { DropZone } from './DropZone';

const REPO_URL = 'https://github.com/anwar-sobha/LogViewer';

const FORMATS = ['IIS W3C', 'Apache / Nginx', 'Serilog', 'JSON / JSON lines', 'IIS failed request traces', 'Windows Event Log XML', 'Syslog', 'Plain text', '.gz / .zip'];

const FEATURES = [
  {
    title: 'Filter and search',
    text: 'Status, method, IP and time filters, full-text or regex search, sortable columns, all on a table that stays fast with 500k rows.',
  },
  {
    title: 'Spot problems',
    text: 'Error rate, slowest requests, a requests-over-time chart and per-endpoint stats show where things go wrong.',
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
          </div>
        ))}
      </section>

      <p className="home-tips muted">
        Tip: drop several files to merge them into one timeline, or press <kbd>Ctrl</kbd>+<kbd>V</kbd> anywhere to
        paste log text.
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
