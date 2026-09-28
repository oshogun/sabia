// tests/install/selfSignedCert.test.ts — the hand-written DER encoder and the
// default-SAN rules. No mocks: crypto, tls and https are the real Node APIs,
// exercised against a real loopback listener.

import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import tls from 'tls';
import https from 'https';
import { buildSelfSignedCert, defaultSans, firstUsableIPv4, type NetIf } from '../../src/install/selfSignedCert';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('buildSelfSignedCert()', () => {
  it('produces a certificate Node itself accepts as valid X.509', () => {
    const { certPem, keyPem, fingerprint256, notAfter } = buildSelfSignedCert({
      commonName: 'Sabia',
      dnsNames: ['localhost', 'simbox.local'],
      ipAddresses: ['127.0.0.1', '::1'],
      days: 3650,
      now: NOW,
    });

    const cert = new crypto.X509Certificate(certPem);
    expect(cert.subject).toBe('CN=Sabia');
    expect(cert.issuer).toBe('CN=Sabia');
    expect(cert.ca).toBe(false);
    expect(cert.subjectAltName).toContain('DNS:localhost');
    expect(cert.subjectAltName).toContain('DNS:simbox.local');
    expect(cert.subjectAltName).toContain('IP Address:127.0.0.1');
    // Node's X509Certificate#keyUsage actually reports the extended-key-usage
    // OIDs (there is no accessor for the basic keyUsage bit names) — this
    // confirms extKeyUsage serverAuth parsed correctly.
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(cert.fingerprint256).toBe(fingerprint256);
    expect(new Date(notAfter).getUTCFullYear()).toBe(2035); // NOW + 3650 days, just short of the 10-year mark

    // tls.createSecureContext throws on a cert/key pair it cannot parse or
    // that do not match — this is src/config.ts's own validation step.
    expect(() => tls.createSecureContext({ cert: certPem, key: keyPem })).not.toThrow();
  });

  it('sets notBefore five minutes in the past, to absorb clock skew', () => {
    const { certPem } = buildSelfSignedCert({
      commonName: 'Sabia', dnsNames: ['localhost'], ipAddresses: [], days: 1, now: NOW,
    });
    const cert = new crypto.X509Certificate(certPem);
    const notBefore = new Date(cert.validFrom);
    expect(NOW.getTime() - notBefore.getTime()).toBe(5 * 60 * 1000);
  });

  it('accepts a loopback HTTPS client that pins the cert as `ca` for a SAN name, and rejects a non-SAN name', async () => {
    const { certPem, keyPem } = buildSelfSignedCert({
      commonName: 'Sabia',
      dnsNames: ['localhost', 'simbox.local'],
      ipAddresses: ['127.0.0.1'],
      days: 3650,
      now: NOW,
    });

    const server = https.createServer({ cert: certPem, key: keyPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const connect = (servername: string | undefined): Promise<'OK' | string> =>
      new Promise((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port, ca: certPem, servername }, () => {
          resolve('OK');
          socket.end();
        });
        socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      });

    try {
      await expect(connect('simbox.local')).resolves.toBe('OK');
      await expect(connect(undefined)).resolves.toBe('OK'); // bare IP dial, no SNI/hostname check beyond the ca chain
      await expect(connect('not-in-san.example')).resolves.not.toBe('OK');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('defaultSans()', () => {
  const interfaces: NetIf[] = [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: '169.254.1.5', family: 'IPv4', internal: false }, // link-local, excluded
    { address: 'fe80::1', family: 'IPv6', internal: false }, // IPv6, excluded (IPv4 only rule)
  ];

  it('always includes localhost, the lowercased hostname (+.local if bare), and the loopback IPs, DNS before IP', () => {
    const { dnsNames, ipAddresses } = defaultSans('SimBox', [], '0.0.0.0', []);
    expect(dnsNames).toEqual(['localhost', 'simbox', 'simbox.local']);
    expect(ipAddresses).toEqual(['127.0.0.1', '::1']);
  });

  it('does not add a bare .local alias when the hostname already has a dot', () => {
    const { dnsNames } = defaultSans('simbox.lan', [], '0.0.0.0', []);
    expect(dnsNames).toEqual(['localhost', 'simbox.lan']);
  });

  it('adds every non-internal, non-link-local IPv4 interface when bindHost is 0.0.0.0', () => {
    const { ipAddresses } = defaultSans('simbox', interfaces, '0.0.0.0', []);
    expect(ipAddresses).toEqual(['127.0.0.1', '::1', '192.168.1.20']);
  });

  it('adds every non-internal IPv4 interface when bindHost is ::, same as 0.0.0.0', () => {
    const { ipAddresses } = defaultSans('simbox', interfaces, '::', []);
    expect(ipAddresses).toContain('192.168.1.20');
  });

  it('adds a specific non-loopback bindHost as its own SAN instead of scanning interfaces', () => {
    const { ipAddresses } = defaultSans('simbox', interfaces, '192.168.1.99', []);
    expect(ipAddresses).toEqual(['127.0.0.1', '::1', '192.168.1.99']);
  });

  it('does not duplicate the loopback IPs when bindHost is itself loopback', () => {
    const { ipAddresses } = defaultSans('simbox', interfaces, '127.0.0.1', []);
    expect(ipAddresses).toEqual(['127.0.0.1', '::1']);
  });

  it('classifies --san extras as IP or DNS, deduplicating against the defaults', () => {
    const { dnsNames, ipAddresses } = defaultSans('simbox', [], '0.0.0.0', ['extra.example', '10.0.0.5', 'localhost']);
    expect(dnsNames).toEqual(['localhost', 'simbox', 'simbox.local', 'extra.example']);
    expect(ipAddresses).toEqual(['127.0.0.1', '::1', '10.0.0.5']);
  });

  it('rejects a --san extra that is neither an IP nor a valid hostname', () => {
    expect(() => defaultSans('simbox', [], '0.0.0.0', ['not a hostname!'])).toThrow(/Invalid --san value/);
  });

  it('rejects an IPv4-mapped or zone-qualified IPv6 --san extra rather than mis-encode it', () => {
    expect(() => defaultSans('simbox', [], '0.0.0.0', ['::ffff:1.2.3.4'])).toThrow(/Invalid --san value/);
    expect(() => defaultSans('simbox', [], '0.0.0.0', ['fe80::1%eth0'])).toThrow(/Invalid --san value/);
  });
});

describe('firstUsableIPv4()', () => {
  const interfaces: NetIf[] = [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '169.254.1.5', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.168.1.20', family: 'IPv4', internal: false },
  ];

  it('skips loopback, link-local and IPv6 interfaces, returning the first usable IPv4 address', () => {
    expect(firstUsableIPv4(interfaces)).toBe('192.168.1.20');
  });

  it('returns undefined when nothing qualifies', () => {
    expect(firstUsableIPv4(interfaces.slice(0, 3))).toBeUndefined();
  });
});
