#!/usr/bin/env node
// Builds Mera News for AI apps:
//  - dist/server.cjs and dist/mcp-plugin.cjs: the pod, the client and the mcp plugin as two plain-Node
//    files (the pod loads its plugins from a file, so the plugin is its own file);
//  - plugins/mera-news/server/: the same two files, for the apps' plugin marketplaces, which install
//    from git and so cannot run npm;
//  - dist/mera-news.mcpb: the one-file desktop extension (MCP Bundle format).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const repo = path.resolve(pkg, '../..');
const dist = path.join(pkg, 'dist');
const pluginDir = path.join(repo, 'plugins/mera-news');

fs.rmSync(dist, { recursive: true, force: true });
// Minified (names kept, for readable errors): the plugin directory refuses any file over 5 MiB.
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning', legalComments: 'none', minify: true, keepNames: true };
const metas = [
  await build({ ...common, metafile: true, entryPoints: [path.join(pkg, 'src/server.ts')], outfile: path.join(dist, 'server.cjs') }),
  await build({ ...common, metafile: true, entryPoints: [path.join(repo, 'packages/mcp/src/index.ts')], outfile: path.join(dist, 'mcp-plugin.cjs') }),
].map((r) => r.metafile);

// Every package bundled in, with its licence text: the bundle is a copy of them, and their licences ask for it.
const packages = new Map();
for (const meta of metas) {
  for (const input of Object.keys(meta.inputs)) {
    const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (m) packages.set(m[2], path.resolve(m[1]));
  }
}
const notices = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
  const { version, license } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : `Licence: ${license ?? 'see the package'}`;
  return `${name} ${version}\n\n${text}\n`;
});
fs.writeFileSync(path.join(dist, 'THIRD-PARTY-NOTICES.txt'), `Packages included in this bundle, with their licences.\n\n${notices.join('\n----\n\n')}`);

const serverDir = path.join(pluginDir, 'server');
fs.mkdirSync(serverDir, { recursive: true });
for (const f of ['server.cjs', 'mcp-plugin.cjs', 'THIRD-PARTY-NOTICES.txt']) fs.copyFileSync(path.join(dist, f), path.join(serverDir, f));

// The extension: manifest.json at the root, the two files under server/, the icon.
const stage = path.join(dist, 'mcpb');
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
for (const f of ['server.cjs', 'mcp-plugin.cjs', 'THIRD-PARTY-NOTICES.txt']) fs.copyFileSync(path.join(dist, f), path.join(stage, 'server', f));
fs.copyFileSync(path.join(pkg, 'manifest.json'), path.join(stage, 'manifest.json'));
fs.copyFileSync(path.join(pluginDir, 'assets/icon.png'), path.join(stage, 'icon.png'));
for (const f of ['LICENSE', 'TRADEMARK.md']) fs.copyFileSync(path.join(repo, f), path.join(stage, f));
execFileSync('zip', ['-q', '-r', '-X', path.join(dist, 'mera-news.mcpb'), '.'], { cwd: stage });

const size = (f) => `${(fs.statSync(f).size / 1e6).toFixed(1)} MB`;
console.log(`dist/server.cjs ${size(path.join(dist, 'server.cjs'))}, dist/mera-news.mcpb ${size(path.join(dist, 'mera-news.mcpb'))}`);
