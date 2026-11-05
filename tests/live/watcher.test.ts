import { describe, expect, it } from 'vitest';
import { chooseRecent, listFolder, LiveWatcher, MAX_DEPTH, type WatchTarget } from '../../src/live/watcher';
import { isAcceptedFile } from '../../src/store/logStore';
import { FakeDir, FakeFile } from './fakeFs';

/** A watcher whose `send` consumes whole lines and records what it was given. */
function setup(dir: FakeDir | null, targets: WatchTarget[], ignore?: Set<string>) {
  const sent: [string, string][] = [];
  const finals: [string, string][] = [];
  const checks: boolean[] = [];
  const w = new LiveWatcher({
    dir,
    targets,
    ignore,
    accept: isAcceptedFile,
    delayMs: () => 1_000_000,
    send: async (path, blob, _modified, final) => {
      const text = await blob.text();
      if (final) {
        finals.push([path, text]);
        return new TextEncoder().encode(text).length;
      }
      const nl = text.lastIndexOf('\n');
      if (nl < 0) return 0;
      sent.push([path, text.slice(0, nl + 1)]);
      return new TextEncoder().encode(text.slice(0, nl + 1)).length;
    },
    onCheck: (changed) => checks.push(changed),
  });
  return { w, sent, finals, checks };
}

describe('listFolder', () => {
  it('finds log files in sub-folders, sorted by path, up to the depth limit', async () => {
    const root = new FakeDir('LogFiles');
    root.add(new FakeFile('readme.md'));
    root.add(new FakeFile('b.log'));
    const w3 = root.add(new FakeDir('W3SVC1'));
    w3.add(new FakeFile('u_ex261027.log'));
    w3.add(new FakeFile('old.zip'));
    root.add(new FakeDir('.git')).add(new FakeFile('x.log'));
    let d = root;
    for (let i = 0; i <= MAX_DEPTH; i++) d = d.add(new FakeDir(`d${i}`));
    d.add(new FakeFile('too-deep.log'));
    const paths = (await listFolder(root, isAcceptedFile)).map((e) => e.path);
    expect(paths).toEqual(['b.log', 'W3SVC1/old.zip', 'W3SVC1/u_ex261027.log']);
  });
});

describe('chooseRecent', () => {
  const entry = (name: string, size: number, lastModified: number) => ({
    name,
    file: new File(['x'.repeat(size)], name, { lastModified }),
  });

  it('keeps the newest non-empty files within the limits', () => {
    const entries = [entry('old', 10, 1), entry('new', 10, 3), entry('mid', 10, 2), entry('empty', 0, 4)];
    expect(chooseRecent(entries, 2).chosen.map((e) => e.name)).toEqual(['new', 'mid']);
    expect(chooseRecent(entries, 2).skipped).toBe(1);
    expect(chooseRecent(entries, 10, 25).chosen.map((e) => e.name)).toEqual(['new', 'mid']);
    // The newest file is always taken, even over the byte limit.
    expect(chooseRecent([entry('big', 100, 1)], 10, 5).chosen).toHaveLength(1);
  });
});

describe('LiveWatcher', () => {
  it('reads the rest of a file once it stops growing (an unfinished last line, an open entry)', async () => {
    const f = new FakeFile('app.log', 'one\ntw');
    const { w, sent, finals } = setup(null, [{ path: 'app.log', handle: f, offset: 4, lastSize: 6 }]);
    w.start();
    await w.check(); // unchanged since it was opened: the held "tw" is read as the last line
    expect(finals).toEqual([['app.log', 'tw']]);
    f.append('o more\nthree\n');
    await w.check(); // growing: whole lines only, the entry stays open
    expect(sent).toEqual([['app.log', 'o more\nthree\n']]);
    await w.check(); // stopped growing: close it (nothing left to read)
    expect(finals).toEqual([['app.log', 'tw'], ['app.log', '']]);
    await w.check(); // nothing open any more
    expect(finals).toHaveLength(2);
    w.stop();
  });

  it('leaves out the files that were left out when the folder was opened', async () => {
    const dir = new FakeDir('logs');
    const a = dir.add(new FakeFile('a.log', 'a1\n'));
    dir.add(new FakeFile('old.log', 'o1\n'));
    const { w, sent } = setup(dir, [{ path: 'a.log', handle: a, offset: 3, lastSize: 3 }], new Set(['old.log']));
    w.start();
    dir.add(new FakeFile('new.log', 'n1\n'));
    await w.check();
    expect(sent).toEqual([['new.log', 'n1\n']]);
    expect(w.fileCount).toBe(2);
    w.stop();
  });

  it('sends only bytes written since the last read, in whole lines', async () => {
    const f = new FakeFile('app.log', 'one\n');
    const { w, sent, checks } = setup(null, [{ path: 'app.log', handle: f, offset: 4 }]);
    w.start();
    expect(await w.check()).toBe(false);
    f.append('two\nthr');
    expect(await w.check()).toBe(true);
    f.append('ee\n');
    await w.check();
    expect(sent).toEqual([
      ['app.log', 'two\n'],
      ['app.log', 'three\n'],
    ]);
    expect(checks).toEqual([false, true, true]);
    w.stop();
  });

  it('picks up new files in the folder, but not compressed ones', async () => {
    const dir = new FakeDir('logs');
    const a = dir.add(new FakeFile('a.log', 'a1\n'));
    const { w, sent } = setup(dir, [{ path: 'a.log', handle: a, offset: 3 }]);
    w.start();
    dir.add(new FakeFile('b.log', 'b1\nb2\n'));
    dir.add(new FakeFile('b.log.gz', 'zzz\n'));
    await w.check();
    expect(sent).toEqual([['b.log', 'b1\nb2\n']]);
    expect(w.fileCount).toBe(2);
    w.stop();
  });

  it('reads a truncated (rotated) file from the start and forgets deleted files', async () => {
    const f = new FakeFile('app.log', 'one\ntwo\n');
    const g = new FakeFile('other.log', 'x\n');
    const { w, sent } = setup(null, [
      { path: 'app.log', handle: f, offset: 8 },
      { path: 'other.log', handle: g, offset: 2 },
    ]);
    w.start();
    f.content = 'new\n';
    g.deleted = true;
    await w.check();
    expect(sent).toEqual([['app.log', 'new\n']]);
    expect(w.fileCount).toBe(1);
    w.stop();
  });

  it('does nothing once stopped', async () => {
    const f = new FakeFile('app.log', '');
    const { w, sent } = setup(null, [{ path: 'app.log', handle: f, offset: 0 }]);
    w.stop();
    f.append('one\n');
    expect(await w.check()).toBe(false);
    expect(sent).toEqual([]);
  });
});
