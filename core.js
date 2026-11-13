export const IDS = ['A', 'B', 'C'];
const fresh = () => ({ adds: [], removed: [], positive: [0, 0, 0], negative: [0, 0, 0] });
const key = (a, b) => [a, b].sort().join('');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fields(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...names].sort().join(',')
  )
    throw Error('Unexpected object fields.');
}
function replica(id) {
  if (!IDS.includes(id)) throw Error('Replica must be A, B, or C.');
  return IDS.indexOf(id);
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 40 || /[\x00-\x1f]/.test(value))
    throw Error('Labels need 1–40 printable characters.');
  return value.trim();
}
export function validateState(value) {
  fields(value, ['adds', 'removed', 'positive', 'negative']);
  if (
    !Array.isArray(value.adds) ||
    value.adds.length > 600 ||
    !Array.isArray(value.removed) ||
    value.removed.length > 600
  )
    throw Error('Invalid set state.');
  const tags = new Set();
  for (const add of value.adds) {
    fields(add, ['tag', 'value']);
    if (
      typeof add.tag !== 'string' ||
      !/^([ABC]):([1-9][0-9]{0,5})$/.test(add.tag) ||
      tags.has(add.tag) ||
      label(add.value) !== add.value
    )
      throw Error('Invalid or duplicate add tag.');
    tags.add(add.tag);
  }
  if (
    new Set(value.removed).size !== value.removed.length ||
    value.removed.some((tag) => !tags.has(tag))
  )
    throw Error('Tombstones must reference distinct observed add tags.');
  for (const list of [value.positive, value.negative])
    if (
      !Array.isArray(list) ||
      list.length !== 3 ||
      list.some((n) => !Number.isInteger(n) || n < 0 || n > 1000000)
    )
      throw Error('Invalid counter components.');
  return {
    adds: [...value.adds].map((a) => ({ ...a })).sort((a, b) => a.tag.localeCompare(b.tag)),
    removed: [...value.removed].sort(),
    positive: [...value.positive],
    negative: [...value.negative],
  };
}
export function merge(left, right) {
  const a = validateState(left),
    b = validateState(right),
    adds = new Map(a.adds.map((x) => [x.tag, x.value]));
  for (const x of b.adds) {
    if (adds.has(x.tag) && adds.get(x.tag) !== x.value)
      throw Error('The same add tag carries conflicting values.');
    adds.set(x.tag, x.value);
  }
  return validateState({
    adds: [...adds].map(([tag, value]) => ({ tag, value })),
    removed: [...new Set([...a.removed, ...b.removed])],
    positive: a.positive.map((n, i) => Math.max(n, b.positive[i])),
    negative: a.negative.map((n, i) => Math.max(n, b.negative[i])),
  });
}
export function visible(state) {
  const s = validateState(state),
    removed = new Set(s.removed);
  return {
    values: [...new Set(s.adds.filter((a) => !removed.has(a.tag)).map((a) => a.value))].sort(),
    counter: s.positive.reduce((a, b) => a + b, 0) - s.negative.reduce((a, b) => a + b, 0),
    tags: s.adds.length,
    tombstones: s.removed.length,
  };
}
export function initial() {
  return {
    nodes: IDS.map((id) => ({ id, sequence: 0, state: fresh() })),
    messages: [],
    blocked: [],
    nextMessage: 1,
  };
}
export function step(input, action) {
  const sim = structuredClone(input);
  if (!action || typeof action !== 'object') throw Error('Invalid action.');
  if (['add', 'remove', 'increment'].includes(action.type)) {
    fields(
      action,
      action.type === 'increment' ? ['type', 'node', 'amount'] : ['type', 'node', 'value'],
    );
    const index = replica(action.node),
      node = sim.nodes[index];
    node.sequence++;
    if (node.sequence > 200) throw Error('Replica action limit reached.');
    if (action.type === 'increment') {
      if (!Number.isInteger(action.amount) || action.amount === 0 || Math.abs(action.amount) > 100)
        throw Error('Counter changes need a nonzero integer from −100 to 100.');
      const component = action.amount > 0 ? 'positive' : 'negative';
      node.state[component][index] += Math.abs(action.amount);
    } else {
      const value = label(action.value);
      if (action.type === 'add')
        node.state.adds.push({ tag: `${node.id}:${node.sequence}`, value });
      else
        node.state.removed = [
          ...new Set([
            ...node.state.removed,
            ...node.state.adds.filter((a) => a.value === value).map((a) => a.tag),
          ]),
        ];
    }
    node.state = validateState(node.state);
  } else if (action.type === 'send') {
    fields(action, ['type', 'from', 'to']);
    const from = replica(action.from);
    replica(action.to);
    if (action.from === action.to) throw Error('Send to a different replica.');
    if (sim.messages.length >= 40) throw Error('The queue holds at most 40 snapshots.');
    sim.messages.push({
      id: sim.nextMessage++,
      from: action.from,
      to: action.to,
      state: structuredClone(sim.nodes[from].state),
    });
  } else if (action.type === 'deliver' || action.type === 'drop') {
    fields(action, action.type === 'deliver' ? ['type', 'id', 'keep'] : ['type', 'id']);
    if (!Number.isInteger(action.id)) throw Error('Message ID must be an integer.');
    const message = sim.messages.find((m) => m.id === action.id);
    if (!message) throw Error('Message is no longer queued.');
    if (action.type === 'deliver') {
      if (typeof action.keep !== 'boolean') throw Error('Delivery keep flag must be boolean.');
      if (sim.blocked.includes(key(message.from, message.to)))
        throw Error('Delivery is blocked by the link partition.');
      const node = sim.nodes[replica(message.to)];
      node.state = merge(node.state, message.state);
    }
    if (action.type === 'drop' || !action.keep)
      sim.messages = sim.messages.filter((m) => m.id !== message.id);
  } else if (action.type === 'partition') {
    fields(action, ['type', 'a', 'b', 'blocked']);
    replica(action.a);
    replica(action.b);
    if (action.a === action.b || typeof action.blocked !== 'boolean')
      throw Error('Partition needs distinct replicas and a boolean.');
    const link = key(action.a, action.b);
    sim.blocked = sim.blocked.filter((x) => x !== link);
    if (action.blocked) sim.blocked.push(link);
    sim.blocked.sort();
  } else throw Error('Unknown action.');
  return sim;
}
export function replay(actions) {
  if (!Array.isArray(actions) || actions.length > 200)
    throw Error('Scenarios are limited to 200 actions.');
  let state = initial();
  for (const action of actions) state = step(state, action);
  return state;
}
export function converged(sim) {
  return sim.nodes.every((n) => same(n.state, sim.nodes[0].state));
}
export function syncActions(sim) {
  if (sim.blocked.length) throw Error('Heal all links before full synchronization.');
  const actions = [];
  let current = sim;
  for (const from of IDS)
    for (const to of IDS)
      if (from !== to) {
        const send = { type: 'send', from, to };
        current = step(current, send);
        actions.push(send);
        const deliver = { type: 'deliver', id: current.nextMessage - 1, keep: false };
        current = step(current, deliver);
        actions.push(deliver);
      }
  return actions;
}
export function fixture() {
  return [
    { type: 'add', node: 'A', value: 'apples' },
    { type: 'send', from: 'A', to: 'B' },
    { type: 'deliver', id: 1, keep: false },
    { type: 'remove', node: 'A', value: 'apples' },
    { type: 'add', node: 'B', value: 'apples' },
    { type: 'increment', node: 'A', amount: 3 },
    { type: 'increment', node: 'B', amount: -1 },
  ];
}
