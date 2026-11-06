import { useEffect, useRef, useState } from 'react';
import { cleanKuduPath, isKuduLogFolder, KUDU_FOLDERS, KUDU_LIMITS, KuduBridge, KuduDirHandle } from '../live/kudu';
import { kuduBookmarklet, kuduScript } from '../live/kuduBookmarklet';
import { useLogStore } from '../store/logStore';
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
      setError(`Can't open ${path || 'the home folder'}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await openFolder(new KuduDirHandle(bridge, path, `${app}: ${path || 'home'}`), { ...KUDU_LIMITS, remember: false });
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal kudu-dialog" role="dialog" aria-modal="true" aria-labelledby="kudu-connect-title">
        <h2 id="kudu-connect-title" ref={titleRef} tabIndex={-1}>
          {state.kind === 'ready' || state.kind === 'opening' ? `Watch ${state.kind === 'ready' ? state.app : ''} logs` : 'Azure App Service (Kudu)'}
        </h2>
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
            <p className="muted">Choose what to watch. The newest files open first (up to 10 files, 64 MB), then new lines arrive live.</p>
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
            {state.kind === 'opening' && <p aria-live="polite">Reading the newest files…</p>}
          </>
        )}
      </div>
    </div>
  );
}
