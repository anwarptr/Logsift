import { useMemo } from 'react';
import type { ColumnDef } from '../parser';
import { sortIndices } from '../utils/sort';
import { useLogStore } from './logStore';

/** Visible columns in display order. */
export function useVisibleColumns(): ColumnDef[] {
  const schema = useLogStore((s) => s.schema);
  const order = useLogStore((s) => s.columnOrder);
  const hidden = useLogStore((s) => s.hiddenColumns);
  return useMemo(() => {
    const byKey = new Map(schema.map((c) => [c.key, c]));
    return order.filter((k) => !hidden[k]).map((k) => byKey.get(k)).filter((c): c is ColumnDef => c !== undefined);
  }, [schema, order, hidden]);
}

/** Apply the current sort to a set of row indices. */
export function useSortedIndices(indices: Uint32Array): Uint32Array {
  const rows = useLogStore((s) => s.rows);
  const schema = useLogStore((s) => s.schema);
  const sort = useLogStore((s) => s.sort);
  return useMemo(() => {
    if (!sort) return indices;
    const col = schema.find((c) => c.key === sort.key);
    return col ? sortIndices(rows, indices, col, sort.dir) : indices;
  }, [rows, schema, sort, indices]);
}
