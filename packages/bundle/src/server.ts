// The one program an AI app starts. It runs the pod for this home, or finds the one already running,
// and relays the app's standard input and output to the pod's mcp plugin. Standard output carries
// only MCP messages, so every log line goes to standard error, set before the pod loads.
console.log = console.info = console.debug = console.error;

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type * as Embed from 'mera-news-pod/embed';
// The bridge is bundled from source with this file, so the mcp package need not be built first.
import { runBridge } from '../../mcp/src/bin/bridge';

/** Mera News' own news server. A key from Mera Labs unlocks it. */
export const MERA_NEWS_DATA_SERVER = 'https://api.mera.news';
const PLUGIN_FILE = 'mcp-plugin.cjs';
const START_TIMEOUT_MS = 30_000;

interface PluginEntry {
  package: string;
  config?: { port?: number };
}

const oneLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const isMcp = (p: PluginEntry) => /(^|[\\/])(mcp|mera-news-pod-mcp|mcp-plugin\.cjs)[\\/]?$/.test(p.package);

/**
 * Writes pod.json on the first run: Mera News' news server (or MERA_NEWS_DATA_SERVER_URL), no AI
 * service, and the bundled mcp plugin on a free loopback port. The key is never written: the app
 * hands it over as MERA_POD_DATA_API_KEY, or the person puts it in secrets.json. Later runs keep the
 * file and only move the bundled plugin's path, which changes when the app updates the plugin.
 * Returns the mcp plugin's port.
 */
export async function ensureConfig(home: string, pluginFile: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const file = path.join(home, 'pod.json');
  const ours = async (): Promise<PluginEntry> => ({ package: pluginFile, config: { port: await freePort() } });
  if (!fs.existsSync(file)) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale);
    const entry = await ours();
    const config = {
      dataServer: { url: env.MERA_NEWS_DATA_SERVER_URL || MERA_NEWS_DATA_SERVER },
      reading: { everyMinutes: 15 },
      language: locale.language,
      ...(locale.region ? { region: locale.region } : {}),
      plugins: [entry],
    };
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const secrets = path.join(home, 'secrets.json');
    if (!fs.existsSync(secrets)) fs.writeFileSync(secrets, '{}\n', { mode: 0o600 });
    return entry.config!.port!;
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { plugins?: PluginEntry[] };
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  let entry = plugins.find(isMcp);
  let changed = false;
  if (!entry) {
    entry = await ours();
    plugins.push(entry);
    changed = true;
  } else if (entry.package.endsWith(PLUGIN_FILE) && entry.package !== pluginFile) {
    entry.package = pluginFile;
    changed = true;
  }
  if (changed) {
    config.plugins = plugins;
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  return entry.config?.port ?? 8787;
}

async function listening(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(socket.end() && true));
      socket.once('error', () => resolve(false));
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main(): Promise<void> {
  // The pod replaces the global fetch with its guard, which refuses loopback; the bridge keeps the real one.
  const direct = globalThis.fetch;
  const pod = require('mera-news-pod/embed') as typeof Embed;
  const home = pod.podHome();
  const port = await ensureConfig(home, path.join(__dirname, PLUGIN_FILE));

  let running: Embed.Pod | undefined;
  try {
    const cfg = pod.loadConfig(home);
    for (const line of await pod.probe(cfg)) console.error(line);
    running = await pod.boot({ home, createServices: pod.createServices, sink: (_level, line) => console.error(line) });
  } catch (error) {
    // Another app (or a terminal) already runs the pod for this home: relay to that one.
    if (/another pod is running/.test(oneLine(error))) console.error('A pod is already running for this home, so this connects to it.');
    else console.error(error instanceof pod.ConfigError ? error.message : oneLine(error));
  }
  const stop = async () => {
    await running?.stop().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  if (!(await listening(port, START_TIMEOUT_MS))) console.error(`Nothing answers on port ${port}. Check the lines above.`);
  // The bridge returns when the app closes standard input, which is when the app is done with us.
  await runBridge({ url: `http://127.0.0.1:${port}/mcp`, home, fetchImpl: direct });
  await stop();
}

// Always run: a desktop app may start this file in an Electron utility process, where require.main is not this module.
main().catch((error) => {
  console.error(`Mera News could not start: ${oneLine(error)}`);
  process.exit(1);
});
