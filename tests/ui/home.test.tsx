// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HomePage } from '../../src/components/HomePage';

afterEach(cleanup);

describe('HomePage', () => {
  it('credits the author with the version and a link to the source', () => {
    render(<HomePage />);
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const footer = screen.getByRole('contentinfo');
    expect(footer.textContent).toContain(`Logsift v${version}`);
    expect(footer.textContent).toContain('Made by Anwar');
    expect(footer.textContent).toContain('MIT license');
    const link = screen.getByRole('link', { name: 'Source on GitHub' });
    expect(link.getAttribute('href')).toBe('https://github.com/anwar-sobha/Logsift');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
