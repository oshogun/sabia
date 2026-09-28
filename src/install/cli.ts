// `node dist/install/cli.js <subcommand> ...` — the helper both the shell
// and PowerShell installers shell out to for logic that has to behave
// identically on every OS: minting the self-signed certificate, merging
// sabia.env, checking a port is free, polling the server for health, reading
// whether an operator account exists, and printing the pairing block. Kept
// as one small CLI rather than five scripts so the argument parsing and exit
// codes only have to be gotten right once.

import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { buildSelfSignedCert, defaultSans, firstUsableIPv4, hostnameDnsNames, type NetIf } from './selfSignedCert';
import { mergeEnvFile, parseEnvLines, type MergeInput } from './envFile';
import { resolveDbPath } from '../db/connection';

export const EXIT = { OK: 0, ERROR: 1, EXISTS: 2, NEGATIVE: 3 } as const;

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Writes via a temp file in the same directory, then renames — the write is
 *  atomic, so a process crash mid-write never leaves a half-written file. If
 *  either step fails, the temp file is cleaned up rather than left behind. */
function writeFileAtomic(file: string, data: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Accepts only a decimal integer in the valid TCP port range — used
 *  everywhere the CLI takes a `--port` flag. */
export function parsePort(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function flattenInterfaces(raw: NodeJS.Dict<os.NetworkInterfaceInfo[]>): NetIf[] {
  const out: NetIf[] = [];
  for (const infos of Object.values(raw)) {
    for (const info of infos ?? []) {
      out.push({ address: info.address, family: info.family as 'IPv4' | 'IPv6', internal: info.internal });
    }
  }
  return out;
}

function envKv(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of parseEnvLines(text)) {
    if (line.kind === 'pair') kv[line.key] = line.value;
  }
  return kv;
}

// ── cert ─────────────────────────────────────────────────────────────────────

function certCmd(args: string[]): number {
  const certPath = getArg(args, '--cert');
  const keyPath = getArg(args, '--key');
  if (!certPath || !keyPath) {
    console.error('cert requires --cert <path> and --key <path>.');
    return EXIT.ERROR;
  }
  const bindHost = getArg(args, '--bind-host') ?? '0.0.0.0';
  const sanExtras = (getArg(args, '--san') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const days = Number(getArg(args, '--days') ?? '3650');
  const force = hasFlag(args, '--force');

  if (!force && (fs.existsSync(certPath) || fs.existsSync(keyPath))) {
    console.error('Refusing to overwrite an existing certificate or key without --force.');
    return EXIT.EXISTS;
  }

  try {
    const interfaces = flattenInterfaces(os.networkInterfaces());
    const { dnsNames, ipAddresses } = defaultSans(os.hostname(), interfaces, bindHost, sanExtras);
    const result = buildSelfSignedCert({ commonName: 'Sabia', dnsNames, ipAddresses, days });

    writeFileAtomic(certPath, result.certPem, 0o644);
    writeFileAtomic(keyPath, result.keyPem, 0o600);

    console.log(`cert ${certPath}`);
    console.log(`key ${keyPath}`);
    console.log(`san ${[...dnsNames, ...ipAddresses].join(',')}`);
    console.log(`sha256 ${result.fingerprint256}`);
    console.log(`notAfter ${result.notAfter}`);
    return EXIT.OK;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT.ERROR;
  }
}

// ── env-merge ────────────────────────────────────────────────────────────────

function envMergeCmd(args: string[]): number {
  const file = getArg(args, '--file');
  const root = getArg(args, '--root');
  const defaultBindHost = getArg(args, '--default-bind-host');
  if (!file || !root || !defaultBindHost) {
    console.error('env-merge requires --file <path>, --root <path> and --default-bind-host <host>.');
    return EXIT.ERROR;
  }
  const portArg = getArg(args, '--port');
  const bindHostArg = getArg(args, '--bind-host');
  let port: number | undefined;
  if (portArg !== undefined) {
    port = parsePort(portArg);
    if (port === undefined) {
      console.error(`--port must be an integer between 1 and 65535, got "${portArg}".`);
      return EXIT.ERROR;
    }
  }

  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing !== null && existing.charCodeAt(0) === 0xfeff) {
      console.error(`Removed a leading byte-order mark from ${file}.`);
    }

    const input: MergeInput = {
      root,
      defaultBindHost,
      pathSep: path.sep as '/' | '\\',
      newToken: () => crypto.randomBytes(32).toString('hex'),
      ...(port !== undefined ? { port } : {}),
      ...(bindHostArg !== undefined ? { bindHost: bindHostArg } : {}),
    };
    const result = mergeEnvFile(existing, input);

    writeFileAtomic(file, result.text, 0o600);
    console.log(JSON.stringify({
      created: result.created,
      appended: result.appended,
      replaced: result.replaced,
      values: result.values,
    }));
    return EXIT.OK;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT.ERROR;
  }
}

// ── port-free ────────────────────────────────────────────────────────────────

function portFreeCmd(args: string[]): Promise<number> {
  const host = getArg(args, '--host');
  const portArg = getArg(args, '--port');
  if (!host || !portArg) {
    console.error('port-free requires --host <host> and --port <port>.');
    return Promise.resolve(EXIT.ERROR);
  }
  const port = parsePort(portArg);
  if (port === undefined) {
    console.error(`--port must be an integer between 1 and 65535, got "${portArg}".`);
    return Promise.resolve(EXIT.ERROR);
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        console.log(`busy ${host}:${port}`);
        resolve(EXIT.NEGATIVE);
      } else {
        console.error(err.message);
        resolve(EXIT.ERROR);
      }
    });
    server.once('listening', () => {
      server.close(() => {
        console.log(`free ${host}:${port}`);
        resolve(EXIT.OK);
      });
    });
    server.listen(port, host);
  });
}

// ── wait-healthy ─────────────────────────────────────────────────────────────

function healthHost(bindHost: string): string {
  if (bindHost === '::') return '::1';
  if (bindHost === '0.0.0.0' || bindHost === '127.0.0.1') return '127.0.0.1';
  return bindHost;
}

function probeOnce(host: string, port: number, useTls: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const lib = useTls ? https : http;
    const req = lib.get(
      { host, port, path: '/', timeout: 2000, rejectUnauthorized: false },
      (res) => {
        resolve((res.statusCode ?? 500) < 500);
        res.resume();
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitHealthyCmd(args: string[]): Promise<number> {
  const envFile = getArg(args, '--env-file');
  if (!envFile) {
    console.error('wait-healthy requires --env-file <path>.');
    return EXIT.ERROR;
  }
  const timeoutSec = Number(getArg(args, '--timeout') ?? '60');

  let kv: Record<string, string>;
  try {
    kv = envKv(fs.readFileSync(envFile, 'utf8'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT.ERROR;
  }

  const port = Number(kv.PORT ?? '3000');
  const bindHost = kv.BIND_HOST ?? '0.0.0.0';
  const useTls = Boolean(kv.TLS_CERT_FILE) && Boolean(kv.TLS_KEY_FILE);
  const host = healthHost(bindHost);

  const deadline = Date.now() + timeoutSec * 1000;
  do {
    if (await probeOnce(host, port, useTls)) {
      console.log(`healthy ${useTls ? 'https' : 'http'}://${host}:${port}/`);
      return EXIT.OK;
    }
    await sleep(1000);
  } while (Date.now() < deadline);

  console.error(`Server did not become healthy within ${timeoutSec}s.`);
  return EXIT.ERROR;
}

// ── operator-status ──────────────────────────────────────────────────────────

/**
 * Opens the database read-only and asks it a single question, never through
 * initDb()/applySchema() — a status check must never be the thing that
 * migrates a database that a newer or older server version might still open.
 */
function operatorStatusCmd(): number {
  const dbFile = resolveDbPath();
  if (!fs.existsSync(dbFile)) {
    console.log('operator: none');
    return EXIT.NEGATIVE;
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT.ERROR;
  }

  try {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_user'`).get();
    if (!table) {
      console.log('operator: none');
      return EXIT.NEGATIVE;
    }
    const row = db.prepare('SELECT username FROM auth_user WHERE id = 1').get() as { username: string } | undefined;
    if (!row) {
      console.log('operator: none');
      return EXIT.NEGATIVE;
    }
    console.log(`operator: ${row.username}`);
    return EXIT.OK;
  } finally {
    db.close();
  }
}

// ── pairing ──────────────────────────────────────────────────────────────────

function pairingCmd(args: string[]): number {
  const envFile = getArg(args, '--env-file');
  if (!envFile) {
    console.error('pairing requires --env-file <path>.');
    return EXIT.ERROR;
  }

  let kv: Record<string, string>;
  try {
    kv = envKv(fs.readFileSync(envFile, 'utf8'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT.ERROR;
  }

  const port = kv.PORT ?? '3000';
  const bindHost = kv.BIND_HOST ?? '0.0.0.0';
  const isLoopback = bindHost === '127.0.0.1' || bindHost === '::1';
  // Bracket the address the way a URL requires when the bind is IPv6 loopback — printing
  // bare "127.0.0.1" for a server that only bound "::1" gives a URL that cannot connect.
  const primaryHost = isLoopback
    ? (bindHost === '::1' ? '[::1]' : '127.0.0.1')
    : (firstUsableIPv4(flattenInterfaces(os.networkInterfaces())) ?? '127.0.0.1');

  console.log(`server https://${primaryHost}:${port}`);
  // Only the ".local" alias is worth printing here — it is the one a LAN client resolves via
  // mDNS. It is skipped exactly when defaultSans() would have skipped it (hostname has a dot),
  // so this URL is never for a name absent from the certificate's SAN list.
  const localName = hostnameDnsNames(os.hostname()).find((name) => name.endsWith('.local'));
  if (localName) console.log(`server https://${localName}:${port}`);
  if (bindHost === '0.0.0.0') {
    console.log(`server https://127.0.0.1:${port}`);
  }
  if (kv.INGEST_TOKEN) console.log(`ingestToken ${kv.INGEST_TOKEN}`);
  if (kv.TLS_CERT_FILE) {
    console.log(`cert ${kv.TLS_CERT_FILE}`);
    try {
      const pem = fs.readFileSync(kv.TLS_CERT_FILE, 'utf8');
      const x509 = new crypto.X509Certificate(pem);
      console.log(`sha256 ${x509.fingerprint256}`);
      console.log(pem.trim());
    } catch (err) {
      console.error(`Could not read the certificate at ${kv.TLS_CERT_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return EXIT.OK;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const USAGE = 'Usage: node dist/install/cli.js <cert|env-merge|port-free|wait-healthy|operator-status|pairing> ...';

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'cert': return certCmd(rest);
    case 'env-merge': return envMergeCmd(rest);
    case 'port-free': return portFreeCmd(rest);
    case 'wait-healthy': return waitHealthyCmd(rest);
    case 'operator-status': return operatorStatusCmd();
    case 'pairing': return pairingCmd(rest);
    default:
      console.error(USAGE);
      return EXIT.ERROR;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT.ERROR);
  });
}
