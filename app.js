import { IDS, fixture, visible, converged, syncActions } from './core.js';
const $ = (id) => document.getElementById(id);
let actions = [],
  sim = null,
  cursor = 0,
  busy = false,
  worker = null,
  revision = 0;
const drafts = Object.fromEntries(
  IDS.map((id, i) => [id, { value: 'apples', amount: '1', to: IDS[(i + 1) % 3] }]),
);
const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
function status(text) {
  $('status').textContent = text;
}
function controls() {
  const past = cursor < actions.length;
  for (const n of document.querySelectorAll('button,input,select')) n.disabled = busy;
  for (const n of document.querySelectorAll(
    '.replica button,.replica input,.replica select,.network input,.message button',
  ))
    n.disabled = busy || past;
  $('sync').disabled = busy || past || !sim || !!sim.blocked.length;
  $('undo').disabled = busy || past || !actions.length;
  $('historical').hidden = !past;
  for (const n of document.querySelectorAll('[data-blocked="true"]')) n.disabled = true;
}
function run(candidate, position = candidate.length) {
  if (busy) return;
  const ticket = ++revision;
  busy = true;
  controls();
  status('Replaying deterministic replica actions…');
  const w = new Worker('worker.js', { type: 'module' });
  worker = w;
  w.onmessage = ({ data }) => {
    if (ticket !== revision) return;
    w.terminate();
    worker = null;
    busy = false;
    if (data.error) status(data.error);
    else {
      actions = candidate;
      cursor = position;
      sim = data.result;
      render();
      status(
        `After action ${cursor} of ${actions.length}. ${sim.messages.length} queued snapshot(s).`,
      );
    }
    controls();
  };
  w.onerror = () => {
    if (ticket === revision) {
      w.terminate();
      worker = null;
      busy = false;
      status('Scenario replay failed. Try loading the example.');
      controls();
    }
  };
  if (candidate.length > 200) {
    w.terminate();
    worker = null;
    busy = false;
    controls();
    status('Scenarios are limited to 200 actions. Save this one and start a new scenario.');
    return;
  }
  w.postMessage(candidate.slice(0, position));
}
function append(extra) {
  if (cursor < actions.length) {
    status('Return to the latest state before issuing an action.');
    return;
  }
  run([...actions, ...extra]);
}
function button(text, action, label) {
  const b = el('button', text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', action);
  return b;
}
function field(text, value, type, label) {
  const wrap = el('label', text),
    input = el('input');
  input.type = type;
  input.value = value;
  input.setAttribute('aria-label', label);
  wrap.append(input);
  return [wrap, input];
}
function describe(a) {
  if (a.type === 'add') return `${a.node} adds “${a.value}”.`;
  if (a.type === 'remove') return `${a.node} removes observed “${a.value}” tags.`;
  if (a.type === 'increment')
    return `${a.node} changes its counter by ${a.amount > 0 ? '+' : ''}${a.amount}.`;
  if (a.type === 'send') return `Capture snapshot ${a.from} → ${a.to}.`;
  if (a.type === 'deliver')
    return `Deliver message #${a.id}${a.keep ? ' and keep a duplicate' : ''}.`;
  if (a.type === 'drop') return `Drop message #${a.id}.`;
  return `${a.blocked ? 'Partition' : 'Heal'} ${a.a} ↔ ${a.b}.`;
}
function render() {
  const past = cursor < actions.length;
  $('agreement').textContent = converged(sim)
    ? 'All three internal states agree.'
    : 'Replicas have different internal states.';
  for (const pair of ['AB', 'AC', 'BC']) $(pair).checked = sim.blocked.includes(pair);
  $('replicas').replaceChildren();
  for (const node of sim.nodes) {
    const state = visible(node.state),
      card = el('article');
    card.className = 'replica';
    const header = el('header');
    header.append(
      el('strong', `REPLICA ${node.id}`),
      el('span', `local sequence ${node.sequence}`),
    );
    card.append(header);
    const set = el('div');
    set.className = 'set-values';
    for (const value of state.values) {
      const chip = el('span', value);
      chip.className = 'chip';
      set.append(chip);
    }
    if (!state.values.length) {
      const empty = el('span', 'No visible labels');
      empty.className = 'empty';
      set.append(empty);
    }
    card.append(set);
    const counter = el('p', state.counter);
    counter.className = 'counter';
    const caption = el('div', 'PN COUNTER');
    caption.className = 'counter-label';
    card.append(counter, caption);
    const form = el('form'),
      [wrap, input] = field('Set label', drafts[node.id].value, 'text', `${node.id} set label`);
    input.maxLength = 40;
    input.addEventListener('input', () => (drafts[node.id].value = input.value));
    form.append(wrap);
    const buttons = el('div');
    buttons.className = 'buttons';
    buttons.append(
      button(
        'Add tag',
        () => append([{ type: 'add', node: node.id, value: input.value }]),
        `${node.id} add tag`,
      ),
      button(
        'Remove observed',
        () => append([{ type: 'remove', node: node.id, value: input.value }]),
        `${node.id} remove observed`,
      ),
    );
    form.append(buttons);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      append([{ type: 'add', node: node.id, value: input.value }]);
    });
    card.append(form);
    const countForm = el('form'),
      [amountWrap, amount] = field(
        'Counter change / signed',
        drafts[node.id].amount,
        'number',
        `${node.id} counter change`,
      );
    amount.min = '-100';
    amount.max = '100';
    amount.step = '1';
    amount.addEventListener('input', () => (drafts[node.id].amount = amount.value));
    countForm.append(amountWrap);
    const apply = button(
      'Apply change',
      () => append([{ type: 'increment', node: node.id, amount: Number(amount.value) }]),
      `${node.id} apply counter`,
    );
    const cb = el('div');
    cb.className = 'buttons';
    cb.append(apply);
    countForm.append(cb);
    countForm.addEventListener('submit', (e) => {
      e.preventDefault();
      apply.click();
    });
    card.append(countForm);
    const send = el('div');
    send.className = 'send';
    const to = el('select');
    to.setAttribute('aria-label', `${node.id} snapshot destination`);
    for (const id of IDS.filter((id) => id !== node.id)) {
      const o = el('option', `To replica ${id}`);
      o.value = id;
      to.append(o);
    }
    to.value = drafts[node.id].to;
    to.addEventListener('change', () => (drafts[node.id].to = to.value));
    send.append(
      to,
      button(
        'Queue snapshot',
        () => append([{ type: 'send', from: node.id, to: to.value }]),
        `${node.id} queue snapshot`,
      ),
    );
    card.append(send);
    const details = el('details');
    details.append(
      el('summary', `${state.tags} add tags / ${state.tombstones} tombstones`),
      el('pre', JSON.stringify(node.state, null, 2)),
    );
    card.append(details);
    $('replicas').append(card);
  }
  $('queue-count').textContent = `${sim.messages.length} / 40 snapshots`;
  $('queue').replaceChildren();
  if (!sim.messages.length) {
    const empty = el('p', 'The network queue is empty. Queue a snapshot from any replica.');
    empty.className = 'empty';
    $('queue').append(empty);
  }
  for (const message of sim.messages) {
    const row = el('div');
    row.className = 'message';
    const state = visible(message.state),
      blocked = sim.blocked.includes([message.from, message.to].sort().join(''));
    row.append(
      el(
        'strong',
        `#${message.id} · ${message.from} → ${message.to}${blocked ? ' · partitioned' : ''}`,
      ),
      el(
        'p',
        `${state.values.join(', ') || 'No visible labels'} / counter ${state.counter} / ${state.tags} tags, ${state.tombstones} tombstones`,
      ),
    );
    const buttons = el('div');
    buttons.className = 'buttons';
    for (const keep of [false, true]) {
      const b = button(
        keep ? 'Deliver + keep copy' : 'Deliver',
        () => append([{ type: 'deliver', id: message.id, keep }]),
        `${keep ? 'Duplicate' : 'Deliver'} message ${message.id}`,
      );
      b.dataset.blocked = String(blocked);
      buttons.append(b);
    }
    buttons.append(
      button(
        'Drop',
        () => append([{ type: 'drop', id: message.id }]),
        `Drop message ${message.id}`,
      ),
    );
    row.append(buttons);
    $('queue').append(row);
  }
  $('cursor').max = actions.length;
  $('cursor').value = cursor;
  $('cursor-label').textContent = cursor;
  $('history-note').textContent =
    `Showing the last ${Math.min(40, cursor)} applied actions. Full scenario export contains all ${actions.length} actions.${past ? ' This view is historical.' : ''}`;
  $('actions').replaceChildren();
  $('actions').start = Math.max(1, cursor - 39);
  for (const action of actions.slice(Math.max(0, cursor - 40), cursor))
    $('actions').append(el('li', describe(action)));
  controls();
}
for (const pair of ['AB', 'AC', 'BC'])
  $(pair).addEventListener('change', () =>
    append([{ type: 'partition', a: pair[0], b: pair[1], blocked: $(pair).checked }]),
  );
$('sync').addEventListener('click', () => {
  try {
    append(syncActions(sim));
  } catch (e) {
    status(e.message);
  }
});
$('example').addEventListener('click', () => run(fixture()));
$('empty').addEventListener('click', () => run([]));
$('undo').addEventListener('click', () => {
  if (actions.length) run(actions.slice(0, -1));
});
$('cursor').addEventListener('input', () => run(actions, Number($('cursor').value)));
$('latest').addEventListener('click', () => run(actions));
function download(name, data) {
  const u = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    ),
    a = el('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
$('save').addEventListener('click', () => download('replica-scenario.json', { actions }));
$('report').addEventListener('click', () => {
  if (sim)
    download('replica-evidence.json', { position: cursor, converged: converged(sim), state: sim });
});
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  const ticket = ++revision;
  busy = true;
  controls();
  try {
    if (f.size > 100000) throw Error('Scenario files are limited to 100 KB.');
    const value = JSON.parse(await f.text());
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).join(',') !== 'actions' ||
      !Array.isArray(value.actions)
    )
      throw Error('JSON needs an actions array only.');
    if (ticket !== revision) return;
    busy = false;
    run(value.actions);
  } catch (e) {
    if (ticket === revision) {
      busy = false;
      controls();
      status(e.message);
    }
  } finally {
    $('file').value = '';
  }
});
run(fixture());
