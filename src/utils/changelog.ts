/**
 * Reads CHANGELOG.md (bundled into the app) for the "What's new" part of the Help:
 *   ## 0.3.0 — 2026-11-05      a release ("## 0.4.0 (beta)" and "## [0.4.0] 2026-12-01" work too)
 *   ### New                    a group
 *   - item, continued on        an item (indented lines continue it)
 *     the next line
 *   Any other text             a paragraph (lines up to a blank line are joined)
 * Text before the first release (the file's title and intro) is skipped. Blocks keep their order.
 */

export type ChangelogBlock = { kind: 'group'; title: string; items: string[] } | { kind: 'text'; text: string };

export interface Release {
  version: string;
  /** YYYY-MM-DD when the heading has one, else whatever follows the version ("beta"). */
  date: string;
  blocks: ChangelogBlock[];
}

const RELEASE_RE = /^##\s+\[?(v?\d[\w.+-]*)\]?(.*)$/;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: (ChangelogBlock & { kind: 'group' }) | null = null;
  let item: string[] | null = null;
  let para: string[] | null = null;

  const flush = () => {
    if (release && item) {
      if (!group) {
        group = { kind: 'group', title: '', items: [] };
        release.blocks.push(group);
      }
      group.items.push(item.join(' '));
    }
    if (release && para) release.blocks.push({ kind: 'text', text: para.join(' ') });
    item = null;
    para = null;
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const r = RELEASE_RE.exec(line);
    if (r) {
      flush();
      const rest = r[2]!.trim();
      const date = DATE_RE.exec(rest)?.[0] ?? rest.replace(/^[—–-]\s*/, '').replace(/^\((.*)\)$/, '$1');
      release = { version: r[1]!, date, blocks: [] };
      releases.push(release);
      group = null;
      continue;
    }
    if (!release) continue;
    if (line.startsWith('### ')) {
      flush();
      group = { kind: 'group', title: line.slice(4).trim(), items: [] };
      release.blocks.push(group);
    } else if (/^[-*]\s+/.test(line)) {
      flush();
      item = [line.replace(/^[-*]\s+/, '')];
    } else if (item && /^\s+\S/.test(line)) {
      item.push(line.trim());
    } else if (line.trim() !== '') {
      if (item) flush();
      // A paragraph ends the group above it: items after it start a new (untitled) group.
      if (!para) group = null;
      (para ??= []).push(line.trim());
    } else {
      flush();
    }
  }
  flush();
  return releases;
}

/** All items of a release (for checks). */
export const releaseItems = (r: Release): string[] => r.blocks.flatMap((b) => (b.kind === 'group' ? b.items : []));

export type InlinePart = { text: string; style?: 'bold' | 'italic' | 'code' };

/**
 * Split `**bold**`, `*italic*` and `` `code` `` out of a line of Markdown. As in Markdown, an asterisk
 * inside a word or before a space is literal, so `u_ex*.log and *.txt` stays as written.
 */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /\*\*(?!\s)(.+?)(?<!\s)\*\*|`([^`]+)`|(?<![\w*])\*(?![\s*])([^*]+?)(?<![\s*])\*(?![\w*])/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ text: m[1], style: 'bold' });
    else if (m[2] !== undefined) parts.push({ text: m[2], style: 'code' });
    else parts.push({ text: m[3]!, style: 'italic' });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
