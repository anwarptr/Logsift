import type { CellValue, ColumnDef, ColumnRole, ColumnType } from './types';

/** Accumulates the union of columns seen across a file, preserving first-seen order. */
export class SchemaBuilder {
  private cols = new Map<string, ColumnDef>();
  /** Columns registered from null values only; their type is decided by the first non-null value. */
  private untyped = new Set<string>();

  add(def: ColumnDef): void {
    if (!this.cols.has(def.key)) this.cols.set(def.key, { ...def });
  }

  has(key: string): boolean {
    return this.cols.has(key);
  }

  /** Change the role of an existing column (e.g. when a better source for that role appears). */
  setRole(key: string, role: ColumnRole | undefined): void {
    const col = this.cols.get(key);
    if (col) col.role = role;
  }

  /** Register a column from an observed value, widening its type to string on conflict. */
  observe(key: string, value: CellValue, role?: ColumnRole): void {
    const existing = this.cols.get(key);
    if (value === null) {
      if (!existing) {
        this.cols.set(key, { key, label: key, type: 'string', role });
        this.untyped.add(key);
      }
      return;
    }
    const t: ColumnType = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    if (!existing) {
      this.cols.set(key, { key, label: key, type: t, role });
    } else if (this.untyped.has(key)) {
      existing.type = t;
      this.untyped.delete(key);
    } else if (existing.type !== t && existing.type !== 'timestamp') {
      existing.type = 'string';
    }
  }

  list(): ColumnDef[] {
    return [...this.cols.values()].map((c) => ({ ...c }));
  }
}

/** Shared timestamp column used by every format. */
export const TIMESTAMP_COLUMN: ColumnDef = { key: 'timestamp', label: 'timestamp', type: 'timestamp', role: 'timestamp' };

/** Added when several files are parsed together: the file each row came from. */
export const SOURCE_COLUMN: ColumnDef = { key: 'sourceFile', label: 'source file', type: 'string', role: 'source', derived: true };
