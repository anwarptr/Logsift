import type { LiveDirHandle, LiveFileHandle } from '../../src/live/watcher';

/** An in-memory file whose content can grow, behind a File System Access-style handle. */
export class FakeFile implements LiveFileHandle {
  kind = 'file' as const;
  modified = Date.UTC(2026, 9, 27, 12);
  deleted = false;
  constructor(
    public name: string,
    public content = '',
  ) {}
  append(text: string) {
    this.content += text;
    this.modified += 1000;
  }
  async getFile(): Promise<File> {
    if (this.deleted) throw new DOMException('gone', 'NotFoundError');
    return new File([this.content], this.name, { lastModified: this.modified });
  }
}

export class FakeDir implements LiveDirHandle {
  kind = 'directory' as const;
  entries: (FakeFile | FakeDir)[] = [];
  constructor(public name: string) {}
  add<T extends FakeFile | FakeDir>(e: T): T {
    this.entries.push(e);
    return e;
  }
  async *values() {
    for (const e of this.entries) if (!(e instanceof FakeFile && e.deleted)) yield e;
  }
}
