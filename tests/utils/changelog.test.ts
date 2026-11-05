import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inlineParts, parseChangelog } from '../../src/utils/changelog';

describe('CHANGELOG.md', () => {
  const releases = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'));
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

  it('has an entry for the version in package.json, newest first', () => {
    expect(releases[0]!.version).toBe(version);
    const dates = releases.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const r of releases) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.groups.flatMap((g) => g.items).length).toBeGreaterThan(0);
    }
  });
});

describe('parseChangelog', () => {
  it('reads releases, groups, multi-line items and notes', () => {
    const md = [
      '# Changelog',
      'Intro text.',
      '## 1.1.0 — 2026-11-05',
      '### New',
      '- First item',
      '  continued here.',
      '- Second',
      '### Fixed',
      '- A bug',
      '## [1.0.0] - 2026-10-01',
      'First release.',
      '- Everything',
    ].join('\n');
    expect(parseChangelog(md)).toEqual([
      {
        version: '1.1.0',
        date: '2026-11-05',
        notes: [],
        groups: [
          { title: 'New', items: ['First item continued here.', 'Second'] },
          { title: 'Fixed', items: ['A bug'] },
        ],
      },
      { version: '1.0.0', date: '2026-10-01', notes: ['First release.'], groups: [{ title: '', items: ['Everything'] }] },
    ]);
  });

  it('splits bold, italic and code', () => {
    expect(inlineParts('Use **Open folder…** or `>>` in *PowerShell*.')).toEqual([
      { text: 'Use ' },
      { text: 'Open folder…', style: 'bold' },
      { text: ' or ' },
      { text: '>>', style: 'code' },
      { text: ' in ' },
      { text: 'PowerShell', style: 'italic' },
      { text: '.' },
    ]);
  });
});
