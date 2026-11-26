import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Mera News' own news server. A key from Mera Labs unlocks it. */
export const MERA_NEWS_DATA_SERVER = 'https://api.mera.news';
export const MCP_FILE = 'mcp-plugin.cjs';
export const WEB_FILE = 'web-plugin.cjs';

interface PluginEntry {
  package: string;
  config?: { port?: number };
}

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
const isWeb = (p: PluginEntry) => /(^|[\\/])(web|mera-news-pod-web|web-plugin\.cjs)[\\/]?$/.test(p.package);

/**
 * The app's setting "News server address", when it holds a web address. An app hands an unset
 * setting over empty or as leftover template text, and that means "no change".
 */
export function newsServerSetting(env: NodeJS.ProcessEnv): string | undefined {
  const given = (env.MERA_NEWS_DATA_SERVER_URL ?? '').trim();
  try {
    const url = new URL(given);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? given.replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

/** The app's setting "Also run the Mera News website on this computer": on unless it says no. */
export const webWanted = (env: NodeJS.ProcessEnv) => !/^(false|0|no|off)$/i.test((env.MERA_POD_WEB ?? '').trim());

/**
 * Writes pod.json on the first run: Mera News' news server (or the address in MERA_NEWS_DATA_SERVER_URL,
 * which later runs also apply when it changes), no AI
 * service, the bundled mcp plugin on a free loopback port and, unless MERA_POD_WEB turns it off, the
 * bundled website after it. The key is never written: the app hands it over as MERA_POD_DATA_API_KEY,
 * or the person puts it in secrets.json. Later runs keep the file, move the bundled plugins' paths
 * (they change when the app updates the plugin), and add or remove the bundled website as the setting
 * says. A website file that is missing is removed from the file too, because the pod stops when a
 * plugin it names cannot be found. Returns the mcp plugin's port.
 *
 * `addWeb: false` is for serve mode, which has no app settings: it moves or keeps a website entry
 * that is there and never adds one, so a website the person turned off stays off.
 */
export async function ensureConfig(home: string, serverDir: string, env: NodeJS.ProcessEnv = process.env, { addWeb = true } = {}): Promise<number> {
  const file = path.join(home, 'pod.json');
  const mcpFile = path.join(serverDir, MCP_FILE);
  const webFile = path.join(serverDir, WEB_FILE);
  const wantWeb = webWanted(env) && fs.existsSync(webFile);
  const entry = async (pkg: string): Promise<PluginEntry> => ({ package: pkg, config: { port: await freePort() } });
  if (!fs.existsSync(file)) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale);
    const mcp = await entry(mcpFile);
    const config = {
      dataServer: { url: newsServerSetting(env) ?? MERA_NEWS_DATA_SERVER },
      reading: { everyMinutes: 15 },
      language: locale.language,
      ...(locale.region ? { region: locale.region } : {}),
      plugins: [mcp, ...(wantWeb && addWeb ? [await entry(webFile)] : [])],
    };
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const secrets = path.join(home, 'secrets.json');
    if (!fs.existsSync(secrets)) fs.writeFileSync(secrets, '{}\n', { mode: 0o600 });
    return mcp.config!.port!;
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { plugins?: PluginEntry[]; dataServer?: { url?: string } };
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const before = JSON.stringify(plugins);
  // An address in the app's setting wins; with none, the file's news server stays as it is.
  const news = newsServerSetting(env);
  const newsChanged = news !== undefined && config.dataServer?.url !== news;
  if (newsChanged) config.dataServer = { ...config.dataServer, url: news };
  let mcp = plugins.find(isMcp);
  if (!mcp) {
    mcp = await entry(mcpFile);
    plugins.push(mcp);
  } else if (mcp.package.endsWith(MCP_FILE)) mcp.package = mcpFile;

  // Only the bundled website is ours to add, move or remove; one the person installed stays as it is.
  const web = plugins.find(isWeb);
  const bundled = web?.package.endsWith(WEB_FILE);
  if (web && bundled && !wantWeb) plugins.splice(plugins.indexOf(web), 1);
  else if (wantWeb && (web ? bundled : addWeb)) {
    const ours = web ?? (await entry(webFile));
    ours.package = webFile;
    // After mcp: the plugins start in order, and the website must never hold up the tools.
    if (web && plugins.indexOf(web) < plugins.indexOf(mcp)) plugins.splice(plugins.indexOf(web), 1);
    if (!plugins.includes(ours)) plugins.splice(plugins.indexOf(mcp) + 1, 0, ours);
  }
  if (newsChanged || JSON.stringify(plugins) !== before) {
    config.plugins = plugins;
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  return mcp.config?.port ?? 8787;
}
