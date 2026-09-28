// Self-signed X.509 v3 certificates built with Node's own `crypto` module,
// no `openssl` and no dependency. Node has no X.509 builder, so the
// certificate body (the DER "TBSCertificate") is assembled by hand from a
// handful of ASN.1 encoding helpers and signed with `crypto.sign`. This is
// what lets the installer mint a working HTTPS certificate on stock Windows
// PowerShell 5.1, which has neither `openssl` nor a private-key PEM exporter.

import crypto from 'crypto';
import net from 'net';

export interface CertOptions {
  commonName: string;
  dnsNames: string[];
  ipAddresses: string[];
  days: number;
  now?: Date;
}

export interface CertResult {
  certPem: string;
  keyPem: string;
  fingerprint256: string;
  notAfter: string;
}

export interface NetIf {
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
}

// ── ASN.1 DER encoding helpers ───────────────────────────────────────────────

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, body: Buffer): Buffer => tlv(0xa0 + n, body);
const integer = (buf: Buffer): Buffer => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const boolean_ = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octetString = (b: Buffer): Buffer => tlv(0x04, b);
const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));

function objectId(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const value of parts.slice(2)) {
    const chunk: number[] = [];
    let v = value;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime for years before 2050, GeneralizedTime after — the X.509 rule. */
function asn1Time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

function ipToBytes(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  // Minimal IPv6 expander: only needs to handle the "::" shorthand.
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined
    ? [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts]
    : headParts;
  return Buffer.concat(groups.map((g) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(parseInt(g, 16));
    return b;
  }));
}

export function buildSelfSignedCert(opts: CertOptions): CertResult {
  const { commonName, dnsNames, ipAddresses, days } = opts;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // stay positive
  if (serial[0] === 0) serial[0] = 1; // stay non-zero
  const signatureAlgorithm = sequence(objectId('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0)));
  const name = sequence(set(sequence(objectId('2.5.4.3'), utf8String(commonName))));

  const notBefore = new Date((opts.now ?? new Date()).getTime() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + days * 86400000);

  // subjectKeyIdentifier is the SHA-1 hash of the PKCS#1 public key bytes
  // (the BIT STRING contents of subjectPublicKeyInfo), not the whole SPKI.
  const pkcs1PublicKey = publicKey.export({ type: 'pkcs1', format: 'der' }) as Buffer;
  const subjectKeyId = crypto.createHash('sha1').update(pkcs1PublicKey).digest();

  const subjectAltNames = sequence(
    ...dnsNames.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
    ...ipAddresses.map((ip) => tlv(0x87, ipToBytes(ip))),
  );
  const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
    sequence(objectId(id), ...(critical ? [boolean_(true)] : []), octetString(value));
  const extensions = [
    extension('2.5.29.19', true, sequence()), // basicConstraints, CA:FALSE
    // keyUsage: digitalSignature(0) + keyEncipherment(2), no keyCertSign — this is a leaf cert
    extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x05, 0xa0]))),
    extension('2.5.29.37', false, sequence(objectId('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
    extension('2.5.29.14', false, octetString(subjectKeyId)), // subjectKeyIdentifier
    extension('2.5.29.17', false, subjectAltNames), // subjectAltName
  ];

  const tbsCertificate = sequence(
    explicit(0, integer(Buffer.from([2]))), // version 3
    integer(serial),
    signatureAlgorithm,
    name, // issuer
    sequence(asn1Time(notBefore), asn1Time(notAfter)),
    name, // subject == issuer, self-signed
    spki,
    explicit(3, sequence(...extensions)),
  );
  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const certificate = sequence(tbsCertificate, signatureAlgorithm, bitString(signature));

  const certPem = `-----BEGIN CERTIFICATE-----\n${(certificate.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const fingerprint256 = new crypto.X509Certificate(certPem).fingerprint256;

  return { certPem, keyPem, fingerprint256, notAfter: notAfter.toISOString() };
}

export function isLinkLocalIPv4(address: string): boolean {
  return address.startsWith('169.254.');
}

/** The lowercased hostname, plus a `.local` mDNS alias when it is bare (no dot) — shared by
 *  `defaultSans` (what goes in the cert) and the pairing CLI (what URL to print), so the two
 *  never drift apart on which alias is actually in the certificate. */
export function hostnameDnsNames(hostname: string): string[] {
  const lowerHost = hostname.toLowerCase();
  return lowerHost.includes('.') ? [lowerHost] : [lowerHost, `${lowerHost}.local`];
}

/** The first network interface a LAN client could actually reach: IPv4, not internal
 *  (loopback), not link-local (169.254.0.0/16, assigned when DHCP fails). */
export function firstUsableIPv4(interfaces: NetIf[]): string | undefined {
  for (const iface of interfaces) {
    if (iface.family !== 'IPv4' || iface.internal) continue;
    if (isLinkLocalIPv4(iface.address)) continue;
    return iface.address;
  }
  return undefined;
}

/** Default SAN rules: deduplicated, DNS entries before IP entries, first-seen order kept. */
export function defaultSans(
  hostname: string,
  interfaces: NetIf[],
  bindHost: string,
  extras: string[],
): { dnsNames: string[]; ipAddresses: string[] } {
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  const addDns = (name: string): void => { if (!dnsNames.includes(name)) dnsNames.push(name); };
  const addIp = (ip: string): void => { if (!ipAddresses.includes(ip)) ipAddresses.push(ip); };

  addDns('localhost');
  for (const name of hostnameDnsNames(hostname)) addDns(name);

  addIp('127.0.0.1');
  addIp('::1');

  if (bindHost === '0.0.0.0' || bindHost === '::') {
    for (const iface of interfaces) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (isLinkLocalIPv4(iface.address)) continue;
      addIp(iface.address);
    }
  } else if (bindHost !== '127.0.0.1' && bindHost !== '::1') {
    addIp(bindHost);
  }

  for (const extra of extras) {
    const ipVersion = net.isIP(extra);
    if (ipVersion === 6 && /[.%]/.test(extra)) {
      // IPv4-mapped ("::ffff:1.2.3.4") and zone-qualified ("fe80::1%eth0") forms both pass
      // net.isIP, but ipToBytes() only handles plain "::"-shorthand IPv6 and would either
      // mis-encode the mapped address or embed the zone suffix as literal hex garbage.
      throw new Error(`Invalid --san value "${extra}": IPv4-mapped or zone-qualified IPv6 addresses are not supported.`);
    } else if (ipVersion) {
      addIp(extra);
    } else if (/^[A-Za-z0-9.-]+$/.test(extra)) {
      addDns(extra);
    } else {
      throw new Error(`Invalid --san value "${extra}": must be an IP address or a hostname matching ^[A-Za-z0-9.-]+$.`);
    }
  }

  return { dnsNames, ipAddresses };
}
