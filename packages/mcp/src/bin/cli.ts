#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { runBridge } from './bridge';
import { rotateToken } from './token';

const usage = `Usage:
  mera-news-pod-mcp bridge --url <url> [--home <dir>]
  mera-news-pod-mcp token --rotate [--home <dir>]`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const home = option(args, '--home') ?? process.env.MERA_POD_HOME ?? path.join(os.homedir(), '.mera-news-pod');
  if (args[0] === 'bridge') {
    const url = option(args, '--url');
    if (!url) {
      process.stderr.write(`The bridge needs the pod address, for example --url http://127.0.0.1:8787/mcp\n`);
      return 2;
    }
    await runBridge({ url, home });
    return 0;
  }
  if (args[0] === 'token' && args.includes('--rotate')) {
    const token = rotateToken(home);
    process.stdout.write(`${token}\n`);
    process.stderr.write(
      'This is the new token. It is shown once. The old token stops working as soon as the pod reads the file again, which it does on every request.\n',
    );
    return 0;
  }
  process.stderr.write(`${usage}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  },
);
