// "Keep Mera News running", macOS only for now: a LaunchAgent that runs this pod home with the
// bundle's own server.cjs in its serve mode (the pod and its plugins, no stdio bridge), so the pod
// keeps reading and stays reachable from a phone after the AI app quits. The app's own server.cjs
// then finds the home locked and only bridges to it. Nothing is installed: it needs a Node.js the
// person already has, and says how to get one when there is none.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NewsError } from './news';

export const LABEL = 'news.mera.pod';
export const MIN_NODE = '22.13.0';
export const NODE_DOWNLOAD = 'https://nodejs.org/en/download';
export const BREW_INSTALL = 'brew install node';

export interface NodeFound {
  path: string;
  version: string;
}

export interface KeepRunningDeps {
  home: string;
  /** The bundle's server.cjs beside this plugin, or null when the website runs outside the bundle. */
  serverFile: string | null;
  agentsDir: string;
  platform: NodeJS.Platform;
  uid: number;
  /** Every Node.js found, most stable path first. */
  nodes(): Promise<NodeFound[]>;
  hasBrew(): boolean;
  /** `later` runs it a second from now in its own process, so a reply can leave before launchd stops this pod. */
  launchctl(args: string[], later?: boolean): void;
  env: NodeJS.ProcessEnv;
  /** Whether this home's data server takes the key: false only for a clear refusal, null when that cannot be told. */
  keyAccepted(key: string): Promise<boolean | null>;
}

const KEY_CHECK_MS = 5000;

/** Asks the data server named in this home's pod.json one small question with the key. A refusal is HTTP 401 or 403, or GraphQL's UNAUTHENTICATED. */
export async function dataServerTakesKey(home: string, key: string): Promise<boolean | null> {
  try {
    const url = new URL(JSON.parse(fs.readFileSync(path.join(home, 'pod.json'), 'utf8')).dataServer.url);
    const dataPath = url.pathname.replace(/\/+$/, '');
    const res = await fetch(`${url.origin}${dataPath.endsWith('/graphql') ? dataPath : `${dataPath}/graphql`}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ query: '{ recentArticleCount }' }),
      // A redirect would carry the key to another address.
      redirect: 'error',
      signal: AbortSignal.timeout(KEY_CHECK_MS),
    });
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return null;
    const body = (await res.json()) as { errors?: { extensions?: { code?: string } }[] };
    if (!body.errors?.length) return true;
    return body.errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED') ? false : null;
  } catch {
    return null;
  }
}

export const atLeast = (version: string, min = MIN_NODE) => {
  const a = version.replace(/^v/, '').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  return true;
};

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export const logFile = (home: string) => path.join(home, 'logs', 'pod.log');

/** A fingerprint of the code in a server folder. An update changes it, while a running agent keeps the code it loaded. */
export function codeOf(serverDir: string): string {
  const hash = createHash('sha256');
  for (const name of fs.readdirSync(serverDir).filter((n) => n.endsWith('.cjs')).sort()) hash.update(name).update(fs.readFileSync(path.join(serverDir, name)));
  try {
    // The website's files are not .cjs; its build marker changes with them.
    hash.update(fs.readFileSync(path.join(serverDir, 'web', 'BUILD-SOURCE.txt')));
  } catch {
    // No website in this folder.
  }
  return hash.digest('hex');
}
/** The code the agent was last started on, so an app start restarts it once after an update. */
export const startedFile = (home: string) => path.join(home, 'data', 'plugins', 'web', 'agent-code');

/** The LaunchAgent: no secret in it, so it is an ordinary file in ~/Library/LaunchAgents. */
export function plist(node: string, serverFile: string, home: string): string {
  const log = xml(logFile(home));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(serverFile)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MERA_POD_HOME</key><string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function writeFile(file: string, text: string, mode: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

export function createKeepRunning(deps: KeepRunningDeps) {
  const file = path.join(deps.agentsDir, `${LABEL}.plist`);
  const secretsFile = path.join(deps.home, 'secrets.json');
  const job = `gui/${deps.uid}/${LABEL}`;
  const supported = deps.platform !== 'darwin' ? 'not_mac' : deps.serverFile ? 'yes' : 'not_bundled';
  const read = () => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  /** Ours: the serve mode, for this home. A LaunchAgent the person wrote under the same name (the pod's guide shows one) is never touched. */
  const ours = (text: string) => text.includes('<string>serve</string>') && text.includes(`<key>MERA_POD_HOME</key><string>${xml(deps.home)}</string>`);
  /** Ours, but naming a Node.js that is gone (a version manager's version was removed): launchd cannot start it. */
  const broken = (text: string) => {
    const node = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
    return !node || !fs.existsSync(unxml(node));
  };
  const availableNow = () => {
    const text = read();
    return supported === 'yes' && text !== null && !ours(text) ? 'other_agent' : supported;
  };

  const readSecrets = (): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new NewsError('secrets_unreadable', `${secretsFile} cannot be read, so Mera News cannot keep running on its own.`, 'Fix or remove the file, then try again.');
    }
  };
  /** The app hands the news key over at each start; on its own the pod reads it from secrets.json. */
  const keyToCopy = () => {
    const given = deps.env.MERA_POD_DATA_API_KEY;
    return !!given && !readSecrets().dataApiKey ? given : null;
  };

  /**
   * The key to put in secrets.json, or null. The app's key is saved when the pod has none, or when
   * the data server refuses the pod's key and accepts the app's (a key changed in the app's settings).
   * Two apps can share a home, so a key that works, or cannot be checked, is never replaced.
   */
  const keyToSave = async (): Promise<string | null> => {
    const given = deps.env.MERA_POD_DATA_API_KEY;
    const stored = readSecrets().dataApiKey;
    if (!given || given === stored) return null;
    if (!stored) return given;
    if (typeof stored !== 'string') return null;
    return (await deps.keyAccepted(stored)) === false && (await deps.keyAccepted(given)) === true ? given : null;
  };
  const saveKey = (key: string) => writeFile(secretsFile, `${JSON.stringify({ ...readSecrets(), dataApiKey: key }, null, 2)}\n`, 0o600);
  const started = () => {
    try {
      return fs.readFileSync(startedFile(deps.home), 'utf8').trim();
    } catch {
      return null;
    }
  };
  const noteStarted = (serverFile: string) => writeFile(startedFile(deps.home), `${codeOf(path.dirname(serverFile))}\n`, 0o600);

  async function node(): Promise<{ node: NodeFound | null; oldNode: string | null }> {
    const found = await deps.nodes();
    return { node: found.find((n) => atLeast(n.version)) ?? null, oldNode: found[0]?.version ?? null };
  }

  async function state() {
    const available = availableNow();
    const on = available === 'yes' && fs.existsSync(file);
    if (available !== 'yes') return { available, on };
    const text = on ? read() : null;
    const n = await node();
    let copiesKey = false;
    try {
      copiesKey = !on && keyToCopy() !== null;
    } catch {
      // turnOn names the unreadable file.
    }
    return {
      available,
      on,
      broken: text !== null && broken(text),
      node: n.node,
      oldNode: n.node ? null : n.oldNode,
      minNode: MIN_NODE.replace(/\.0$/, ''),
      install: deps.hasBrew() ? BREW_INSTALL : null,
      download: NODE_DOWNLOAD,
      copiesKey,
      log: logFile(deps.home),
    };
  }

  async function turnOn() {
    if (availableNow() !== 'yes') throw new NewsError('not_available', 'Mera News can keep running on its own only on macOS, from the Mera News extension or plugin, and only when no other news.mera.pod LaunchAgent exists.', 'Keep your pod running yourself instead.');
    const current = read();
    if (current !== null && !broken(current)) return state();
    const { node: found } = await node();
    if (!found) throw new NewsError('no_node', `Mera News needs Node.js ${MIN_NODE.replace(/\.0$/, '')} or newer on this Mac to keep running on its own.`, 'Install it, then try again.');
    const key = await keyToSave();
    if (key) saveKey(key);
    fs.mkdirSync(path.dirname(logFile(deps.home)), { recursive: true, mode: 0o700 });
    writeFile(file, plist(found.path, deps.serverFile!, deps.home), 0o644);
    // A job left loaded without its file would refuse the new one.
    try {
      deps.launchctl(['bootout', job]);
    } catch {
      // Not loaded: the usual case.
    }
    try {
      deps.launchctl(['bootstrap', `gui/${deps.uid}`, file]);
    } catch {
      fs.rmSync(file, { force: true });
      throw new NewsError('launchd_refused', 'macOS did not start Mera News.', `Try again. If it keeps failing, look at ${logFile(deps.home)}.`);
    }
    noteStarted(deps.serverFile!);
    return state();
  }

  async function turnOff() {
    if (availableNow() === 'yes' && fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      // When this pod is the one launchd runs, stopping it now would cut off this reply.
      deps.launchctl(['bootout', job], true);
    }
    return state();
  }

  /**
   * At an app's start: if the agent names a server.cjs that is gone (an update moved the plugin), or
   * a Node.js that is gone, point it at this one and a Node.js found now, and start it again. One that still exists is left alone, so two apps
   * sharing the home never take the agent from each other. The agent reads its key only from
   * secrets.json, so a key changed in the app's settings is saved there and the agent starts again.
   * An update replaces the agent's files while it keeps running the code it loaded, so it is also
   * started again, once, when those files are not the ones it was last started on. Never throws.
   */
  async function refresh(): Promise<void> {
    try {
      const text = read();
      if (supported !== 'yes' || text === null || !ours(text)) return;
      const key = await keyToSave();
      const before = key && fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile, 'utf8') : null;
      if (key) saveKey(key);
      const named = /<string>([^<]*server\.cjs)<\/string>/.exec(text)?.[1];
      if (named && fs.existsSync(unxml(named)) && !broken(text)) {
        if (!key && started() === codeOf(path.dirname(unxml(named)))) return;
        try {
          deps.launchctl(['kickstart', '-k', job]);
        } catch (e) {
          // The saved key is what tells the next start there is nothing to do, so put the old file back: the next start then tries again.
          if (key && before === null) fs.rmSync(secretsFile, { force: true });
          else if (key) writeFile(secretsFile, before!, 0o600);
          throw e;
        }
        noteStarted(unxml(named));
        return;
      }
      const { node: found } = await node();
      if (!found) return;
      writeFile(file, plist(found.path, deps.serverFile!, deps.home), 0o644);
      try {
        deps.launchctl(['bootout', job]);
      } catch {
        // Not loaded.
      }
      deps.launchctl(['bootstrap', `gui/${deps.uid}`, file]);
      noteStarted(deps.serverFile!);
    } catch {
      // The next start tries again.
    }
  }

  return { state, turnOn, turnOff, refresh, file };
}

const run = promisify(execFile);

/** Node.js on this Mac: Homebrew's and the installer's fixed paths first, then PATH, then this process if it is plain Node. */
async function findNodes(): Promise<NodeFound[]> {
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    ...(process.env.PATH ?? '').split(':').filter((d) => path.isAbsolute(d)).map((d) => path.join(d, 'node')),
    ...(process.versions.electron ? [] : [process.execPath]),
  ];
  const found: NodeFound[] = [];
  for (const c of [...new Set(candidates)]) {
    try {
      if (!fs.statSync(c).isFile()) continue;
      const { stdout } = await run(c, ['--version'], { timeout: 5000, env: {} });
      const version = stdout.trim().replace(/^v/, '');
      if (/^\d+\.\d+\.\d+$/.test(version)) found.push({ path: c, version });
    } catch {
      // Not a working node.
    }
  }
  return found;
}

export function systemDeps(home: string, serverFile: string): KeepRunningDeps {
  return {
    home,
    serverFile: fs.existsSync(serverFile) ? serverFile : null,
    agentsDir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    nodes: findNodes,
    hasBrew: () => ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].some((b) => fs.existsSync(b)),
    launchctl(args, later) {
      if (later) spawn('/bin/sh', ['-c', 'sleep 1; exec /bin/launchctl "$@"', 'sh', ...args], { detached: true, stdio: 'ignore' }).unref();
      else execFileSync('/bin/launchctl', args, { stdio: 'ignore', timeout: 15_000 });
    },
    env: process.env,
    keyAccepted: (key) => dataServerTakesKey(home, key),
  };
}
