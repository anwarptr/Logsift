import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inlineParts, parseChangelog, releaseItems } from '../../src/utils/changelog';

describe('CHANGELOG.md', () => {
  const releases = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'));
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

  it('has an entry for the version in package.json, newest first', () => {
    expect(releases[0]!.version).toBe(version);
    const dates = releases.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const r of releases) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(releaseItems(r).length).toBeGreaterThan(0);
    }
  });
});

describe('parseChangelog', () => {
  it('reads releases, groups, multi-line items and paragraphs, in order', () => {
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
      '',
      'Thanks to everyone who',
      'reported it.',
      '## [1.0.0] - 2026-10-01',
      'First release.',
      '- Everything',
    ].join('\n');
    expect(parseChangelog(md)).toEqual([
      {
        version: '1.1.0',
        date: '2026-11-05',
        blocks: [
          { kind: 'group', title: 'New', items: ['First item continued here.', 'Second'] },
          { kind: 'group', title: 'Fixed', items: ['A bug'] },
          { kind: 'text', text: 'Thanks to everyone who reported it.' },
        ],
      },
      {
        version: '1.0.0',
        date: '2026-10-01',
        blocks: [
          { kind: 'text', text: 'First release.' },
          { kind: 'group', title: '', items: ['Everything'] },
        ],
      },
    ]);
  });

  it('accepts other release headings', () => {
    const versions = (md: string) => parseChangelog(md).map((r) => [r.version, r.date]);
    expect(versions('## 0.4.0 (beta)\n- a\n## 0.4.0 2026-12-01\n- b\n## v1.0.0\n- c\n')).toEqual([
      ['0.4.0', 'beta'],
      ['0.4.0', '2026-12-01'],
      ['v1.0.0', ''],
    ]);
    expect(versions('## Unreleased\n- x\n')).toEqual([]);
  });
});

describe('inlineParts', () => {
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

  it('keeps asterisks that are not emphasis, like file globs', () => {
    expect(inlineParts('Opens u_ex*.log and *.txt files')).toEqual([{ text: 'Opens u_ex*.log and *.txt files' }]);
    expect(inlineParts('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4' }]);
  });
});
