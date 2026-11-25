// The one program an AI app starts. It runs the pod for this home, or finds the one already running,
// and relays the app's standard input and output to the pod's mcp plugin. Standard output carries
// only MCP messages, so every log line goes to standard error, set before the pod loads.
console.log = console.info = console.debug = console.error;

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type * as Embed from 'mera-news-pod/embed';
// The bridge is bundled from source with this file, so the mcp package need not be built first.
import { runBridge } from '../../mcp/src/bin/bridge';
import { mcpDataDir, sessionHint } from '../../mcp/src/digest';
import { createKeepRunning, logFile, systemDeps } from '../../web/src/keep-running';
import { ensureConfig } from './config';

const START_TIMEOUT_MS = 30_000;

const oneLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0];
const LOCK_RETRY_MS = 10_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** An app can hand over an unset setting as quoting debris or a template: treat that as no key, so secrets.json applies. */
function dropDebrisKey() {
  const given = process.env.MERA_POD_DATA_API_KEY;
  if (given !== undefined && (given.trim().length < 16 || /["'\s]|\$\{/.test(given))) delete process.env.MERA_POD_DATA_API_KEY;
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
  dropDebrisKey();
  // The pod replaces the global fetch with its guard, which refuses loopback; the bridge keeps the real one.
  const direct = globalThis.fetch;
  const pod = require('mera-news-pod/embed') as typeof Embed;
  const home = pod.podHome();
  const port = await ensureConfig(home, __dirname);
  // "Keep Mera News running" names a server.cjs; an update can remove it, so point the agent here.
  await createKeepRunning(systemDeps(home, path.join(__dirname, 'server.cjs'))).refresh();

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

/**
 * `server.cjs serve`, what "Keep Mera News running" starts: the pod and its plugins for this home,
 * with no stdio bridge, until a stop signal. Nothing is written to standard output. While an app
 * holds the home, it waits and tries again, so it takes over when that app quits.
 */
async function serve(): Promise<void> {
  dropDebrisKey();
  const pod = require('mera-news-pod/embed') as typeof Embed;
  const home = pod.podHome();
  // launchd appends to one log file; start it again once it is large, since nothing else trims it.
  try {
    if (fs.statSync(logFile(home)).size > MAX_LOG_BYTES) fs.truncateSync(logFile(home), 0);
  } catch {
    // No log yet.
  }
  // The agent has no app settings, so it never puts back a website the person turned off.
  await ensureConfig(home, __dirname, process.env, { addWeb: false });
  // Each failed boot leaves the pod's fetch guard installed; the next try must start from the real fetch.
  const realFetch = globalThis.fetch;
  let running: Embed.Pod | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  const stop = async () => {
    stopping = true;
    clearTimeout(timer);
    await running?.stop().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let said = false;
  while (!stopping && !running) {
    try {
      globalThis.fetch = realFetch;
      running = await pod.boot({ home, createServices: pod.createServices, sink: (_level, line) => console.error(line) });
      console.error('Mera News is running on its own.');
      // Once, after the takeover: a probe on every wait would bill the AI service each time.
      for (const line of await pod.probe(pod.loadConfig(home), realFetch)) console.error(line);
    } catch (error) {
      if (!/another pod is running/.test(oneLine(error))) throw error instanceof pod.ConfigError ? new Error(error.message) : error;
      if (!said) console.error('Mera News is open in an app, so this starts when that app quits.');
      said = true;
      await new Promise((r) => (timer = setTimeout(r, LOCK_RETRY_MS)));
    }
  }
}

/**
 * `server.cjs session-hint`, for an app's session start hook: one sentence on standard output, or
 * nothing. It reads two small files the mcp plugin writes and never loads the pod, so it is quick and
 * shows no fact. The home is the pod's own default.
 */
function printSessionHint(): void {
  try {
    const line = sessionHint(mcpDataDir(process.env.MERA_POD_HOME || path.join(os.homedir(), '.mera-news-pod')));
    if (line) process.stdout.write(`${line}\n`);
  } catch {
    // A hint is never worth failing a session start.
  }
}

// Always run: a desktop app may start this file in an Electron utility process, where require.main is not this module.
if (process.argv[2] === 'session-hint') printSessionHint();
else
  (process.argv[2] === 'serve' ? serve() : main()).catch((error) => {
    console.error(`Mera News could not start: ${oneLine(error)}`);
    process.exit(1);
  });
