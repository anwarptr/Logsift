import { useEffect, useRef, useState } from 'react';
import {
  cleanKuduPath,
  getKuduFilterFn,
  isKuduLogFolder,
  KUDU_FOLDERS,
  KUDU_LIMITS,
  KuduBridge,
  KuduDirHandle,
  type KuduFilterKind,
} from '../live/kudu';
import { kuduBookmarklet, kuduScript } from '../live/kuduBookmarklet';
import { isAcceptedFile, useLogStore } from '../store/logStore';
import { copyText } from '../utils/clipboard';

/** Where the bookmark should come from for everyday use. */
const OFFICIAL_ORIGIN = 'https://logsift.ayzo.app';

function useModalFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => opener?.focus?.();
  }, []);
  return ref;
}

/** How to set up the "Logsift for Kudu" bookmark, with the bookmark to drag and the code to copy. */
export function KuduSetupDialog({ onClose }: { onClose: () => void }) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const closeRef = useModalFocus<HTMLButtonElement>();
  const [copied, setCopied] = useState(false);
  const origin = location.origin;

  // React warns about javascript: links in JSX, so the address is set directly.
  useEffect(() => {
    linkRef.current?.setAttribute('href', kuduBookmarklet(origin));
  }, [origin]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal kudu-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kudu-setup-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="kudu-setup-title">Azure App Service logs, live</h2>
        <p className="muted">
          No Azure CLI needed: your sign-in to the Azure portal is enough. The logs go from Azure to your browser only.
        </p>
        <ol className="kudu-steps">
          <li>
            Drag this button to your browser&apos;s bookmarks bar (show it with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>):{' '}
            <a ref={linkRef} className="btn small kudu-bookmarklet" onClick={(e) => e.preventDefault()} title="Drag me to the bookmarks bar">
              Logsift for Kudu
            </a>
          </li>
          <li>
            Open your app&apos;s Kudu site: Azure portal → your App Service → <b>Advanced Tools</b> → <b>Go</b> (it is{' '}
            <code>https://&lt;your-app&gt;.scm.azurewebsites.net</code>).
          </li>
          <li>
            Click <b>Logsift for Kudu</b> in the bookmarks bar there. Logsift opens in a new tab: choose the folder to
            watch. Keep the Kudu tab open while you watch.
          </li>
        </ol>
        {origin !== OFFICIAL_ORIGIN && (
          <p className="warn-text small-text">
            This bookmark works with the Logsift at <code>{origin}</code>. For everyday use, create it from{' '}
            <a href={OFFICIAL_ORIGIN} target="_blank" rel="noopener noreferrer">
              {OFFICIAL_ORIGIN.replace('https://', '')}
            </a>{' '}
            instead: a bookmark made here talks to whatever runs at this address later.
          </p>
        )}
        <p className="muted small-text">
          It only lists log folders and reads log files (in <code>LogFiles</code> or folders named like <code>Logs</code>),
          never the app&apos;s code or settings such as <code>appsettings.json</code> or <code>web.config</code>, and
          changes nothing. A bookmark made before version 0.7.1 allows more: drag the button again to replace it.
        </p>
        <p className="muted small-text">
          Can&apos;t add bookmarks? On the Kudu site press <kbd>F12</kbd>, open <b>Console</b>, and paste this code instead
          (it does the same). Only paste code copied from this dialog, never code someone sends you:{' '}
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              setCopied(await copyText(kuduScript(origin)));
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? 'Copied' : 'Copy the code'}
          </button>
        </p>
        <div className="modal-footer">
          <span className="muted small-text">The logs go from Azure to this browser only.</span>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

type ConnectState = { kind: 'connecting' } | { kind: 'failed' } | { kind: 'ready'; app: string } | { kind: 'opening' };

/**
 * Shown when the bookmarklet opened Logsift: connect to the Kudu tab, then choose the folder to watch.
 * The bridge lives as long as the page: live tail keeps reading through it.
 */
export function KuduConnectDialog({ onClose }: { onClose: () => void }) {
  const openFolder = useLogStore((s) => s.openFolder);
  const setLiveNotice = useLogStore((s) => s.setLiveNotice);
  const [state, setState] = useState<ConnectState>({ kind: 'connecting' });
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [maxFiles, setMaxFiles] = useState(KUDU_LIMITS.maxFiles);
  const [maxMb, setMaxMb] = useState(Math.round(KUDU_LIMITS.maxBytes / (1024 * 1024)));
  const [filterKind, setFilterKind] = useState<KuduFilterKind>('no-eventlog');
  const bridgeRef = useRef<KuduBridge | null>(null);
  const titleRef = useModalFocus<HTMLHeadingElement>();

  useEffect(() => {
    if (!window.opener) {
      setState({ kind: 'failed' });
      return;
    }
    const bridge = (bridgeRef.current ??= new KuduBridge(window.opener as Window));
    let alive = true;
    void bridge.connect().then((ok) => {
      if (alive) setState(ok ? { kind: 'ready', app: bridge.app ?? 'app' } : { kind: 'failed' });
    });
    // Say so when the Kudu tab goes away: live tail can't read any more.
    const watch = setInterval(() => {
      if (bridge.origin && (window.opener as Window | null)?.closed !== false) {
        clearInterval(watch);
        setLiveNotice('The Kudu tab was closed: no more lines will arrive. Open it and click the bookmark again to continue.');
      }
    }, 2000);
    return () => {
      alive = false;
    };
  }, [setLiveNotice]);

  const watch = async (path: string) => {
    const bridge = bridgeRef.current;
    if (!bridge || state.kind !== 'ready') return;
    const app = state.app;
    setError(null);
    setState({ kind: 'opening' });
    try {
      await bridge.list(path); // check it exists (and that Kudu answers) before opening it
    } catch (e) {
      setState({ kind: 'ready', app });
      const raw = e instanceof Error ? e.message : String(e);
      if (raw.includes('404')) {
        if (path === 'LogFiles/Application') {
          setError(
            'LogFiles/Application does not exist yet (Kudu 404). In Azure App Service, Application logging is disabled by default. Turn on "Application logging (Filesystem)" in Azure Portal > App Service logs (set Level to Information), or select "All of LogFiles" instead.'
          );
        } else if (path === 'LogFiles/http/RawLogs') {
          setError(
            'LogFiles/http/RawLogs does not exist yet (Kudu 404). In Azure App Service, Web server logging is disabled by default. Turn on "Web server logging (File System)" in Azure Portal > App Service logs (and send a web request to generate the first log), or select "All of LogFiles" instead.'
          );
        } else if (path === 'site/wwwroot/Logs') {
          setError(
            'site/wwwroot/Logs does not exist yet (Kudu 404). The app has not written to this folder yet, or writes logs elsewhere. Try "All of LogFiles" instead.'
          );
        } else {
          setError(`Folder "${path || 'home'}" was not found (Kudu 404). It may not exist yet on the server. Try "All of LogFiles" instead.`);
        }
      } else {
        setError(`Can't open ${path || 'the home folder'}: ${raw}`);
      }
      return;
    }
    await openFolder(new KuduDirHandle(bridge, path, `${app}: ${path || 'home'}`), {
      maxFiles,
      maxBytes: maxMb * 1024 * 1024,
      remember: false,
      accept: getKuduFilterFn(filterKind, isAcceptedFile),
    });
    if (typeof window !== 'undefined' && window.location.search.includes('source=kudu')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('source');
      url.searchParams.delete('app');
      window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + (url.hash || ''));
    }
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && state.kind !== 'opening') onClose();
      }}
    >
      <div
        className="modal kudu-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kudu-connect-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && state.kind !== 'opening') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h2 id="kudu-connect-title" ref={titleRef} tabIndex={-1} style={{ margin: 0 }}>
            {state.kind === 'ready' || state.kind === 'opening' ? `Watch ${state.kind === 'ready' ? state.app : ''} logs` : 'Azure App Service (Kudu)'}
          </h2>
          <button
            type="button"
            className="btn small ghost"
            aria-label="Close dialog"
            disabled={state.kind === 'opening'}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {state.kind === 'connecting' && <p aria-live="polite">Connecting to the Kudu tab…</p>}
        {state.kind === 'failed' && (
          <>
            <p className="error-text">Logsift could not reach the Kudu tab.</p>
            <p className="muted">
              Open your app&apos;s Kudu site and click the <b>Logsift for Kudu</b> bookmark there (this tab must be opened by
              it). If it still fails, your browser may separate the two tabs: try Edge or Chrome without extensions that
              block pop-ups.
            </p>
            <div className="modal-footer">
              <span />
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
        {(state.kind === 'ready' || state.kind === 'opening') && (
          <>
            <div className="kudu-limit-row">
              <div className="kudu-limit-group">
                <label htmlFor="kudu-limit-select" className="muted">
                  Limit:
                </label>
                <select
                  id="kudu-limit-select"
                  className="pattern-input small"
                  value={`${maxFiles}-${maxMb}`}
                  disabled={state.kind === 'opening'}
                  onChange={(e) => {
                    const [f, mb] = e.target.value.split('-').map(Number);
                    if (f && mb) {
                      setMaxFiles(f);
                      setMaxMb(mb);
                    }
                  }}
                >
                  <option value="5-32">Up to 5 files (32 MB) — Minimal</option>
                  <option value="10-64">Up to 10 files (64 MB) — Recommended</option>
                  <option value="25-128">Up to 25 files (128 MB)</option>
                  <option value="50-256">Up to 50 files (256 MB) — Slower</option>
                  <option value="100-512">Up to 100 files (512 MB) — Slowest</option>
                </select>
              </div>
              <div className="kudu-limit-group">
                <label htmlFor="kudu-filter-select" className="muted">
                  Filter:
                </label>
                <select
                  id="kudu-filter-select"
                  className="pattern-input small"
                  value={filterKind}
                  disabled={state.kind === 'opening'}
                  onChange={(e) => setFilterKind(e.target.value as KuduFilterKind)}
                >
                  <option value="no-eventlog">Exclude eventlog.xml (Recommended)</option>
                  <option value="all">All files (including eventlog.xml)</option>
                  <option value="app-only">App logs only (.txt, .log, .json)</option>
                  <option value="iis-only">IIS / Web server logs only (u_ex*.log)</option>
                  <option value="eventlog-only">eventlog.xml only</option>
                </select>
              </div>
            </div>
            <p className="muted">
              Choose what to watch. The newest files open first (up to {maxFiles} files, {maxMb} MB)
              {filterKind === 'no-eventlog' ? ', excluding heavy eventlog.xml' : ''}, then new lines arrive live.
            </p>
            <div className="kudu-folders">
              {KUDU_FOLDERS.map((f) => (
                <button key={f.path} type="button" className="samples-item" disabled={state.kind === 'opening'} onClick={() => void watch(f.path)}>
                  <b>{f.label}</b>
                  <span className="muted">{f.hint}</span>
                </button>
              ))}
            </div>
            <form
              className="kudu-custom"
              onSubmit={(e) => {
                e.preventDefault();
                const p = cleanKuduPath(custom);
                if (p === null) setError('Use a folder path like site/wwwroot/Logs.');
                else if (!isKuduLogFolder(p))
                  setError('Logsift only opens log folders: LogFiles, or a folder named Logs (or app-logs, App_Log…) and what is in it.');
                else void watch(p);
              }}
            >
              <label htmlFor="kudu-path">Another folder</label>
              <input
                id="kudu-path"
                className="pattern-input"
                placeholder="site/wwwroot/App_Data/logs"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
              <button type="submit" className="btn" disabled={state.kind === 'opening' || custom.trim() === ''}>
                Watch
              </button>
            </form>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            {state.kind === 'opening' && (
              <p aria-live="polite" className="muted" style={{ marginTop: '8px' }}>
                Reading files (up to {maxFiles} files)… {maxFiles >= 50 ? 'Downloading many files over Kudu may take up to a minute.' : ''}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
