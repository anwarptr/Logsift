import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/parser';
import { issueUrl, MAX_URL_LENGTH } from '../../src/components/ReportDialog';
import { MARKDOWN_MAX_ROWS, toMarkdown } from '../../src/utils/export';

describe('toMarkdown', () => {
  const r = parseText(
    '2026-10-27 04:42:03 ERROR a | b `c` *d*\n  at Foo()\n2026-10-27 04:42:04 INFO ok\n',
  );
  const cols = r.schema.filter((c) => c.key !== 'logger');

  it('writes a summary and a table with escaped cells and first lines only', () => {
    const md = toMarkdown(r.rows, [0, 1], cols, { fileName: 'app_1.log', totalRows: 5, filters: ['Only errors'], errors: 1, timeRange: 'x → y' });
    expect(md).toBe(
      [
        '**app\\_1.log** · 2 of 5 rows · 1 errors',
        'Filters: Only errors',
        'Time: x → y',
        '',
        '| timestamp | level | message |',
        '| --- | --- | --- |',
        '| 2026-10-27 04:42:03 | ERROR | a \\| b \\`c\\` \\*d\\* … |',
        '| 2026-10-27 04:42:04 | INFO | ok |',
        '',
      ].join('\n'),
    );
  });

  it(`stops after ${MARKDOWN_MAX_ROWS} rows and says how many were left out`, () => {
    const many = Array.from({ length: 60 }, () => 0);
    const md = toMarkdown(r.rows, many, cols, { fileName: 'f', totalRows: 60, filters: [] });
    expect(md.split('\n').filter((l) => l.startsWith('| 2026'))).toHaveLength(MARKDOWN_MAX_ROWS);
    expect(md).toContain('…and 10 more rows.');
    expect(md.split('\n')[0]).toBe('**f** · 60 rows');
  });
});

describe('issueUrl', () => {
  it('builds a GitHub new-issue link and cuts long bodies', () => {
    const url = new URL(issueUrl('Title', 'x'.repeat(10_000)));
    expect(url.origin + url.pathname).toBe('https://github.com/anwarptr/Logsift/issues/new');
    expect(url.searchParams.get('title')).toBe('Title');
    expect(url.toString().length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(url.searchParams.get('body')).toMatch(/…\(cut\)\n```\n$/);
  });

  it('keeps the encoded URL under the limit for text that percent-encodes to 3× its length', () => {
    const logLine = '2026-10-27 04:42:03 | GET /api/x?a=[1]&b={2} | "quoted" : value\n';
    const url = issueUrl('Title', logLine.repeat(100));
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(url.length).toBeGreaterThan(MAX_URL_LENGTH - 200);
  });

  it('leaves short bodies whole', () => {
    expect(new URL(issueUrl('T', 'short body')).searchParams.get('body')).toBe('short body');
  });
});
