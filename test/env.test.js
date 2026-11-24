import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bridgeEnv } from '../src/env.js';
import { resolveDataDir } from '../src/paths.js';

test('JHOLA_* settings fill in the old BASKET_* names, and an explicit BASKET_* value wins', () => {
  const env = bridgeEnv({ JHOLA_PORT: '8080', JHOLA_HOST: '0.0.0.0', BASKET_HOST: '127.0.0.1', OTHER: 'x' });
  assert.equal(env.BASKET_PORT, '8080');
  assert.equal(env.BASKET_HOST, '127.0.0.1', 'an old setting already in place is not overwritten');
  assert.equal(env.OTHER, 'x');
});

test('the data folder: JHOLA_HOME wins, an existing ~/.basket is kept, otherwise ~/.jhola', () => {
  const home = mkdtempSync(join(tmpdir(), 'jhola-home-'));
  try {
    assert.equal(resolveDataDir(bridgeEnv({ JHOLA_HOME: join(home, 'custom') }), home), join(home, 'custom'));
    assert.equal(resolveDataDir({}, home), join(home, '.jhola'), 'fresh install');
    rmSync(join(home, '.jhola'), { recursive: true, force: true });
    mkdirSync(join(home, '.basket'));
    assert.equal(resolveDataDir({}, home), join(home, '.basket'), 'saved prices from before the rename stay in use');
    mkdirSync(join(home, '.jhola'));
    assert.equal(resolveDataDir({}, home), join(home, '.jhola'), 'once ~/.jhola exists it is used');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
