/**
 * Reads CHANGELOG.md (bundled into the app) for the "What's new" part of the Help:
 *   ## 0.3.0 — 2026-11-05      a release
 *   ### New                    a group
 *   - item, continued on        an item (indented lines continue it)
 *     the next line
 * Other lines (the file's title and intro, text under a release) are kept as plain paragraphs.
 */

export interface ChangelogGroup {
  title: string;
  items: string[];
}

export interface Release {
  version: string;
  date: string;
  /** Text right under the release heading. */
  notes: string[];
  groups: ChangelogGroup[];
}

const RELEASE_RE = /^##\s+\[?([^\]\s]+)\]?\s*(?:[—–-]\s*(.+))?$/;

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: ChangelogGroup | null = null;
  let item: string[] | null = null;
  const flushItem = () => {
    if (item && release) {
      if (!group) {
        group = { title: '', items: [] };
        release.groups.push(group);
      }
      group.items.push(item.join(' '));
    }
    item = null;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const r = RELEASE_RE.exec(line);
    if (r) {
      flushItem();
      release = { version: r[1]!, date: r[2]?.trim() ?? '', notes: [], groups: [] };
      releases.push(release);
      group = null;
      continue;
    }
    if (!release) continue;
    if (line.startsWith('### ')) {
      flushItem();
      group = { title: line.slice(4).trim(), items: [] };
      release.groups.push(group);
    } else if (/^[-*]\s+/.test(line)) {
      flushItem();
      item = [line.replace(/^[-*]\s+/, '')];
    } else if (item && /^\s+\S/.test(line)) {
      item.push(line.trim());
    } else if (line.trim() !== '') {
      flushItem();
      release.notes.push(line.trim());
    } else {
      flushItem();
    }
  }
  flushItem();
  return releases;
}

export type InlinePart = { text: string; style?: 'bold' | 'italic' | 'code' };

/** Split `**bold**`, `*italic*` and `` `code` `` out of a line of Markdown. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\*([^*]+)\*/g;
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
