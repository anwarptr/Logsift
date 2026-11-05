// Copy the built app (dist/) into the npm package (cli/app/) and give the package the app's version.
// Run with "npm run build:cli" (which builds the app first); then publish from cli/ with "npm publish".
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dist = join(root, 'dist');
const app = join(root, 'cli', 'app');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ is missing: run "npm run build" first.');
  process.exit(1);
}
rmSync(app, { recursive: true, force: true });
cpSync(dist, app, { recursive: true });
// The launcher serves the app fresh on a new port each run: no offline cache.
rmSync(join(app, 'sw.js'), { force: true });

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pkgFile = join(root, 'cli', 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
pkg.version = version;
writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
console.log(`cli/app/ updated from dist/ (version ${version}). Publish with: cd cli && npm publish`);
