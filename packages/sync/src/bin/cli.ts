#!/usr/bin/env node
import os from 'node:os';
import { createPairing, lastSeen, listDevices, removeDevice, syncDir } from '../store';

const usage = `Usage:
  mera-news-pod-sync pair [--base <https address of the pod>] [--home <dir>]
  mera-news-pod-sync devices [--revoke <id>] [--home <dir>]`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args: string[]): number {
  const home = option(args, '--home') ?? process.env.MERA_POD_HOME ?? `${os.homedir()}/.mera-news-pod`;
  const dir = syncDir(home);
  if (args[0] === 'pair') {
    const code = createPairing(dir);
    const base = option(args, '--base');
    process.stdout.write(`Pairing code: ${code}\nIt works once and for 10 minutes.\n`);
    if (base) {
      const link = `meraapp://pod-pair?u=${encodeURIComponent(base.replace(/\/+$/, ''))}&c=${code}`;
      process.stdout.write(`Link for the app: ${link}\n`);
    } else {
      process.stdout.write('To get a link for the app, run this again with --base set to the https address of this pod.\n');
    }
    return 0;
  }
  if (args[0] === 'devices') {
    const revoke = option(args, '--revoke');
    if (revoke) {
      if (!removeDevice(dir, revoke)) {
        process.stderr.write(`No paired device has the id ${revoke}.\n`);
        return 1;
      }
      process.stdout.write('The device is revoked. Its next request is refused.\n');
      return 0;
    }
    const devices = listDevices(dir);
    if (!devices.length) process.stdout.write('No device is paired.\n');
    const seen = lastSeen(dir);
    for (const d of devices) process.stdout.write(`${d.id}  ${d.name}  paired ${d.pairedAt}  last seen ${seen[d.id] ?? 'never'}\n`);
    return 0;
  }
  process.stderr.write(`${usage}\n`);
  return 2;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
