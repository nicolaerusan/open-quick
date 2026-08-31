const storageKey = 'openquick-signal-room-v1';

const defaults = {
  filter: 'all',
  clarity: 82,
  evidence: 68,
  reversibility: 72,
  decision: 'Ship the five-minute prototype to ten teams and measure whether they share it unprompted.',
  signals: [
    { id: 1, kind: 'customer', text: 'Teams share live prototypes twice as often as screenshots.', votes: 18, voted: false },
    { id: 2, kind: 'product', text: 'The first successful publish still requires a human to hand over a token.', votes: 15, voted: false },
    { id: 3, kind: 'market', text: 'Agent-native tools win when the result is inspectable in under one minute.', votes: 11, voted: false },
    { id: 4, kind: 'customer', text: 'People understand the product after seeing one useful live example.', votes: 9, voted: false },
  ],
};

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    return { ...defaults, ...stored, signals: Array.isArray(stored?.signals) ? stored.signals : defaults.signals };
  } catch {
    return structuredClone(defaults);
  }
}

let state = loadState();
const list = document.querySelector('#signal-list');
const count = document.querySelector('#signal-count');
const form = document.querySelector('#signal-form');
const input = document.querySelector('#signal-input');
const kind = document.querySelector('#signal-kind');
const decision = document.querySelector('#decision');
const saved = document.querySelector('#saved-state');
const characterCount = document.querySelector('#character-count');

function persist(message = 'SAVED LOCALLY') {
  localStorage.setItem(storageKey, JSON.stringify(state));
  saved.textContent = message;
  saved.animate([{ opacity: .25 }, { opacity: 1 }], { duration: 280 });
}

function signalTemplate(signal, index) {
  return `<article class="signal-card">
    <div class="signal-rank">${String(index + 1).padStart(2, '0')}</div>
    <div class="signal-copy">
      <p>${escapeHtml(signal.text)}</p>
      <div class="signal-meta"><i class="kind-dot ${signal.kind}"></i>${signal.kind} signal</div>
    </div>
    <button class="vote ${signal.voted ? 'voted' : ''}" data-vote="${signal.id}" aria-label="Vote for: ${escapeHtml(signal.text)}">
      <b>↑</b><span>${signal.votes}</span>
    </button>
  </article>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function renderSignals() {
  const filtered = state.signals
    .filter((signal) => state.filter === 'all' || signal.kind === state.filter)
    .sort((a, b) => b.votes - a.votes);
  count.textContent = `${state.signals.length} observation${state.signals.length === 1 ? '' : 's'}`;
  list.innerHTML = filtered.length
    ? filtered.map(signalTemplate).join('')
    : '<div class="empty">NO SIGNALS IN THIS CHANNEL — ADD THE FIRST ONE.</div>';
}

function renderScore() {
  const score = Math.round(state.clarity * .35 + state.evidence * .4 + state.reversibility * .25);
  document.querySelector('#score').textContent = score;
  for (const key of ['clarity', 'evidence', 'reversibility']) {
    const slider = document.querySelector(`#${key}`);
    slider.value = state[key];
    document.querySelector(`#${key}-output`).textContent = state[key];
  }
}

document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
    renderSignals();
    persist('FILTER SAVED');
  });
});

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-vote]');
  if (!button) return;
  const signal = state.signals.find((item) => item.id === Number(button.dataset.vote));
  if (!signal) return;
  signal.voted = !signal.voted;
  signal.votes += signal.voted ? 1 : -1;
  renderSignals();
  persist(signal.voted ? 'VOTE SAVED' : 'VOTE REMOVED');
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  state.signals.push({ id: Date.now(), kind: kind.value, text, votes: 1, voted: true });
  input.value = '';
  state.filter = 'all';
  document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all'));
  renderSignals();
  persist('NEW SIGNAL SAVED');
});

for (const key of ['clarity', 'evidence', 'reversibility']) {
  document.querySelector(`#${key}`).addEventListener('input', (event) => {
    state[key] = Number(event.target.value);
    renderScore();
    persist('SCORE SAVED');
  });
}

decision.addEventListener('input', () => {
  state.decision = decision.value;
  characterCount.textContent = `${decision.value.length} / 240`;
  persist('NOTE SAVED');
});

decision.value = state.decision;
characterCount.textContent = `${decision.value.length} / 240`;
document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === state.filter));
renderSignals();
renderScore();
