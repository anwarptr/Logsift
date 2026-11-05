#!/usr/bin/env node
// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { createLogServer } from '../lib/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const HELP = `Logsift ${version}: watch a log stream live in your browser. Nothing leaves your computer.

Usage:
  npx logsift --azure <app> -g <resource-group> [--slot <slot>] [--subscription <id>]
      Runs "az webapp log tail" for an Azure App Service app and shows its log live.
      Needs the Azure CLI, signed in (az login).

  <command> | npx logsift [--name <label>]
      Shows whatever the command writes, e.g.
        kubectl logs -f deploy/api | npx logsift
        docker logs -f api 2>&1 | npx logsift
        ssh my-vm "tail -F /var/log/app.log" | npx logsift

Options:
  --name <label>   Name shown in Logsift (default: the command, or "stdin")
  --port <n>       Port on 127.0.0.1 (default: a free one)
  --no-open        Don't open the browser; print the address instead
  -h, --help       This help
  -v, --version    The version

The page is served on 127.0.0.1 only. Press Ctrl+C to stop.`;

/** Whether the Azure CLI is on the PATH. */
function azureCliFound() {
  const r = process.platform === 'win32' ? spawnSync('where', ['az'], { stdio: 'ignore' }) : spawnSync('sh', ['-c', 'command -v az'], { stdio: 'ignore' });
  return r.status === 0;
}

/** @param {string} url */
function openBrowser(url) {
  const opts = /** @type {const} */ ({ stdio: 'ignore', detached: true });
  const child =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', `start "" "${url}"`], { ...opts, windowsVerbatimArguments: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts);
  child.on('error', () => console.error(`Open this address in your browser: ${url}`));
  child.unref();
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (o.help) return console.log(HELP);
  if (o.version) return console.log(version);
  if (!o.azure && process.stdin.isTTY) {
    console.log(HELP);
    process.exit(1);
  }
  if (!existsSync(join(appDir, 'index.html'))) {
    console.error('The Logsift app is missing from this package (run "npm run build:cli" in the repository).');
    process.exit(1);
  }

  if (o.azure && !azureCliFound()) {
    console.error('The Azure CLI (az) was not found. Install it from https://aka.ms/installazurecli, run "az login", then try again.');
    process.exit(1);
  }

  const token = randomBytes(24).toString('hex');
  const server = await createLogServer({ appDir, token, port: o.port ?? 0 });
  const label = o.name ?? (o.azure ? `${o.azure} (App Service)` : 'stdin');

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {NodeJS.ReadableStream} */
  let input = process.stdin;
  if (o.azure) {
    const args = ['webapp', 'log', 'tail', '--name', o.azure, '--resource-group', /** @type {string} */ (o.group)];
    if (o.slot) args.push('--slot', o.slot);
    if (o.subscription) args.push('--subscription', o.subscription);
    // az is a Python program: ask it for UTF-8, whatever the console code page.
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const stdio = /** @type {const} */ (['ignore', 'pipe', 'inherit']);
    // On Windows az is az.cmd, which only cmd.exe can run; the arguments were checked to be plain names.
    child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', `"az ${args.join(' ')}"`], { stdio, env, windowsVerbatimArguments: true })
        : spawn('az', args, { stdio, env });
    child.on('error', () => {});
    input = /** @type {NodeJS.ReadableStream} */ (child.stdout);
  }

  input.on('data', (chunk) => server.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  input.on('end', () => {
    server.end();
    const report = () => {
      const code = child?.exitCode ?? null;
      console.error(
        `\nThe ${o.azure ? 'log stream' : 'input'} ended${code ? ` (az exited with code ${code})` : ''}. ` +
          'Logsift keeps showing what it received; press Ctrl+C to quit.',
      );
    };
    // The exit code is known a moment after the output ends.
    if (child && child.exitCode === null) child.once('exit', report);
    else report();
  });

  const query = new URLSearchParams({ stream: `/stream?token=${token}`, name: label });
  const url = `http://127.0.0.1:${server.port}/?${query.toString()}`;
  console.error(`Logsift is showing ${label} at ${url}\nPress Ctrl+C to stop.`);
  if (o.open) openBrowser(url);

  const stop = () => {
    child?.kill();
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
