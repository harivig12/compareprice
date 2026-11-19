/**
 * First-run setup and environment checks.
 *
 * Everything here exists because each step cost real debugging time once:
 * the cloak profile lock, the missing adapters, the delivery location. The
 * point is that nobody should have to rediscover them.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, rmSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

import { PKG_ROOT, DATA_DIR, ensureDataDir } from './paths.js';
import { ALL_PLATFORMS } from './platforms.js';

const CLOAK_PROFILE = join(homedir(), '.webcmd', 'cloak', 'profiles', 'default');
const ADAPTER_SITES = ['blinkit', 'zepto', 'bigbasket', 'amazon'];

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `${code}${s}${C.reset}` : String(s));

const ok = (m) => console.log(`  ${c(C.green, '✔')} ${m}`);
const bad = (m, fix) => {
  console.log(`  ${c(C.red, '✖')} ${m}`);
  if (fix) console.log(`    ${c(C.dim, fix)}`);
};
const warn = (m, fix) => {
  console.log(`  ${c(C.yellow, '!')} ${m}`);
  if (fix) console.log(`    ${c(C.dim, fix)}`);
};

function run(cmd, args, { timeout = 90_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32' },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

/**
 * Check the environment. Returns true when everything needed is in place.
 */
export async function doctor({ quiet = false } = {}) {
  if (!quiet) console.log(`\n${c(C.bold, 'basket doctor')}\n`);
  let healthy = true;

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else { bad(`Node ${process.versions.node} — need >= 20`, 'Upgrade Node.'); healthy = false; }

  // 2. webcmd present
  const ver = await run('webcmd', ['--version'], { timeout: 20_000 });
  if (ver.err) {
    bad('webcmd not found', 'npm install -g @agentrhq/webcmd');
    return false; // nothing below can work
  }
  ok(`webcmd ${ver.stdout.trim()}`);

  // 3. bridge
  const doc = await run('webcmd', ['doctor'], { timeout: 120_000 });
  const docOut = doc.stdout + doc.stderr;
  if (/Everything looks good/i.test(docOut)) {
    ok('webcmd browser bridge connected');
  } else {
    healthy = false;
    // webcmd's own message doesn't name the usual cause, so we do.
    if (/already in use|existing browser session/i.test(docOut)) {
      bad(
        'webcmd bridge down — cloak profile is locked by an orphaned browser',
        'Run: basket setup   (it clears the lock)',
      );
    } else if (/fetch failed/i.test(docOut)) {
      bad(
        'webcmd bridge down — cloak is downloading Chromium (~150 MB)',
        'Needs working network. Wait for it to finish, then re-run.',
      );
    } else {
      bad('webcmd bridge down', 'Run: webcmd doctor -v   for the full output');
    }
  }

  // 4. adapters
  const list = await run('webcmd', ['list', '-f', 'json'], { timeout: 30_000 });
  let installed = [];
  try {
    installed = JSON.parse(list.stdout || '[]').map((x) => x.site);
  } catch { /* leave empty */ }
  const missing = ADAPTER_SITES.filter((s) => !installed.includes(s));
  if (missing.length === 0) {
    ok(`adapters installed: ${ADAPTER_SITES.join(', ')}`);
  } else {
    healthy = false;
    bad(`adapters missing: ${missing.join(', ')}`, 'Run: basket setup');
  }

  // 5. writable data dir
  try {
    ensureDataDir();
    accessSync(DATA_DIR, constants.W_OK);
    ok(`data directory writable (${DATA_DIR})`);
  } catch {
    healthy = false;
    bad(`cannot write to ${DATA_DIR}`, 'Set BASKET_HOME to a writable path.');
  }

  if (!quiet) {
    console.log('');
    console.log(healthy
      ? c(C.green + C.bold, '  Everything looks good.')
      : c(C.yellow, '  Some checks failed — see the fixes above.'));
    console.log('');
  }
  return healthy;
}

/**
 * Run a command that reads a program on stdin. `webcmd browser … run --stdin`
 * needs this; execFile has no way to supply stdin.
 */
function runWithStdin(cmd, args, input, { timeout = 180_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ err: code === 0 ? null : new Error(`exit ${code}`), stdout: out, stderr: err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ err: e, stdout: out, stderr: err });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Kill orphaned cloak browsers and clear the singleton lock files. */
async function clearCloakLock() {
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*cloakbrowser*' } | " +
      'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }',
    ], { timeout: 60_000 });
  } else {
    await run('pkill', ['-f', 'cloakbrowser'], { timeout: 30_000 });
  }

  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = join(CLOAK_PROFILE, f);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Guided first-run setup.
 */
export async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim().toLowerCase();

  try {
    console.log(`\n${c(C.bold, 'basket setup')}\n`);
    console.log(c(C.dim, '  Gets webcmd talking to a browser, installs the adapters,'));
    console.log(c(C.dim, '  and helps you set a delivery location on each platform.\n'));

    // ── 1. webcmd present?
    const ver = await run('webcmd', ['--version'], { timeout: 20_000 });
    if (ver.err) {
      bad('webcmd is not installed.', 'npm install -g @agentrhq/webcmd');
      console.log('\n  Install it, then run basket setup again.\n');
      return false;
    }
    ok(`webcmd ${ver.stdout.trim()}`);

    // ── 2. bridge
    let doc = await run('webcmd', ['doctor'], { timeout: 120_000 });
    if (!/Everything looks good/i.test(doc.stdout + doc.stderr)) {
      warn('webcmd browser bridge is not connected.');
      const a = await ask(
        '    Clear stale cloak browser locks and retry? [Y/n] ',
      );
      if (a === '' || a === 'y' || a === 'yes') {
        console.log(c(C.dim, '    clearing…'));
        await clearCloakLock();
        await new Promise((r) => setTimeout(r, 2500));
        doc = await run('webcmd', ['doctor'], { timeout: 120_000 });
      }
    }
    if (/Everything looks good/i.test(doc.stdout + doc.stderr)) {
      ok('webcmd browser bridge connected');
    } else {
      bad('Bridge still down.', 'Run: webcmd doctor -v');
      console.log(c(C.dim, '\n  If it says "fetch failed", cloak is downloading Chromium — wait and retry.\n'));
      return false;
    }

    // ── 3. adapters
    console.log(c(C.dim, '\n  Generating webcmd adapters…'));
    const gen = await run(
      process.execPath,
      [join(PKG_ROOT, 'scripts', 'build-adapters.js')],
      { timeout: 60_000 },
    );
    if (gen.err) {
      bad('adapter generation failed', gen.stderr.trim().split('\n')[0]);
      return false;
    }
    ok('adapters generated into ~/.webcmd/clis/');

    // ── 4. delivery location
    console.log(`\n${c(C.bold, '  Delivery location')}`);
    console.log(c(C.dim, '  Each platform shows nothing until a location is set. This opens'));
    console.log(c(C.dim, "  them one at a time in webcmd's browser — set the same area on each.\n"));

    const doLoc = await ask('    Set delivery locations now? [Y/n] ');
    if (doLoc === '' || doLoc === 'y' || doLoc === 'yes') {
      const sites = {
        blinkit: 'https://blinkit.com/',
        zepto: 'https://www.zepto.com/',
        bigbasket: 'https://www.bigbasket.com/',
      };
      for (const [name, url] of Object.entries(sites)) {
        console.log(c(C.cyan, `\n    Opening ${name}…`));
        const program = `await page.goto(${JSON.stringify(url)}, { waitUntil: "load" });\nreturn { url: await page.evaluate("location.href") };`;
        const r = await runWithStdin(
          'webcmd',
          ['browser', 'setloc', 'run', '--stdin'],
          program,
          // foreground so the window is actually visible to click in
          { env: { WEBCMD_WINDOW: 'foreground' } },
        );
        if (r.err) {
          console.log(c(C.dim, `    Couldn't open it automatically — visit ${url}`));
          console.log(c(C.dim, "    in webcmd's browser window yourself."));
        }
        await ask(`    Set the location on ${name}, then press Enter… `);
      }
      ok('locations recorded in the webcmd browser profile');
    } else {
      warn('Skipped. Platforms will report "results never rendered" until set.');
    }

    // ── 5. re-check
    console.log('');
    const healthy = await doctor({ quiet: true });
    console.log('');
    if (healthy) {
      console.log(c(C.green + C.bold, '  Setup complete.'));
      console.log(c(C.dim, '\n  Try it:'));
      console.log('    basket "amul butter 500g" --web');
      console.log(c(C.dim, '  or with a file:'));
      console.log('    basket basket.txt --web\n');
    } else {
      console.log(c(C.yellow, '  Setup finished with warnings — run basket doctor.\n'));
    }
    return healthy;
  } finally {
    rl.close();
  }
}

export { ALL_PLATFORMS };
