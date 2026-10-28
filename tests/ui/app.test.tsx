// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sampleApache from '../../fixtures/sample-apache.log?raw';
import sampleJsonl from '../../fixtures/sample-jsonl.log?raw';
import type { LogFormat } from '../../src/parser';
import type { WorkerResponse } from '../../src/worker/protocol';

// jsdom has no Worker: run the same streaming parser in-process instead.
vi.mock('../../src/worker/client', () => ({
  startParse: (file: Blob, format: LogFormat | undefined, onMessage: (m: WorkerResponse) => void) => {
    void (async () => {
      const { parseText } = await import('../../src/parser');
      const text = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(file);
      });
      const res = parseText(text, format);
      onMessage({ type: 'start', jobId: 1, format: res.format, detected: res.format });
      onMessage({ type: 'batch', jobId: 1, rows: res.rows, malformed: res.malformed, meta: res.meta, schema: res.schema });
      onMessage({ type: 'done', jobId: 1, lines: text.split('\n').length, elapsedMs: 1 });
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

afterEach(cleanup);

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
    fireEvent.click(within(ips).getByRole('checkbox', { name: /10\.0\.32\.5/ }));
    expect(rowCount()).toBe('3 of 16 rows');
    const insights = screen.getByLabelText('Insights for the filtered rows');
    expect(insights.textContent).toContain('Total requests3');
    expect(insights.textContent).toContain('Error rate0%');
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
