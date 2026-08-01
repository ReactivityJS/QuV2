#!/usr/bin/env node
/**
 * BUILD ALL — bundles every package and the browser demo into minified,
 * fully self-contained output files under each package's `dist/` (gitignored
 * build output, not checked in - run `npm run build` to (re)generate it).
 *
 * "Fully self-contained" matters for two reasons:
 *   1. @qu/loader's `loadRemote()` imports a remote package's main module
 *      via a `data:` URL, which has no base URL to resolve relative/bare
 *      imports from - a remote-loadable package MUST ship as one file with
 *      nothing left to resolve. Bundling with `bundle: true` and leaving
 *      `@qu/*` un-external inlines every workspace dependency, so
 *      `dist/index.min.js` never needs another `@qu/...` package installed
 *      wherever it ends up running.
 *   2. It also means any package can be dropped straight into a browser
 *      via a single `<script type="module">`, with no import map or bundler
 *      required on the consuming side.
 *
 * `ws` is the one dependency left external for @qu/relay: it's a native
 * Node module wrapper, not something meant to run in a browser or be
 * inlined, and Node can resolve it normally wherever @qu/relay is installed.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import esbuild from 'esbuild';

const ROOT = new URL('..', import.meta.url).pathname;

async function findPackages(groupDir) {
  const dir = join(ROOT, groupDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(dir, entry.name, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      packages.push({ name: pkg.name ?? entry.name, dir: join(dir, entry.name), pkg });
    } catch {
      // no package.json - not a bundleable package (e.g. apps/notes ships plain JS with no deps)
    }
  }
  return packages;
}

// Packages that touch Node builtins (fs, path, http, ...) and are never
// meant to run in a browser - bundled with platform: 'node' so those
// builtins stay external instead of esbuild trying (and failing) to
// resolve them as regular packages.
const NODE_ONLY_PACKAGES = new Set(['@qu/loader', '@qu/relay']);

async function buildPackage({ name, dir, pkg }) {
  const entry = join(dir, pkg.main ?? 'src/index.js');
  const outfile = join(dir, 'dist', 'index.min.js');
  const isNode = NODE_ONLY_PACKAGES.has(name);

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'esm',
    platform: isNode ? 'node' : 'neutral',
    target: isNode ? 'node20' : 'es2022',
    external: isNode ? ['ws'] : [],
    logLevel: 'warning',
  });
  console.log(`  ${name} -> ${outfile.replace(ROOT, '')}`);
}

/** Bundles a single browser entry point (an app's UI, not a workspace package). */
async function buildBrowserApp(label, entryRelPath, outfileRelPath) {
  const entry = join(ROOT, entryRelPath);
  const outfile = join(ROOT, outfileRelPath);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
  });
  console.log(`  ${label} -> ${outfile.replace(ROOT, '')}`);
}

console.log('Building packages...');
const packages = await findPackages('packages');
for (const p of packages) await buildPackage(p);

console.log('Building browser apps...');
await buildBrowserApp('demo app', 'apps/demo/src/main.js', 'apps/demo/dist/bundle.js');
await buildBrowserApp('shell', 'apps/shell/src/main.js', 'apps/shell/dist/bundle.js');
// Every app below is served by @qu/relay under /apps/<name>/dist/client.js
// (see each manifest.quapp's clientMain) - each needs bundling for the same
// reason as the shell: bare imports like '@qu/ui'/'@qu/i18n' don't resolve
// in a raw browser.
await buildBrowserApp('notes client', 'apps/notes/client.js', 'apps/notes/dist/client.js');
await buildBrowserApp('app-list client', 'apps/app-list/client.js', 'apps/app-list/dist/client.js');
await buildBrowserApp('user-list client', 'apps/user-list/client.js', 'apps/user-list/dist/client.js');
await buildBrowserApp('contact-list client', 'apps/contact-list/client.js', 'apps/contact-list/dist/client.js');
await buildBrowserApp('relay-admin client', 'apps/relay-admin/client.js', 'apps/relay-admin/dist/client.js');
await buildBrowserApp('profile client', 'apps/profile/client.js', 'apps/profile/dist/client.js');
await buildBrowserApp('forum client', 'apps/forum/client.js', 'apps/forum/dist/client.js');
await buildBrowserApp('chat client', 'apps/chat/client.js', 'apps/chat/dist/client.js');
await buildBrowserApp('inbox client', 'apps/inbox/client.js', 'apps/inbox/dist/client.js');
await buildBrowserApp('todo client', 'apps/todo/client.js', 'apps/todo/dist/client.js');

console.log('Done.');
