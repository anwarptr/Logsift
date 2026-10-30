const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUM_RE = /^\d+$/;
const HEX_RE = /^[0-9a-f]{16,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[t_ ]?\d{2}[:.]?\d{2}(?:[:.]?\d{2})?)?$/;
const TOKEN_RE = /^[a-z0-9_\-=.~%]{20,}$/;

function normalizeSegment(seg: string): string {
  if (seg === '') return seg;
  if (NUM_RE.test(seg)) return '{id}';
  if (GUID_RE.test(seg)) return '{guid}';
  if (DATE_RE.test(seg)) return '{date}';
  if (HEX_RE.test(seg) && /\d/.test(seg)) return '{hash}';
  // Long opaque ids (base64/url-safe tokens): letters and digits mixed, no extension-like ending.
  if (TOKEN_RE.test(seg) && /\d/.test(seg) && /[a-z]/.test(seg) && !/\.[a-z]{2,4}$/.test(seg)) return '{token}';
  return seg;
}

/**
 * Group key for a URI path: lower-cased (IIS paths are case-insensitive), trailing slash removed,
 * and variable segments replaced: numbers → {id}, GUIDs → {guid}, dates → {date}, long hex → {hash},
 * long opaque tokens → {token}. "/api/Products/123/" → "/api/products/{id}". Full URLs (as in CSV exports)
 * are grouped by their path, without scheme, host or query.
 */
export function uriPattern(uri: string): string {
  const path = uri.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/, '').replace(/[?#].*$/, '');
  const segs = path.split('/').map(normalizeSegment);
  let out = segs.join('/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out || '/';
}
