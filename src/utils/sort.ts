import type { ColumnDef, LogRow } from '../parser';

/**
 * Sort a set of row indices by one column. Values are extracted once into a flat
 * array so the comparator never touches row objects; nulls always sort last.
 */
export function sortIndices(
  rows: readonly LogRow[],
  indices: Uint32Array,
  col: ColumnDef,
  dir: 'asc' | 'desc',
): Uint32Array {
  const n = indices.length;
  const sign = dir === 'asc' ? 1 : -1;
  const out = Uint32Array.from(indices);
  const key = col.key;

  if (col.type === 'number' || col.type === 'timestamp' || col.type === 'boolean') {
    const vals = new Float64Array(rows.length);
    for (let i = 0; i < n; i++) {
      const idx = indices[i]!;
      const v = rows[idx]!.values[key];
      vals[idx] = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number.NaN;
    }
    out.sort((a, b) => {
      const va = vals[a]!;
      const vb = vals[b]!;
      const na = Number.isNaN(va);
      const nb = Number.isNaN(vb);
      if (na || nb) return na === nb ? a - b : na ? 1 : -1;
      return va === vb ? a - b : (va - vb) * sign;
    });
    return out;
  }

  const vals: (string | null)[] = new Array(rows.length);
  for (let i = 0; i < n; i++) {
    const idx = indices[i]!;
    const v = rows[idx]!.values[key];
    vals[idx] = v === null || v === undefined ? null : String(v).toLowerCase();
  }
  out.sort((a, b) => {
    const va = vals[a] ?? null;
    const vb = vals[b] ?? null;
    if (va === null || vb === null) return va === vb ? a - b : va === null ? 1 : -1;
    return va === vb ? a - b : va < vb ? -sign : sign;
  });
  return out;
}
