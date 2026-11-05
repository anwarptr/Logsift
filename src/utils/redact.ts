/**
 * Mask what is likely personal or secret in log lines before they are shared (a parsing problem
 * report): IP addresses, e-mail addresses, GUIDs, JWTs, bearer tokens, secret query values and
 * long opaque tokens. The result keeps the line's shape, which is what matters for parsing.
 */
const RULES: [RegExp, string][] = [
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>'],
  // After an Authorization header any credential is masked; elsewhere only one that has a digit
  // or one of + / = (so "Basic authentication failed" is kept).
  [/\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Digest|Negotiate|NTLM)?\s*)[\w.~+/=-]{8,}/gi, '$1<token>'],
  [/\b(Bearer|Basic)\s+(?=[\w.~+/=-]*[\d+/=])[\w.~+/=-]{8,}/g, '$1 <token>'],
  [/([?&;]|\b)(access_token|token|api_?key|key|password|passwd|pwd|secret|sig|signature|code|auth)=[^&\s"';]+/gi, '$1$2=<redacted>'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'user@example.com'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '00000000-0000-0000-0000-000000000000'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '192.0.2.1'],
  // IPv6: compressed ("fe80::1") or with 4+ groups, so times like 04:42:03 are left alone.
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi, '2001:db8::1'],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '2001:db8::1'],
  [/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}\b/g, '<token>'],
];

export function redactLine(line: string): string {
  let s = line;
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}

export function redactLines(lines: readonly string[]): string[] {
  return lines.map(redactLine);
}
