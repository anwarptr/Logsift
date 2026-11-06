/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Content Security Policy of the built app: only its own scripts, styles and workers, and no network
 * access beyond its own origin (the launcher's /stream). It also guards the Kudu bookmarklet, which trusts
 * whatever runs on this origin. Build only: the dev server injects inline scripts (React refresh).
 * frame-ancestors and HSTS can't be set by a <meta>; they belong in the host's response headers.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'logsift-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  plugins: [react(), csp()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  base: './',
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/perf/**', 'node_modules/**'],
    // Fixed local zone so "local time" assertions are deterministic (UTC+4, no DST).
    env: { TZ: 'Asia/Dubai' },
  },
});
