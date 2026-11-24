/**
 * The default list lives in <data>/basket.txt (2026-11-20): editing the file
 * works, Settings writes it, and an older config.json list is moved out (kept).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, basketFile, configFile } from '../src/config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'basket-cfg-'));

test('editing basket.txt in the data folder changes the default list, with no restart', () => {
  const dir = tmp();
  try {
    loadConfig(dir);
    assert.ok(existsSync(basketFile(dir)), 'created on first load');
    writeFileSync(basketFile(dir), 'toor dal\ntata salt 1kg\n');
    assert.equal(loadConfig(dir).basket, 'toor dal\ntata salt 1kg\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Settings saves the list to basket.txt, never into config.json', () => {
  const dir = tmp();
  try {
    saveConfig({ ...loadConfig(dir), basket: 'onion 1kg' }, dir);
    assert.equal(readFileSync(basketFile(dir), 'utf8'), 'onion 1kg\n');
    assert.equal('basket' in JSON.parse(readFileSync(configFile(dir), 'utf8')), false);
    assert.equal(loadConfig(dir).basket, 'onion 1kg\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an older config.json list is moved to basket.txt and kept as basket.previous.txt (seen 2026-11-20)', () => {
  const dir = tmp();
  try {
    const old = '2x amul taaza toned milk 500ml\namul butter 500g\n';
    writeFileSync(configFile(dir), JSON.stringify({ sites: ['kpn'], basket: old }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.basket, old, 'the user\'s list survives');
    assert.deepEqual(cfg.sites, ['kpn']);
    assert.equal(readFileSync(basketFile(dir), 'utf8'), old);
    assert.equal(readFileSync(join(dir, 'basket.previous.txt'), 'utf8'), old);
    assert.equal('basket' in JSON.parse(readFileSync(configFile(dir), 'utf8')), false, 'moved out of config.json');
    // From now on the file decides.
    writeFileSync(basketFile(dir), 'toor dal\n');
    assert.equal(loadConfig(dir).basket, 'toor dal\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
