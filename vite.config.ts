/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
