// tests/pdfExport.shutdown.test.ts
//
// Browser lifetime in src/pdfExport.ts against a mocked puppeteer: shutdown
// (closeBrowser with a time limit), the idle close, an unexpected disconnect,
// a failed launch, and removal of the profile directory the module creates for
// each Chromium. Renders go through the exported renderPdf.
//
// closeBrowser() leaves the module refusing new launches, so every test loads
// a fresh copy of the module. The profile directories are real (mkdtemp under
// os.tmpdir()); the render starts under real timers, and fake timers are only
// switched on once puppeteer.launch has been called, because the directory is
// created with real file I/O before it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const launch = vi.hoisted(() => vi.fn());
vi.mock('puppeteer', () => ({ default: { launch } }));

type PdfExport = typeof import('../src/pdfExport');
let pdfExport: PdfExport;
let exitListenersBefore: Function[];

// Set so baseUrl() does not read the application config, which is not loaded here.
process.env.EXPORT_BASE_URL = 'http://127.0.0.1:1';

const PROFILE_PREFIX = 'msfslogger-pdf-profile-';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface BrowserOptions {
  /**
   * 'quits': close() ends the process and resolves. 'hangs': close() never
   * settles. 'rejects': close() rejects and the process keeps running.
   */
  close?: 'quits' | 'hangs' | 'rejects';
  /** What page.goto() returns. Defaults to a rejection, which ends the render at once. */
  goto?: () => Promise<unknown>;
  /** Whether kill() ends the process at once. Default true. */
  killExits?: boolean;
}

function makeBrowser(opts: BrowserOptions = {}) {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  });
  const exit = (signal: string | null) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    if (signal) proc.signalCode = signal;
    else proc.exitCode = 0;
    proc.emit('exit', proc.exitCode, proc.signalCode);
  };
  proc.kill.mockImplementation((signal: string) => {
    if (opts.killExits !== false) exit(signal);
    return true;
  });
  const page = {
    setDefaultNavigationTimeout: vi.fn(),
    setViewport: vi.fn(),
    emulateMediaType: vi.fn(),
    setUserAgent: vi.fn(),
    setCookie: vi.fn(),
    goto: vi.fn(opts.goto ?? (() => Promise.reject(new Error('stop here')))),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    pdf: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    close: vi.fn().mockResolvedValue(undefined),
  };
  // puppeteer's close() resolves after the Chromium process has exited.
  const close = vi.fn(() => {
    if (opts.close === 'hangs') return new Promise<void>(() => {});
    if (opts.close === 'rejects') return Promise.reject(new Error('close failed'));
    exit(null);
    return Promise.resolve();
  });
  const browser = Object.assign(new EventEmitter(), {
    newPage: vi.fn().mockResolvedValue(page),
    close,
    process: vi.fn(() => proc),
  });
  return { browser, proc, page, exit };
}

function profileDirArg(call = 0): string {
  const dir = launch.mock.calls[call][0].userDataDir;
  expect(typeof dir).toBe('string');
  return dir;
}

function profileDirsOnDisk(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PROFILE_PREFIX));
}

/** Launches a browser through a render that fails at page.goto(). */
async function launchMocked(opts: BrowserOptions = {}) {
  const made = makeBrowser(opts);
  launch.mockResolvedValue(made.browser);
  await expect(pdfExport.renderPdf('/x')).rejects.toThrow('stop here');
  return { ...made, profileDir: profileDirArg() };
}

beforeEach(async () => {
  vi.resetModules();
  pdfExport = await import('../src/pdfExport');
  exitListenersBefore = process.listeners('exit');
});

afterEach(() => {
  vi.useRealTimers();
  for (const call of launch.mock.calls) {
    const dir = call[0]?.userDataDir;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  launch.mockReset();
  for (const listener of process.listeners('exit')) {
    if (!exitListenersBefore.includes(listener)) process.off('exit', listener as () => void);
  }
});

describe('browser launch options', () => {
  it('leaves SIGINT, SIGTERM and SIGHUP to the server', async () => {
    await launchMocked();
    const opts = launch.mock.calls[0][0];
    expect(opts.handleSIGINT).toBe(false);
    expect(opts.handleSIGTERM).toBe(false);
    expect(opts.handleSIGHUP).toBe(false);
  });

  it('passes a new profile directory under the OS temp directory as userDataDir', async () => {
    const { profileDir } = await launchMocked();
    expect(path.dirname(profileDir)).toBe(os.tmpdir());
    expect(path.basename(profileDir).startsWith(PROFILE_PREFIX)).toBe(true);
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);
  });
});

describe('closeBrowser with a time limit', () => {
  it('closes a browser that quits normally, does not kill it, and removes its profile', async () => {
    const { browser, proc, profileDir } = await launchMocked();
    expect(fs.existsSync(profileDir)).toBe(true);
    await expect(pdfExport.closeBrowser(1500)).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('kills the Chromium process when close() does not finish in time, then removes its profile once it has exited', async () => {
    const { browser, proc, exit, profileDir } = await launchMocked({ close: 'hangs', killExits: false });
    vi.useFakeTimers();
    let resolved = false;
    const done = pdfExport.closeBrowser(1500).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    // Not removed while the killed process has not exited yet
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(resolved).toBe(false);
    exit('SIGKILL');
    await done;
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills the browser when close() rejects before the limit, and still removes its profile', async () => {
    const { browser, proc, profileDir } = await launchMocked({ close: 'rejects' });
    await expect(pdfExport.closeBrowser(1500)).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('resolves at once when no browser was launched', async () => {
    vi.useFakeTimers();
    await expect(pdfExport.closeBrowser(1500)).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('shutdown with an export in progress', () => {
  it('lets the render in progress finish, fails the one queued behind it without a launch, then closes', async () => {
    const gate = deferred<void>();
    const { browser, proc } = makeBrowser({ goto: () => gate.promise });
    launch.mockResolvedValue(browser);
    const first = pdfExport.renderPdf('/first');
    const second = pdfExport.renderPdf('/second');
    await vi.waitFor(() => expect(browser.newPage).toHaveBeenCalled());
    const firstProfile = profileDirArg();

    vi.useFakeTimers();
    const done = pdfExport.closeBrowser(2500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(browser.close).not.toHaveBeenCalled();
    gate.resolve();

    await expect(first).resolves.toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    await expect(second).rejects.toThrow('shutting down');
    await done;
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(firstProfile)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills the browser at the limit when the render has not finished', async () => {
    const gate = deferred<void>();
    const { browser, proc } = makeBrowser({ goto: () => gate.promise });
    launch.mockResolvedValue(browser);
    const render = pdfExport.renderPdf('/slow');
    await vi.waitFor(() => expect(browser.newPage).toHaveBeenCalled());
    const profileDir = profileDirArg();

    vi.useFakeTimers();
    const done = pdfExport.closeBrowser(2500);
    await vi.advanceTimersByTimeAsync(2499);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    await done;
    expect(browser.close).not.toHaveBeenCalled();
    expect(fs.existsSync(profileDir)).toBe(false);

    // The killed browser fails the render
    gate.reject(new Error('Target closed'));
    await expect(render).rejects.toThrow('Target closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a render requested after shutdown without launching', async () => {
    await pdfExport.closeBrowser(2500);
    await expect(pdfExport.renderPdf('/late')).rejects.toThrow('shutting down');
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not launch when shutdown starts while the profile directory is being created', async () => {
    const before = profileDirsOnDisk();
    const mkdtemp = vi.spyOn(fs.promises, 'mkdtemp');
    const render = pdfExport.renderPdf('/x');
    // Let renderPdf reach getBrowser(), which starts creating the directory
    await Promise.resolve();
    await Promise.resolve();
    await pdfExport.closeBrowser(2500);
    await expect(render).rejects.toThrow('shutting down');
    // The directory was created, so the check after mkdtemp is what stopped the launch
    expect(mkdtemp).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(profileDirsOnDisk()).toEqual(before);
  });
});

describe('shutdown with a launch still pending', () => {
  it('gives up at the same limit, then kills the browser and removes its profile when the launch finishes', async () => {
    const launched = deferred<unknown>();
    const { browser, proc } = makeBrowser();
    launch.mockReturnValue(launched.promise);
    const render = pdfExport.renderPdf('/x');
    await vi.waitFor(() => expect(launch).toHaveBeenCalled());
    const profileDir = profileDirArg();

    vi.useFakeTimers();
    let resolved = false;
    const done = pdfExport.closeBrowser(2500).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(2499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(proc.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(profileDir)).toBe(true);

    vi.useRealTimers();
    launched.resolve(browser);
    await vi.waitFor(() => expect(fs.existsSync(profileDir)).toBe(false));
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(render).rejects.toThrow('stop here');
  });
});

describe('profile directory removal outside shutdown', () => {
  it('removes it after the idle-timer close', async () => {
    const gate = deferred<void>();
    const { browser, proc } = makeBrowser({ goto: () => gate.promise });
    launch.mockResolvedValue(browser);
    const render = pdfExport.renderPdf('/x');
    await vi.waitFor(() => expect(browser.newPage).toHaveBeenCalled());
    const profileDir = profileDirArg();

    expect(fs.existsSync(profileDir)).toBe(true);
    vi.useFakeTimers();
    gate.resolve();
    await render;
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();

    vi.useRealTimers();
    await vi.waitFor(() => expect(fs.existsSync(profileDir)).toBe(false));
  });

  it('removes it after an unexpected disconnect once the process has exited, and relaunches next time', async () => {
    const { browser, exit, profileDir } = await launchMocked();
    browser.emit('disconnected');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fs.existsSync(profileDir)).toBe(true);
    exit('SIGSEGV');
    await vi.waitFor(() => expect(fs.existsSync(profileDir)).toBe(false));

    const next = makeBrowser();
    launch.mockResolvedValue(next.browser);
    await expect(pdfExport.renderPdf('/again')).rejects.toThrow('stop here');
    expect(launch).toHaveBeenCalledTimes(2);
    expect(profileDirArg(1)).not.toBe(profileDir);
  });

  it('removes it when puppeteer.launch fails', async () => {
    let existedAtLaunch = false;
    launch.mockImplementation(async (opts: { userDataDir: string }) => {
      existedAtLaunch = fs.existsSync(opts.userDataDir);
      throw new Error('no chrome');
    });
    await expect(pdfExport.renderPdf('/x')).rejects.toThrow('no chrome');
    expect(existedAtLaunch).toBe(true);
    expect(fs.existsSync(profileDirArg())).toBe(false);
  });
});

describe('process exit listener', () => {
  it('is attached while a profile directory exists and removes it synchronously', async () => {
    const { profileDir } = await launchMocked();
    const added = process.listeners('exit').filter(l => !exitListenersBefore.includes(l));
    expect(added).toHaveLength(1);
    (added[0] as (code: number) => void)(0);
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('is detached again once every profile directory has been removed', async () => {
    await launchMocked();
    expect(process.listeners('exit').filter(l => !exitListenersBefore.includes(l))).toHaveLength(1);
    await pdfExport.closeBrowser(1500);
    const added = process.listeners('exit').filter(l => !exitListenersBefore.includes(l));
    expect(added).toHaveLength(0);
  });
});

/** Launches a browser through a render that succeeds, with fake timers on from just before it finishes. */
async function launchThenIdle(opts: BrowserOptions = {}) {
  const gate = deferred<void>();
  const made = makeBrowser({ ...opts, goto: () => gate.promise });
  launch.mockResolvedValue(made.browser);
  const render = pdfExport.renderPdf('/x');
  await vi.waitFor(() => expect(made.browser.newPage).toHaveBeenCalled());
  const profileDir = profileDirArg(launch.mock.calls.length - 1);
  vi.useFakeTimers();
  gate.resolve();
  await render;
  return { ...made, profileDir };
}

describe('shutdown during an idle close', () => {
  it('kills the browser at the limit when the idle close has not finished, and removes its profile after it exits', async () => {
    const { browser, proc, exit, profileDir } = await launchThenIdle({ close: 'hangs', killExits: false });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(browser.close).toHaveBeenCalledTimes(1);

    let resolved = false;
    const done = pdfExport.closeBrowser(2500).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(2499);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(resolved).toBe(false);
    exit('SIGKILL');
    await done;
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("'disconnected' from an older browser", () => {
  it('does not drop the handle of a browser launched after it', async () => {
    // B1 goes idle and its close never finishes, so its handle is already gone
    const first = await launchThenIdle({ close: 'hangs' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(first.browser.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    // B2 is launched by the next export
    const second = makeBrowser();
    launch.mockResolvedValue(second.browser);
    await expect(pdfExport.renderPdf('/b2')).rejects.toThrow('stop here');
    expect(launch).toHaveBeenCalledTimes(2);

    // B1 finally disconnects; the next export must still use B2
    first.browser.emit('disconnected');
    await expect(pdfExport.renderPdf('/again')).rejects.toThrow('stop here');
    expect(launch).toHaveBeenCalledTimes(2);
    expect(second.browser.newPage).toHaveBeenCalledTimes(2);
  });
});

describe("Chromium's socket directory", () => {
  /** Links <profile>/SingletonSocket to a socket inside `socketDir`, the way Chromium does. */
  function linkSocket(profileDir: string, socketDir: string): void {
    fs.writeFileSync(path.join(socketDir, 'SingletonSocket'), '');
    fs.symlinkSync(path.join(socketDir, 'SingletonSocket'), path.join(profileDir, 'SingletonSocket'));
  }

  let others: string[] = [];
  afterEach(() => {
    for (const dir of others) fs.rmSync(dir, { recursive: true, force: true });
    others = [];
  });

  function tempDir(prefix: string, parent = os.tmpdir()): string {
    const dir = fs.mkdtempSync(path.join(parent, prefix));
    others.push(dir);
    return dir;
  }

  it('is removed with the profile when the link points to org.chromium.Chromium.* directly under the temp directory', async () => {
    const { profileDir } = await launchMocked({ close: 'hangs' });
    const socketDir = tempDir('org.chromium.Chromium.');
    linkSocket(profileDir, socketDir);
    vi.useFakeTimers();
    const done = pdfExport.closeBrowser(1500);
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(fs.existsSync(socketDir)).toBe(false);
  });

  it('is left alone when the link points to a directory with another name or not directly under the temp directory', async () => {
    const { profileDir } = await launchMocked();
    const otherName = tempDir('msfslogger-test-socket-');
    linkSocket(profileDir, otherName);
    await pdfExport.closeBrowser(1500);
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(fs.existsSync(otherName)).toBe(true);

    vi.resetModules();
    pdfExport = await import('../src/pdfExport');
    launch.mockReset();
    const second = await launchMocked();
    const nested = tempDir('org.chromium.Chromium.', tempDir('msfslogger-test-parent-'));
    linkSocket(second.profileDir, nested);
    await pdfExport.closeBrowser(1500);
    expect(fs.existsSync(second.profileDir)).toBe(false);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('is removed by the exit listener too', async () => {
    const { profileDir } = await launchMocked();
    const socketDir = tempDir('org.chromium.Chromium.');
    linkSocket(profileDir, socketDir);
    const added = process.listeners('exit').filter(l => !exitListenersBefore.includes(l));
    (added[0] as (code: number) => void)(0);
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(fs.existsSync(socketDir)).toBe(false);
  });
});
