// Parsing and merging for the installer's `sabia.env` file — a strict subset
// of `KEY=value` lines that Node's own `--env-file` flag reads at launch, so
// nothing here needs to duplicate Node's parser at runtime, only at
// install/upgrade time to decide what to write.

export type EnvLine =
  | { kind: 'blank' | 'comment'; raw: string }
  | { kind: 'pair'; raw: string; key: string; value: string };

export const MANAGED_KEYS = [
  'PORT', 'BIND_HOST', 'TLS_CERT_FILE', 'TLS_KEY_FILE',
  'INGEST_TOKEN', 'NAVDATA_DB_PATH', 'PUPPETEER_CACHE_DIR',
] as const;

export interface MergeInput {
  root: string;
  port?: number;
  bindHost?: string;
  defaultBindHost: string;
  pathSep: '/' | '\\';
  newToken: () => string;
}

export interface MergeResult {
  text: string;
  created: boolean;
  appended: string[];
  replaced: string[];
  values: {
    PORT: string; BIND_HOST: string; TLS_CERT_FILE: string;
    TLS_KEY_FILE: string; INGEST_TOKEN: string;
  };
}

/**
 * Classifies one line of an existing file. Node's own `--env-file` reader
 * truncates a value at the first `#`, even with no preceding space, so a
 * value is captured only up to that point.
 */
function classify(raw: string): EnvLine {
  const stripped = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const trimmed = stripped.trim();
  if (trimmed === '') return { kind: 'blank', raw };
  if (trimmed.startsWith('#')) return { kind: 'comment', raw };
  const eq = stripped.indexOf('=');
  if (eq === -1) return { kind: 'comment', raw }; // not a line the merge logic manages
  const key = stripped.slice(0, eq);
  const rawValue = stripped.slice(eq + 1);
  const hashIndex = rawValue.indexOf('#');
  const value = hashIndex === -1 ? rawValue : rawValue.slice(0, hashIndex);
  return { kind: 'pair', raw, key, value };
}

export function parseEnvLines(text: string): EnvLine[] {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const body = withoutBom.endsWith('\n') ? withoutBom.slice(0, -1) : withoutBom;
  if (body.length === 0) return [];
  return body.split('\n').map(classify);
}

function firstInstallValues(input: MergeInput): Record<(typeof MANAGED_KEYS)[number], string> {
  const join = (...parts: string[]): string => parts.join(input.pathSep);
  const values: Record<(typeof MANAGED_KEYS)[number], string> = {
    PORT: String(input.port ?? 3000),
    BIND_HOST: input.bindHost ?? input.defaultBindHost,
    TLS_CERT_FILE: join(input.root, 'certs', 'sabia.crt'),
    TLS_KEY_FILE: join(input.root, 'certs', 'sabia.key'),
    INGEST_TOKEN: input.newToken(),
    NAVDATA_DB_PATH: join(input.root, 'navdata', 'navdata.db'),
    PUPPETEER_CACHE_DIR: join(input.root, 'chrome'),
  };
  for (const [key, value] of Object.entries(values)) {
    if (/[#\r\n]/.test(value)) {
      throw new Error(`Refusing to write ${key}: its value contains "#" or a line break, which would corrupt the env file.`);
    }
  }
  return values;
}

/**
 * existing === null means the file does not exist. A leading BOM is stripped
 * (the caller is responsible for reporting that fact — this function only
 * returns the clean result). Throws if a value the installer would write
 * contains "#" or a line break (the install root is validated before this
 * runs, so this is a guard, not the primary check).
 */
export function mergeEnvFile(existing: string | null, input: MergeInput): MergeResult {
  const install = firstInstallValues(input);

  if (existing === null) {
    const lines = [
      '# Sabia runtime configuration — written by the installer.',
      ...MANAGED_KEYS.map((key) => `${key}=${install[key]}`),
      '# MCP_TOKEN=',
    ];
    return {
      text: `${lines.join('\n')}\n`,
      created: true,
      appended: [...MANAGED_KEYS],
      replaced: [],
      values: {
        PORT: install.PORT,
        BIND_HOST: install.BIND_HOST,
        TLS_CERT_FILE: install.TLS_CERT_FILE,
        TLS_KEY_FILE: install.TLS_KEY_FILE,
        INGEST_TOKEN: install.INGEST_TOKEN,
      },
    };
  }

  const withoutBom = existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing;
  const hadTrailingNewline = withoutBom.endsWith('\n');
  const body = hadTrailingNewline ? withoutBom.slice(0, -1) : withoutBom;
  const lines: EnvLine[] = body.length === 0 ? [] : body.split('\n').map(classify);

  const lastIndexOfKey = new Map<string, number>();
  lines.forEach((line, i) => { if (line.kind === 'pair') lastIndexOfKey.set(line.key, i); });

  const appended: string[] = [];
  const replaced: string[] = [];
  const finalValues: Partial<Record<(typeof MANAGED_KEYS)[number], string>> = {};

  for (const key of MANAGED_KEYS) {
    const idx = lastIndexOfKey.get(key);

    if (idx === undefined) {
      lines.push({ kind: 'pair', raw: `${key}=${install[key]}`, key, value: install[key] });
      appended.push(key);
      finalValues[key] = install[key];
      continue;
    }

    const current = lines[idx] as Extract<EnvLine, { kind: 'pair' }>;
    if (key === 'PORT' && input.port !== undefined) {
      const value = String(input.port);
      lines[idx] = { kind: 'pair', raw: `PORT=${value}`, key, value };
      replaced.push('PORT');
      finalValues.PORT = value;
    } else if (key === 'BIND_HOST' && input.bindHost !== undefined) {
      const value = input.bindHost;
      lines[idx] = { kind: 'pair', raw: `BIND_HOST=${value}`, key, value };
      replaced.push('BIND_HOST');
      finalValues.BIND_HOST = value;
    } else if (key === 'INGEST_TOKEN' && current.value === '') {
      // Present but empty is the only case an existing INGEST_TOKEN is ever
      // touched — it must never be regenerated once it holds a real value,
      // or a paired MCDU client loses its credential.
      const value = install.INGEST_TOKEN;
      lines[idx] = { kind: 'pair', raw: `INGEST_TOKEN=${value}`, key, value };
      finalValues.INGEST_TOKEN = value;
    } else {
      finalValues[key] = current.value;
    }
  }

  return {
    text: `${lines.map((l) => l.raw).join('\n')}\n`,
    created: false,
    appended,
    replaced,
    values: {
      PORT: finalValues.PORT!,
      BIND_HOST: finalValues.BIND_HOST!,
      TLS_CERT_FILE: finalValues.TLS_CERT_FILE!,
      TLS_KEY_FILE: finalValues.TLS_KEY_FILE!,
      INGEST_TOKEN: finalValues.INGEST_TOKEN!,
    },
  };
}
