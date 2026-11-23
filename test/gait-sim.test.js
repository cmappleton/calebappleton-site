import test from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../js/gaitsim.js';
import { fingerprint, mulberry32 } from './fingerprint.js';

// The sim's exact output. Node, Deno, JavaScriptCore and Chromium all give this; if it changes,
// scores changed, and SIM_VERSION has to go up so old shared gaits aren't compared with new ones.
const FINGERPRINT = '50c13c57';

test('the sim gives the pinned fingerprint', () => {
  assert.equal(fingerprint().hash, FINGERPRINT);
});

test('dsin stays within 1e-13 of Math.sin over the range the sim uses', () => {
  let worst = 0;
  for (let i = 0; i <= 400000; i++) { const x = -20 + i * 0.000375; worst = Math.max(worst, Math.abs(sim.dsin(x) - Math.sin(x))); }
  assert.ok(worst < 1e-13, `worst error ${worst}`);
  assert.equal(sim.dsin(0), 0);
  assert.ok(Number.isNaN(sim.dsin(NaN)) && Number.isNaN(sim.dsin(Infinity)));
});

test('evaluate is repeatable and a gait that walks scores its distance', () => {
  const { bestGait, best } = fingerprint();
  assert.equal(sim.evaluate(bestGait), best);
  assert.equal(sim.evaluate(bestGait.slice()), best);
  assert.ok(best > 5, `best ${best}`);
});

test('validGenome accepts everything clampGenome makes and nothing else', () => {
  const rand = mulberry32(7);
  for (let k = 0; k < 500; k++) {
    const g = sim.randomGenome(rand).map(v => v + (rand() - 0.5) * 20);   // push values well out of range
    assert.equal(sim.validGenome(sim.clampGenome(g)), true);
  }
  const g = sim.randomGenome(rand);
  assert.equal(sim.validGenome(g), true);
  assert.equal(sim.validGenome(g.slice(1)), false, 'too short');
  assert.equal(sim.validGenome([...g, 1]), false, 'too long');
  assert.equal(sim.validGenome(Object.assign(g.slice(), { 0: 1.81 })), false, 'frequency out of range');
  assert.equal(sim.validGenome(Object.assign(g.slice(), { 2: Math.PI * 2 })), false, 'phase must be below 2 pi');
  assert.equal(sim.validGenome(Object.assign(g.slice(), { 2: -0.1 })), false, 'negative phase');
  assert.equal(sim.validGenome(Object.assign(g.slice(), { 5: '0.5' })), false, 'a string');
  assert.equal(sim.validGenome(Object.assign(g.slice(), { 5: NaN })), false, 'NaN');
  assert.equal(sim.validGenome(Object.assign(g.slice(), { 26: Infinity })), false, 'Infinity');
  assert.equal(sim.validGenome('nope'), false);
  assert.equal(sim.validGenome(null), false);
});

test('a genome survives a JSON round trip bit for bit', () => {
  const rand = mulberry32(11);
  for (let k = 0; k < 200; k++) {
    const g = sim.randomGenome(rand);
    const back = JSON.parse(JSON.stringify(g));
    assert.deepEqual(back, g);
    assert.equal(sim.evaluate(back), sim.evaluate(g));
  }
});
