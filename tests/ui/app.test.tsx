// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sampleApache from '../../fixtures/sample-apache.log?raw';
import sampleJsonl from '../../fixtures/sample-jsonl.log?raw';
import type { LogFormat } from '../../src/parser';
import type { WorkerResponse } from '../../src/worker/protocol';
import type { LogSource } from '../../src/worker/streamParse';

// jsdom has no Worker: run the same streaming parser in-process instead (as parse.worker.ts does).
vi.mock('../../src/worker/client', () => ({
  startParse: (
    sources: LogSource[],
    format: LogFormat | undefined,
    pattern: string | undefined,
    onMessage: (m: WorkerResponse) => void,
  ) => {
    void (async () => {
      const { streamParseSources } = await import('../../src/worker/streamParse');
      // jsdom's Blob lacks arrayBuffer()/stream(); real browsers have them, as does Node's Blob.
      const { Blob: NodeBlob } = await import('node:buffer');
      const read = (b: Blob) =>
        new Promise<ArrayBuffer>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as ArrayBuffer);
          r.readAsArrayBuffer(b);
        });
      const nodeSources = await Promise.all(
        sources.map(async (s) => ({ name: s.name, blob: new NodeBlob([await read(s.blob)]) as unknown as Blob })),
      );
      try {
        const summary = await streamParseSources(nodeSources, {
          format,
          pattern,
          onStart: (fmt, detected, files) => onMessage({ type: 'start', jobId: 1, format: fmt, detected, files }),
          onBatch: (batch) => onMessage({ type: 'batch', jobId: 1, ...batch }),
        });
        onMessage({ type: 'done', jobId: 1, lines: summary.lines, elapsedMs: 1, timeZone: summary.timeZone });
      } catch (e) {
        onMessage({ type: 'error', jobId: 1, message: e instanceof Error ? e.message : String(e) });
      }
    })();
  },
}));

beforeAll(() => {
  // jsdom lacks these browser APIs used by the layout code.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});

afterEach(() => {
  cleanup();
  // Column layouts are remembered per format; keep tests independent.
  localStorage.removeItem('logsift:column-layouts');
});

async function loadSample() {
  const { default: App } = await import('../../src/App');
  render(<App />);
  const button = screen.queryByRole('button', { name: 'Load sample data' });
  if (button) {
    // First test: exercise the real empty-state button.
    fireEvent.click(button);
  } else {
    // The store is a module singleton, so later tests reload explicitly.
    const { loadSample: load } = await import('../../src/components/DropZone');
    act(() => load());
  }
  await waitFor(() => expect(document.querySelector('.row-count')?.textContent).toMatch(/16\s*of\s*16 rows/));
}

const rowCount = () => document.querySelector('.row-count')!.textContent!.replace(/\s+/g, ' ');

describe('App with the sample IIS log', () => {
  it('loads 16 rows, shows file info and populates facets', async () => {
    await loadSample();
    expect(rowCount()).toBe('16 of 16 rows');
    const info = screen.getByLabelText('File information');
    expect(info.textContent).toContain('sample-iis.log');
    expect((screen.getByLabelText('Format') as HTMLSelectElement).selectedOptions[0]!.textContent).toContain('IIS');

    const sidebar = screen.getByLabelText('Filters');
    for (const name of ['sc-status values', 'cs-method values', 'cs-host values', 'c-ip values']) {
      expect(within(sidebar).getByRole('list', { name }).querySelectorAll('li').length).toBeGreaterThan(0);
    }
    const ips = within(sidebar).getByRole('list', { name: 'c-ip values' });
    expect(ips.textContent).toContain('10.20.0.12');
    expect(within(sidebar).getByRole('button', { name: /4xx\s*13/ })).toBeTruthy();
  });

  it('quick toggles filter rows and show chips', async () => {
    await loadSample();
    fireEvent.click(screen.getByRole('switch', { name: 'Hide health checks' }));
    expect(rowCount()).toBe('10 of 16 rows');
    expect(screen.getByRole('button', { name: 'Remove filter No health checks' })).toBeTruthy();
    expect(location.hash).toContain('hh');

    fireEvent.click(screen.getByRole('switch', { name: 'Hide health checks' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Hide SCM/Kudu' }));
    expect(rowCount()).toBe('13 of 16 rows');

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    fireEvent.click(screen.getByRole('switch', { name: /Only errors/ }));
    expect(rowCount()).toBe('13 of 16 rows');
    fireEvent.click(screen.getByRole('switch', { name: /Only slow/ }));
    expect(rowCount()).toBe('0 of 16 rows'); // the only slow request (4414 ms) is a 200
    fireEvent.click(screen.getByRole('switch', { name: /Only errors/ }));
    expect(rowCount()).toBe('1 of 16 rows');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    });
    expect(rowCount()).toBe('16 of 16 rows');
  });

  it('facet selection and insights reflect the filter', async () => {
    await loadSample();
    const ips = screen.getByRole('list', { name: 'c-ip values' });
    fireEvent.click(within(ips).getByRole('checkbox', { name: /10\.30\.0\.5/ }));
    expect(rowCount()).toBe('3 of 16 rows');
    const insights = screen.getByLabelText('Insights for the filtered rows');
    expect(insights.textContent).toContain('Total requests3');
    expect(insights.textContent).toContain('Error rate0%');
  });
});

describe('several files', () => {
  it('merges files into one timeline with a source file facet', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const head = '#Fields: date time cs-method cs-uri-stem sc-status time-taken\n';
    const a = new File([head + '2026-10-27 10:00:00 GET /a 200 5\n2026-10-27 10:00:10 GET /b 500 7\n'], 'web1.log');
    const b = new File([head + '2026-10-27 10:00:05 GET /c 404 3\n'], 'web2.log');
    const bad = new File(['x'], 'notes.pdf');
    act(() => useLogStore.getState().loadFiles([b, bad, a]));
    await waitFor(() => expect(rowCount()).toBe('3 of 3 rows'));

    expect(useLogStore.getState().rows.map((r) => r.values['cs-uri-stem'])).toEqual(['/a', '/c', '/b']);
    const info = screen.getByLabelText('File information');
    expect(info.textContent).toContain('2 files');
    expect(info.textContent).toContain('2 log files, merged in time order');
    expect(screen.getByRole('alert').textContent).toContain('Skipped 1 empty or unsupported file: notes.pdf');
    const sources = screen.getByRole('list', { name: 'source file values' });
    expect(sources.textContent).toContain('web1.log');
    expect(sources.textContent).toContain('web2.log');
    act(() => useLogStore.getState().setError(null));
  });
});

describe('endpoints view', () => {
  it('groups requests by URI pattern and filters to one on click', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const log = [
      '#Fields: date time cs-method cs-uri-stem sc-status time-taken',
      '2026-10-27 10:00:00 GET /api/products/1 200 10',
      '2026-10-27 10:00:01 GET /api/products/2 500 30',
      '2026-10-27 10:00:02 GET /health 200 1',
    ].join('\n');
    act(() => useLogStore.getState().loadText(log));
    await waitFor(() => expect(rowCount()).toBe('3 of 3 rows'));

    fireEvent.click(screen.getByRole('tab', { name: 'Endpoints' }));
    const table = screen.getByRole('table', { name: 'Endpoints' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      // requests 2, errors 1, 50%, avg 20, p50 20, p95 29, max 30
      '/api/products/{id}GET2150%20202930',
      '/healthGET100%1111',
    ]);

    fireEvent.click(within(table).getByRole('button', { name: '/api/products/{id}' }));
    expect(screen.getByRole('tab', { name: /Rows/ }).getAttribute('aria-selected')).toBe('true');
    expect(rowCount()).toBe('2 of 3 rows');
    expect(screen.getByRole('button', { name: 'Remove filter Endpoint: /api/products/{id}' })).toBeTruthy();
    act(() => useLogStore.getState().clearFilters());
  });
});

describe('time zone', () => {
  it('shows the detected zone and switches between log and local time', async () => {
    await loadSample();
    const info = screen.getByLabelText('File information');
    // The compact file bar keeps the zone and switch; the explanation is under Details.
    expect(info.textContent).not.toContain('IIS logs are always UTC');
    fireEvent.click(within(info).getByRole('button', { name: /Details/ }));
    expect(info.textContent).toContain('IIS logs are always UTC');
    expect(info.textContent).toContain('Size');
    fireEvent.click(within(info).getByRole('button', { name: /Less/ }));
    expect(info.textContent).not.toContain('Size');
    const sidebar = screen.getByLabelText('Filters');
    expect(sidebar.textContent).toContain('Time range (UTC)');
    expect(sidebar.textContent).toContain('File spans 2026-03-14 09:12:02 – 2026-03-14 09:13:32');

    // Tests run in Asia/Dubai (UTC+4), which differs from the log's UTC.
    const group = within(info).getByRole('radiogroup', { name: 'Show times in' });
    const localBtn = within(group).getByRole('radio', { name: /Local \(UTC\+04:00/ });
    fireEvent.click(localBtn);
    expect(localBtn.getAttribute('aria-checked')).toBe('true');
    expect(sidebar.textContent).toContain('Time range (local, UTC+04:00)');
    expect(sidebar.textContent).toContain('File spans 2026-03-14 13:12:02 – 2026-03-14 13:13:32');

    fireEvent.click(within(group).getByRole('radio', { name: 'Log time (UTC)' }));
    expect(sidebar.textContent).toContain('File spans 2026-03-14 09:12:02');
  });
});

describe('more room for the table', () => {
  it('hides and shows the filter panel from the panel, the rail and the [ key', async () => {
    await loadSample();
    fireEvent.click(screen.getByRole('button', { name: 'Hide filters' }));
    expect(screen.queryByLabelText('Filters')).toBeNull();
    expect(JSON.parse(localStorage.getItem('log-viewer:prefs')!).sidebarOpen).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Show filters' }));
    expect(screen.getByLabelText('Filters')).toBeTruthy();

    fireEvent.keyDown(window, { key: '[' });
    expect(screen.queryByLabelText('Filters')).toBeNull();
    fireEvent.keyDown(window, { key: '[' });
    expect(screen.getByLabelText('Filters')).toBeTruthy();
  });

  it('focus mode leaves only the table, toolbar and filter chips', async () => {
    await loadSample();
    const focus = screen.getByRole('button', { name: 'Focus' });
    fireEvent.click(screen.getByRole('switch', { name: 'Hide health checks' }));
    fireEvent.click(focus);
    expect(focus.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.app')!.classList.contains('focus-mode')).toBe(true);
    expect(screen.queryByLabelText('File information')).toBeNull();
    expect(screen.queryByLabelText('Filters')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show filters' })).toBeNull();
    expect(screen.queryByLabelText('Insights')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove filter No health checks' })).toBeTruthy();
    expect(rowCount()).toBe('10 of 16 rows');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('File information')).toBeTruthy();
    expect(screen.getByLabelText('Filters')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'f' });
    expect(screen.queryByLabelText('File information')).toBeNull();
    // Typing an "f" in the search box must not toggle it.
    const search = screen.getByRole('searchbox');
    search.focus();
    fireEvent.keyDown(search, { key: 'f' });
    expect(screen.queryByLabelText('File information')).toBeNull();
    search.blur();
    fireEvent.keyDown(window, { key: 'f' });
    expect(screen.getByLabelText('File information')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  });
});

describe('IP details', () => {
  it('labels private addresses and offers no look-up for them', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const row = useLogStore.getState().rows.find((r) => r.values['c-ip'] === '10.30.0.5')!;
    act(() => useLogStore.getState().select(row.id));
    const details = screen.getByRole('complementary', { name: `Details for line ${row.lineNo}` });
    expect(details.textContent).toContain('Private network');
    expect(within(details).queryByRole('link')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'c-ip values' })).queryByRole('link')).toBeNull();
    act(() => useLogStore.getState().select(null));
  });

  it('links public addresses to ipinfo.io', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const log =
      '8.8.8.8 - - [27/Oct/2026:04:42:02 +0000] "GET / HTTP/1.1" 200 512 "-" "curl/8"\n' +
      '10.0.0.7 - - [27/Oct/2026:04:42:03 +0000] "GET /a HTTP/1.1" 404 0 "-" "curl/8"\n';
    act(() => useLogStore.getState().loadText(log));
    await waitFor(() => expect(rowCount()).toBe('2 of 2 rows'));

    const facet = screen.getByRole('list', { name: 'c-ip values' });
    const links = within(facet).getAllByRole('link');
    expect(links).toHaveLength(1); // only the public address
    expect(links[0]!.getAttribute('href')).toBe('https://ipinfo.io/8.8.8.8');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(links[0]!.getAttribute('rel')).toContain('noopener');

    const insights = screen.getByLabelText('Insights for the filtered rows');
    expect(within(insights).getByRole('link', { name: /Look up 8\.8\.8\.8/ })).toBeTruthy();

    const row = useLogStore.getState().rows.find((r) => r.values['c-ip'] === '8.8.8.8')!;
    act(() => useLogStore.getState().select(row.id));
    const details = screen.getByRole('complementary', { name: `Details for line ${row.lineNo}` });
    expect(within(details).getByRole('link', { name: /Look up 8\.8\.8\.8/ }).textContent).toBe('Look up ↗');
    act(() => useLogStore.getState().select(null));
  });
});

describe('JSON files', () => {
  it('opens a .json file holding a JSON array', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const events = [
      { '@t': '2026-03-14T05:30:01Z', '@mt': 'Started {App}', App: 'demo' },
      { '@t': '2026-03-14T05:30:02Z', '@mt': 'Failed', '@l': 'Error' },
    ];
    act(() => useLogStore.getState().loadFiles([new File([JSON.stringify(events, null, 2)], 'events.json')]));
    await waitFor(() => expect(rowCount()).toBe('2 of 2 rows'));
    expect(useLogStore.getState().error).toBeNull();
    expect((screen.getByLabelText('Format') as HTMLSelectElement).selectedOptions[0]!.textContent).toContain('JSON');
    expect(useLogStore.getState().rows.map((r) => r.values.message)).toEqual(['Started demo', 'Failed']);
  });
});

describe('pasting text instead of a file', () => {
  it('parses text entered in the paste dialog', async () => {
    await loadSample();
    fireEvent.click(screen.getByRole('button', { name: 'Paste text…' }));
    const dialog = screen.getByRole('dialog', { name: 'Paste log text' });
    const parse = within(dialog).getByRole('button', { name: 'Parse text' }) as HTMLButtonElement;
    expect(parse.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Log text'), { target: { value: sampleApache } });
    expect(dialog.textContent).toContain('6 lines');
    fireEvent.click(parse);

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(rowCount()).toBe('6 of 6 rows'));
    expect(screen.getByLabelText('File information').textContent).toContain('pasted-text.txt');
    expect((screen.getByLabelText('Format') as HTMLSelectElement).selectedOptions[0]!.textContent).toContain('Apache');
  });

  it('Escape closes the dialog without loading anything', async () => {
    await loadSample();
    fireEvent.click(screen.getByRole('button', { name: 'Paste text…' }));
    fireEvent.keyDown(screen.getByLabelText('Log text'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rowCount()).toBe('16 of 16 rows');
  });

  it('Ctrl+V outside a text field loads the clipboard text', async () => {
    await loadSample();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], getData: (t: string) => (t === 'text/plain' ? sampleJsonl : '') },
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(rowCount()).toBe('5 of 5 rows'));
    expect(screen.getByLabelText('File information').textContent).toContain('pasted-text.txt');
  });

  it('rejects empty pasted text', async () => {
    const { useLogStore } = await import('../../src/store/logStore');
    act(() => useLogStore.getState().loadText('  \n\n'));
    expect(useLogStore.getState().error).toBe('The pasted text is empty.');
    act(() => useLogStore.getState().setError(null));
  });
});

describe('row details shortcuts', () => {
  it('"Only this" filters to a facet value or an exact URI', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const { rows } = useLogStore.getState();
    const row = rows[0]!;
    act(() => useLogStore.getState().select(row.id));
    const details = () => screen.getByRole('complementary', { name: `Details for line ${row.lineNo}` });

    fireEvent.click(within(details()).getByTitle('Show only rows with this c-ip'));
    const sameIp = rows.filter((r) => r.values['c-ip'] === row.values['c-ip']).length;
    expect(rowCount()).toBe(`${sameIp} of 16 rows`);
    expect(screen.getByRole('button', { name: `Remove filter c-ip: ${String(row.values['c-ip'])}` })).toBeTruthy();

    fireEvent.click(within(details()).getByTitle('Show only rows with this cs-uri-stem'));
    expect(useLogStore.getState().filters).toMatchObject({ uriMode: 'equals', uri: row.values['cs-uri-stem'] });
    // Free-text and time fields have no such button.
    expect(within(details()).queryByTitle('Show only rows with this timestamp')).toBeNull();
    act(() => useLogStore.getState().clearFilters());
    act(() => useLogStore.getState().select(null));
  });

  it('"Show in full log" sets the filters aside until they are restored', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    fireEvent.click(screen.getByRole('switch', { name: /Only errors/ }));
    expect(rowCount()).toBe('13 of 16 rows');
    const errorRow = useLogStore.getState().rows.find((r) => Number(r.values['sc-status']) >= 400)!;
    act(() => useLogStore.getState().select(errorRow.id));

    fireEvent.click(screen.getByRole('button', { name: 'Show in full log' }));
    expect(rowCount()).toBe('16 of 16 rows');
    expect(useLogStore.getState().selectedId).toBe(errorRow.id);
    expect(screen.getByText(new RegExp(`Filters paused to show line ${errorRow.lineNo}`))).toBeTruthy();
    // Nothing to set aside any more, so the button is gone.
    expect(screen.queryByRole('button', { name: 'Show in full log' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Restore filters' }));
    expect(rowCount()).toBe('13 of 16 rows');
    expect(screen.queryByText(/Filters paused/)).toBeNull();
    act(() => useLogStore.getState().clearFilters());
    act(() => useLogStore.getState().select(null));
  });

  it('n and Shift+N step through error rows', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const { rows } = useLogStore.getState();
    const errors = rows.filter((r) => Number(r.values['sc-status']) >= 400).map((r) => r.id);
    act(() => useLogStore.getState().select(null));
    fireEvent.keyDown(window, { key: 'n' });
    expect(useLogStore.getState().selectedId).toBe(errors[0]);
    fireEvent.keyDown(window, { key: 'n' });
    expect(useLogStore.getState().selectedId).toBe(errors[1]);
    fireEvent.keyDown(window, { key: 'N', shiftKey: true });
    expect(useLogStore.getState().selectedId).toBe(errors[0]);
    // Wraps around backwards from the first error to the last.
    fireEvent.keyDown(window, { key: 'N', shiftKey: true });
    expect(useLogStore.getState().selectedId).toBe(errors.at(-1));
    act(() => useLogStore.getState().select(null));
  });
});

describe('patterns view', () => {
  it('groups similar messages and filters to one on click', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    // IIS logs have no message column, so there is no Patterns tab.
    expect(screen.queryByRole('tab', { name: 'Patterns' })).toBeNull();
    const log = [
      '2026-10-27 04:42:01 INFO Order 12 shipped',
      '2026-10-27 04:42:02 INFO Order 345 shipped',
      '2026-10-27 04:42:03 ERROR Payment 9 failed',
      '2026-10-27 04:42:04 INFO Order 6 shipped',
    ].join('\n');
    act(() => useLogStore.getState().loadText(log));
    await waitFor(() => expect(rowCount()).toBe('4 of 4 rows'));

    fireEvent.click(screen.getByRole('tab', { name: 'Patterns' }));
    const table = screen.getByRole('table', { name: 'Message patterns' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('td')!.textContent)).toEqual(['Order {n} shipped', 'Payment {n} failed']);
    expect(rows[0]!.textContent).toContain('3');

    fireEvent.click(within(table).getByRole('button', { name: 'Order {n} shipped' }));
    expect(useLogStore.getState().tab).toBe('rows');
    expect(rowCount()).toBe('3 of 4 rows');
    expect(screen.getByRole('button', { name: 'Remove filter Pattern: Order {n} shipped' })).toBeTruthy();
    act(() => useLogStore.getState().clearFilters());
  });
});

describe('help', () => {
  it('opens from the header button and the ? key, and closes with Esc', async () => {
    await loadSample();
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    const dialog = screen.getByRole('dialog', { name: 'Help' });
    for (const heading of ['Open a log', 'Supported formats', 'Keyboard shortcuts', 'Privacy']) {
      expect(within(dialog).getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close help' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();

    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });
});

describe('charts', () => {
  it('shows response times, traffic and request flow, and filters from a chart', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    fireEvent.click(screen.getByRole('tab', { name: 'Charts' }));
    const panel = screen.getByRole('tabpanel');
    for (const name of ['Response times', 'Traffic by hour', 'Request flow']) {
      expect(within(panel).getByRole('region', { name })).toBeTruthy();
    }
    expect(within(panel).getByRole('img', { name: /Response times of 16 requests/ })).toBeTruthy();
    // Clicking the 4xx box in the flow filters to that status class.
    const flow = within(panel).getByRole('region', { name: 'Request flow' });
    const box = [...flow.querySelectorAll('.flow-node')].find((g) => g.textContent === '4xx')!;
    fireEvent.click(box);
    expect(useLogStore.getState().filters.statusClasses).toEqual(['4xx']);
    expect(rowCount()).toBe('13 of 16 rows');
    act(() => useLogStore.getState().clearFilters());
    act(() => useLogStore.getState().setTab('rows'));
  });

  it('shows where a failed request spent its time in the row details', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const { readFileSync } = await import('node:fs');
    act(() => useLogStore.getState().loadText(readFileSync('fixtures/sample-freb.xml', 'utf8')));
    await waitFor(() => expect(rowCount()).toBe('1 of 1 rows'));
    act(() => useLogStore.getState().select(0));
    const details = screen.getByRole('complementary', { name: /Details for line/ });
    const waterfall = within(details).getByRole('region', { name: 'Where the time went' });
    expect(waterfall.textContent).toContain('ConfigurationValidationModule set the error status');
    act(() => useLogStore.getState().select(null));
  });
});

describe('custom pattern', () => {
  it('previews a pattern on the open log and re-parses with it', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const text = [
      '2026-10-27 04:42:03.120 | main | ERROR | boom',
      '  at Foo.bar()',
      '2026-10-27 04:42:04.120 | worker-1 | INFO | ok',
    ].join('\n');
    act(() => useLogStore.getState().loadText(text));
    await waitFor(() => expect(rowCount()).toBe('2 of 2 rows'));

    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'custom' } });
    const dialog = screen.getByRole('dialog', { name: 'Custom log pattern' });
    const input = within(dialog).getByLabelText('Pattern');
    fireEvent.change(input, { target: { value: '{time} | {thread} | {level' } });
    expect(dialog.textContent).toContain('is not paired');
    expect((within(dialog).getByRole('button', { name: 'Use pattern' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: '{time} | {thread} | {level} | {message}' } });
    expect(dialog.textContent).toContain('2 entries in the first 3 lines');
    expect(within(dialog).getByRole('columnheader', { name: 'thread' })).toBeTruthy();
    expect(within(dialog).getByRole('cell', { name: 'worker-1' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use pattern' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(useLogStore.getState().format).toBe('custom'));
    await waitFor(() => expect(rowCount()).toBe('2 of 2 rows'));
    expect(useLogStore.getState().rows[0]!.values).toMatchObject({ thread: 'main', level: 'ERROR' });
    expect(useLogStore.getState().customPattern).toBe('{time} | {thread} | {level} | {message}');
    expect(screen.getByRole('button', { name: 'Edit pattern' })).toBeTruthy();

    act(() => useLogStore.getState().setFormatOverride('auto'));
    await waitFor(() => expect(useLogStore.getState().format).toBe('generic'));
  });
});

describe('sharing', () => {
  it('copies the filtered rows as Markdown', async () => {
    await loadSample();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    const md = writeText.mock.calls[0]![0];
    // The sample is mostly 404s from scanners: 13 of its 16 requests are errors.
    expect(md.split('\n')[0]).toBe('**sample-iis.log** · 16 rows · 13 errors');
    expect(md).toMatch(/^\| timestamp \|/m);
  });

  it('opens a report with masked sample lines', async () => {
    await loadSample();
    fireEvent.click(screen.getByRole('button', { name: 'Read wrongly?' }));
    const dialog = screen.getByRole('dialog', { name: /isn't read correctly/ });
    const lines = (within(dialog).getByLabelText('Sample lines') as HTMLTextAreaElement).value;
    // The sample's client IPs (10.20.0.x) and ARR log ids (GUIDs) are masked.
    expect(lines).toContain('DEMO-API-PROD GET /');
    expect(lines).not.toMatch(/\b10\.20\.\d+\.\d+\b/);
    expect(lines).toContain('192.0.2.1');
    expect(lines).toContain('X-ARR-LOG-ID=00000000-0000-0000-0000-000000000000');
    const link = within(dialog).getByRole('link', { name: /Open GitHub issue/ }) as HTMLAnchorElement;
    expect(link.href).toMatch(/^https:\/\/github\.com\/anwar-sobha\/Logsift\/issues\/new\?/);
    expect(new URL(link.href).searchParams.get('body')).toContain('IIS W3C Extended');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/** Load the sample again in the app that is already on screen. */
async function reloadSample() {
  const { loadSample: load } = await import('../../src/components/DropZone');
  act(() => load());
  await waitFor(() => expect(rowCount()).toBe('16 of 16 rows'));
}

describe('remembered column layout', () => {
  it('opens the next log of the same format with the columns as they were left', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const st = () => useLogStore.getState();
    const first = st().columnOrder[0]!;
    act(() => {
      st().setColumnVisible('cs-method', false);
      st().moveColumn('sc-status', 0);
      st().setColumnWidth('sc-status', 222);
    });
    // No wait: a resize is saved shortly after it ends, or at once when another log is opened.

    // Open the same log again: a new file, same format.
    await reloadSample();
    expect(st().columnOrder[0]).toBe('sc-status');
    expect(st().columnOrder[1]).toBe(first);
    expect(st().hiddenColumns['cs-method']).toBe(true);
    expect(st().columnWidths['sc-status']).toBe(222);
    // Only the changed width is saved; the other columns keep following the defaults.
    const saved = JSON.parse(localStorage.getItem('logsift:column-layouts')!) as Record<string, { widths: object }>;
    expect(Object.keys(saved.iis!.widths)).toEqual(['sc-status']);

    fireEvent.click(screen.getByRole('button', { name: /^Columns \(/ }));
    expect(screen.getByRole('dialog', { name: 'Choose columns' }).textContent).toContain('Remembered for IIS W3C Extended logs');

    // Reset goes back to the defaults and forgets the layout.
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose columns' })).getByRole('button', { name: 'Reset' }));
    expect(st().columnOrder[0]).toBe(first);
    await reloadSample();
    expect(st().hiddenColumns['cs-method']).toBeUndefined();
  });

  it('does not apply one format\'s layout to another', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const st = () => useLogStore.getState();
    act(() => st().setColumnVisible('timestamp', false));
    act(() => st().loadFiles([new File([sampleJsonl], 'app.jsonl')]));
    await waitFor(() => expect(st().status).toBe('ready'));
    expect(st().format).toBe('jsonl');
    expect(st().hiddenColumns.timestamp).toBeUndefined();
  });
});

describe("what's new", () => {
  it('shows the latest release notes and the version in the help', async () => {
    await loadSample();
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    const dialog = screen.getByRole('dialog', { name: /Help/ });
    expect(dialog.textContent).toMatch(/What's new in \d+\.\d+\.\d+/);
    expect(dialog.textContent).toContain('Live tail');
    expect(within(dialog).getByRole('link', { name: /All changes/ }).getAttribute('href')).toContain('CHANGELOG.md');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close help' }));
  });
});

describe('compare', () => {
  it('shows what changed between two halves of the log, and opens those rows', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const st = () => useLogStore.getState();
    const lines: string[] = [];
    const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
    for (let m = 0; m < 20; m++) {
      const at = new Date(T0 + m * 60_000).toISOString().replace('T', ' ').replace('Z', ' +00:00');
      lines.push(`${at} [INF] HTTP POST /api/orders responded ${m >= 10 ? 500 : 200} in ${m >= 10 ? 800 : 30}.0 ms`);
      if (m >= 10) lines.push(`${at} [ERR] Payment gateway timeout for order ${m}`);
    }
    act(() => st().loadText(lines.join('\n')));
    await waitFor(() => expect(st().status).toBe('ready'));

    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    const panel = document.getElementById('panel-compare')!;
    expect(within(panel).getByLabelText('Compare')).toBeTruthy();
    expect(panel.textContent).toContain('Endpoints that got worse');
    expect(panel.textContent).toContain('New or growing messages');
    expect(within(panel).getByRole('button', { name: /Payment gateway timeout/ })).toBeTruthy();

    // Click the endpoint: the later range's rows for it.
    fireEvent.click(within(panel).getByRole('button', { name: '/api/orders' }));
    expect(st().tab).toBe('rows');
    expect(st().filters.endpoint).toBe('/api/orders');
    expect(st().filters.timeFrom).not.toBeNull();
    expect(rowCount()).toBe('10 of 30 rows');

    // The comparison itself ignores the time and endpoint filters it set.
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    expect(document.getElementById('panel-compare')!.textContent).toContain('/api/orders');
    act(() => st().clearFilters());
    act(() => st().setTab('rows'));
  });
});

describe('samples and demos', () => {
  it('opens the incident demo in Compare, and a sample of each kind from the menu', async () => {
    await loadSample();
    const { useLogStore } = await import('../../src/store/logStore');
    const st = () => useLogStore.getState();
    const { openIncidentDemo } = await import('../../src/samples');
    act(() => openIncidentDemo());
    await waitFor(() => expect(st().tab).toBe('compare'));
    expect(st().file?.name).toBe('incident-demo.log');
    const panel = document.getElementById('panel-compare')!;
    expect(within(panel).getByRole('button', { name: '/api/payments' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /Payment gateway timeout/ })).toBeTruthy();

    act(() => st().setTab('rows'));
    const { SamplesMenu } = await import('../../src/components/SamplesMenu');
    const { unmount } = render(<SamplesMenu />);
    fireEvent.click(screen.getByRole('button', { name: /More samples/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Python logging' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(st().file?.name).toBe('sample-python.log'));
    unmount();
  });
});
