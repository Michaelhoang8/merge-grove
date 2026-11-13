import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDS,
  initial,
  step,
  replay,
  merge,
  visible,
  converged,
  syncActions,
  fixture,
  validateState,
} from '../core.js';
const add = (node, value) => ({ type: 'add', node, value }),
  remove = (node, value) => ({ type: 'remove', node, value }),
  inc = (node, amount) => ({ type: 'increment', node, amount });
test('observed removal loses to a concurrent new add, then a later observed removal wins', () => {
  let sim = replay(fixture());
  sim = replay([...fixture(), ...syncActions(sim)]);
  assert.ok(converged(sim));
  assert.deepEqual(visible(sim.nodes[0].state).values, ['apples']);
  assert.equal(visible(sim.nodes[0].state).counter, 2);
  sim = step(sim, remove('C', 'apples'));
  for (const a of syncActions(sim)) sim = step(sim, a);
  assert.ok(converged(sim));
  assert.deepEqual(visible(sim.nodes[0].state).values, []);
});
test('removed add tags do not resurrect when an old snapshot arrives', () => {
  let sim = step(initial(), add('A', 'tea'));
  sim = step(sim, { type: 'send', from: 'A', to: 'B' });
  sim = step(sim, remove('A', 'tea'));
  sim = step(sim, { type: 'send', from: 'A', to: 'B' });
  sim = step(sim, { type: 'deliver', id: 2, keep: false });
  sim = step(sim, { type: 'deliver', id: 1, keep: false });
  assert.deepEqual(visible(sim.nodes[1].state).values, []);
  assert.equal(visible(sim.nodes[1].state).tombstones, 1);
});
test('duplicate delivery is idempotent for both set tags and counter components', () => {
  let sim = replay([add('A', 'tea'), inc('A', 5), { type: 'send', from: 'A', to: 'B' }]);
  sim = step(sim, { type: 'deliver', id: 1, keep: true });
  const state = structuredClone(sim.nodes[1].state);
  for (let i = 0; i < 10; i++) sim = step(sim, { type: 'deliver', id: 1, keep: true });
  assert.deepEqual(sim.nodes[1].state, state);
  assert.equal(visible(state).counter, 5);
});
test('message snapshots are immutable and do not include subsequent local writes', () => {
  const sim = replay([add('A', 'first'), { type: 'send', from: 'A', to: 'B' }, add('A', 'later')]);
  assert.deepEqual(visible(sim.messages[0].state).values, ['first']);
  const next = step(sim, { type: 'deliver', id: 1, keep: false });
  assert.deepEqual(visible(next.nodes[1].state).values, ['first']);
  assert.equal(sim.messages.length, 1);
});
test('partitions block delivery without changing state and queued messages survive healing', () => {
  let sim = replay([
    add('A', 'tea'),
    { type: 'send', from: 'A', to: 'B' },
    { type: 'partition', a: 'A', b: 'B', blocked: true },
  ]);
  const before = JSON.stringify(sim);
  assert.throws(() => step(sim, { type: 'deliver', id: 1, keep: false }), /partition/);
  assert.equal(JSON.stringify(sim), before);
  assert.throws(() => syncActions(sim));
  sim = step(sim, { type: 'partition', a: 'B', b: 'A', blocked: false });
  sim = step(sim, { type: 'deliver', id: 1, keep: false });
  assert.deepEqual(visible(sim.nodes[1].state).values, ['tea']);
});
test('PN counter merges local increments and decrements by component maxima', () => {
  let sim = replay([inc('A', 7), inc('A', -2), inc('B', -4), inc('C', 3)]);
  for (const a of syncActions(sim)) sim = step(sim, a);
  assert.ok(converged(sim));
  for (const n of sim.nodes) {
    assert.deepEqual(n.state.positive, [7, 0, 3]);
    assert.deepEqual(n.state.negative, [2, 4, 0]);
    assert.equal(visible(n.state).counter, 4);
  }
});
test('merge is commutative, associative, and idempotent over 300 generated histories', () => {
  let seed = 91;
  const rand = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 300; trial++) {
    let sim = initial();
    for (let i = 0; i < 30; i++) {
      const node = IDS[rand(3)],
        type = rand(3);
      sim = step(
        sim,
        type === 0
          ? add(node, 'item' + rand(5))
          : type === 1
            ? remove(node, 'item' + rand(5))
            : inc(node, rand(2) ? 1 : -1),
      );
    }
    const [a, b, c] = sim.nodes.map((n) => n.state);
    assert.deepEqual(merge(a, b), merge(b, a));
    assert.deepEqual(merge(merge(a, b), c), merge(a, merge(b, c)));
    assert.deepEqual(merge(a, a), a);
    const expected = sim.nodes.reduce((sum, n) => sum + visible(n.state).counter, 0);
    assert.equal(visible(merge(merge(a, b), c)).counter, expected);
    for (const action of syncActions(sim)) sim = step(sim, action);
    assert.ok(converged(sim));
  }
});
test('visible equality is weaker than full-state convergence', () => {
  const sim = replay([add('A', 'tea'), remove('A', 'tea')]);
  assert.deepEqual(visible(sim.nodes[0].state).values, visible(sim.nodes[1].state).values);
  assert.equal(converged(sim), false);
});
test('dropping a message does not merge it and logs replay deterministically', () => {
  const actions = [add('A', 'tea'), { type: 'send', from: 'A', to: 'B' }, { type: 'drop', id: 1 }];
  const a = replay(actions),
    b = replay(JSON.parse(JSON.stringify(actions)));
  assert.deepEqual(a, b);
  assert.deepEqual(visible(a.nodes[1].state).values, []);
  assert.equal(a.messages.length, 0);
});
test('validation rejects conflicting tags, invalid tombstones, malformed actions and limits', () => {
  const a = replay([add('A', 'tea')]).nodes[0].state,
    b = { ...a, adds: [{ tag: 'A:1', value: 'coffee' }] };
  assert.throws(() => merge(a, b));
  assert.throws(() => validateState({ ...a, removed: ['B:1'] }));
  assert.throws(() => step(initial(), inc('A', 0)));
  assert.throws(() => step(initial(), inc('D', 1)));
  assert.throws(() => step(initial(), { type: 'send', from: 'A', to: 'A' }));
  assert.throws(() => step(initial(), { type: 'deliver', id: 1, keep: true }));
  assert.throws(() => replay(Array.from({ length: 201 }, () => inc('A', 1))));
  let sim = initial();
  for (let i = 0; i < 40; i++) sim = step(sim, { type: 'send', from: 'A', to: 'B' });
  assert.throws(() => step(sim, { type: 'send', from: 'B', to: 'C' }));
});
