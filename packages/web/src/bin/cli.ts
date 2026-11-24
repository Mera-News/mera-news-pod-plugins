#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { siteLink } from '../link';

const usage = `Usage:
  mera-news-pod-web link [--home <dir>]`;

const args = process.argv.slice(2);
const i = args.indexOf('--home');
const home = (i >= 0 ? args[i + 1] : undefined) ?? process.env.MERA_POD_HOME ?? path.join(os.homedir(), '.mera-news-pod');

if (args[0] !== 'link') {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
try {
  // The link signs in once, so it is printed only when asked for by name.
  process.stdout.write(`${siteLink(path.join(path.resolve(home), 'data', 'plugins', 'web'))}\n`);
  process.stderr.write('This link opens Mera News in one browser tab. It works once, for 10 minutes.\n');
} catch (e) {
  process.stderr.write(`${(e as Error).message} Start the pod with the web plugin in pod.json, then run this again.\n`);
  process.exit(1);
}
