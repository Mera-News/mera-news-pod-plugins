#!/usr/bin/env node
// Builds Mera News for AI apps:
//  - dist/server.cjs, dist/mcp-plugin.cjs and dist/web-plugin.cjs: the pod, the client and the mcp
//    and web plugins as plain-Node files (the pod loads its plugins from a file, so each plugin is its
//    own file), and dist/web/: the website the web plugin serves, built by packages/web first;
//  - plugins/mera-news/server/: the same files, for the apps' plugin marketplaces, which install
//    from git and so cannot run npm;
//  - dist/mera-news.mcpb: the one-file desktop extension (MCP Bundle format).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const repo = path.resolve(pkg, '../..');
const dist = path.join(pkg, 'dist');
const pluginDir = path.join(repo, 'plugins/mera-news');
const web = path.join(repo, 'packages/web');
const site = path.join(web, 'site/out');
if (!fs.existsSync(path.join(site, 'index.html'))) throw new Error('The website is not built: run npm run build in packages/web first.');

fs.rmSync(dist, { recursive: true, force: true });
// Minified (names kept, for readable errors): the plugin directory refuses any file over 5 MiB.
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning', legalComments: 'none', minify: true, keepNames: true };
const metas = [
  await build({ ...common, metafile: true, entryPoints: [path.join(pkg, 'src/server.ts')], outfile: path.join(dist, 'server.cjs') }),
  await build({ ...common, metafile: true, entryPoints: [path.join(repo, 'packages/mcp/src/index.ts')], outfile: path.join(dist, 'mcp-plugin.cjs') }),
  await build({ ...common, metafile: true, entryPoints: [path.join(web, 'src/index.ts')], outfile: path.join(dist, 'web-plugin.cjs') }),
].map((r) => r.metafile);
fs.cpSync(site, path.join(dist, 'web'), { recursive: true });

// Every package bundled in, with its licence text: the bundle is a copy of them, and their licences ask for it.
const packages = new Map();
for (const meta of metas) {
  for (const input of Object.keys(meta.inputs)) {
    const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (m) packages.set(m[2], path.resolve(m[1]));
  }
}
const notice = ([name, dir]) => {
  const { version, license } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const text = (re) => {
    const file = fs.readdirSync(dir).find((f) => re.test(f));
    return file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : undefined;
  };
  // An Apache-2.0 package's NOTICE file travels with it.
  const parts = [text(/^(licen[cs]e|copying)(\.|$)/i) ?? `Licence: ${license ?? 'see the package'}`, text(/^notice(\.|$)/i)].filter(Boolean);
  return `${name}${version ? ` ${version}` : ''}\n\n${parts.join('\n\n')}\n`;
};
const notices = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(notice);
// The website's packages never pass through esbuild: packages/web/notices.json lists what reaches the browser.
// npm may nest a package under the one that needs it, so search every node_modules level, shallowest first.
const where = (name) => {
  const queue = [path.join(web, 'node_modules'), path.join(repo, 'node_modules')];
  while (queue.length) {
    const nm = queue.shift();
    if (!fs.existsSync(nm)) continue;
    const dir = path.join(nm, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    for (const entry of fs.readdirSync(nm)) {
      const dirs = entry.startsWith('@') ? fs.readdirSync(path.join(nm, entry)).map((s) => path.join(nm, entry, s)) : [path.join(nm, entry)];
      for (const d of dirs) if (fs.existsSync(path.join(d, 'node_modules'))) queue.push(path.join(d, 'node_modules'));
    }
  }
  return undefined;
};
const browser = JSON.parse(fs.readFileSync(path.join(web, 'notices.json'), 'utf8')).shipped.map((name) => {
  if (!where(name)) throw new Error(`${name} is listed in packages/web/notices.json but not installed.`);
  return notice([name, where(name)]);
});
fs.writeFileSync(
  path.join(dist, 'THIRD-PARTY-NOTICES.txt'),
  `Packages included in this bundle, with their licences.\n\n${notices.join('\n----\n\n')}\n----\n\nPackages included in the website (server/web), with their licences.\n\n${browser.join('\n----\n\n')}`,
);
const FILES = ['server.cjs', 'mcp-plugin.cjs', 'web-plugin.cjs', 'THIRD-PARTY-NOTICES.txt'];
const copyAll = (to) => {
  fs.rmSync(path.join(to, 'web'), { recursive: true, force: true });
  for (const f of FILES) fs.copyFileSync(path.join(dist, f), path.join(to, f));
  fs.cpSync(path.join(dist, 'web'), path.join(to, 'web'), { recursive: true });
};

const serverDir = path.join(pluginDir, 'server');
fs.mkdirSync(serverDir, { recursive: true });
copyAll(serverDir);

// The extension: manifest.json at the root, the two files under server/, the icon.
const stage = path.join(dist, 'mcpb');
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
copyAll(path.join(stage, 'server'));
// The desktop app refuses a prompt its manifest does not declare, and a declared prompt needs its text:
// take both from the server's own prompts so they cannot drift.
await build({ ...common, entryPoints: [path.join(repo, 'packages/mcp/src/text.ts')], outfile: path.join(dist, 'text.cjs') });
const { prompts } = createRequire(import.meta.url)(path.join(dist, 'text.cjs'));
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'), 'utf8'));
manifest.prompts = Object.entries(prompts).map(([name, p]) => ({ name, description: p.description, text: p.text }));
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(pluginDir, 'assets/icon.png'), path.join(stage, 'icon.png'));
for (const f of ['LICENSE', 'TRADEMARK.md']) fs.copyFileSync(path.join(repo, f), path.join(stage, f));
// The desktop app refuses a manifest its schema rejects, with no reason shown: fail the build instead.
execFileSync(path.join(repo, 'node_modules/.bin/mcpb'), ['validate', path.join(stage, 'manifest.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync('zip', ['-q', '-r', '-X', path.join(dist, 'mera-news.mcpb'), '.'], { cwd: stage });

// The plugin directory refuses any file over 5 MiB.
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const f of files(serverDir)) if (fs.statSync(f).size > 5 * 1024 * 1024) throw new Error(`${path.relative(repo, f)} is over 5 MiB.`);

const size = (f) => `${(fs.statSync(f).size / 1e6).toFixed(1)} MB`;
console.log(`dist/server.cjs ${size(path.join(dist, 'server.cjs'))}, dist/mera-news.mcpb ${size(path.join(dist, 'mera-news.mcpb'))}`);
