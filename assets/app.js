// rosa camina — read-only price comparison. Everything runs in the browser:
// the data is a static JSON file, the search index is built on load, and the
// payload is cached in IndexedDB so repeat visits start instantly.

const MANIFEST = 'data/manifest.json';
const DB_NAME = 'rosa-camina';
const STORE = 'cache';
const KEY = 'payload';

const $q = document.getElementById('q');
const $clear = document.getElementById('clear');
const $suggestions = document.getElementById('suggestions');
const $results = document.getElementById('results');
const $status = document.getElementById('status');
const $footer = document.getElementById('footer');

const money = new Intl.NumberFormat('es-UY', { style: 'currency', currency: 'UYU' });

let index = [];      // [{ item, terms }]
let cursor = -1;     // highlighted suggestion

// ---------------------------------------------------------------- storage
// Every access is guarded: private windows, blocked site data and Safari's
// eviction of script-writable storage all make these throw or come back empty.

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;   // a cache miss is normal, never fatal
  }
}

async function cacheSet(value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* running without storage is fine, it just costs a download next time */
  }
}

// ------------------------------------------------------------------ search
// Accent- and case-insensitive prefix matching over the product name, the
// store and the product group. At this size a linear scan is instant; when
// the catalogue grows to tens of thousands of rows this is the one function
// to swap for a real inverted index (MiniSearch, FlexSearch).

function terms(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9%]+/g) || [];
}

function buildIndex(items) {
  index = items.map(item => ({
    item,
    terms: terms(`${item.n} ${item.s} ${item.g}`)
  }));
}

function search(query) {
  const wanted = terms(query);
  if (!wanted.length) return index.map(entry => entry.item);
  return index
    .filter(entry => wanted.every(w => entry.terms.some(t => t.startsWith(w))))
    .map(entry => entry.item);
}

// ----------------------------------------------------------------- render

function sizeOf(item) {
  return item.q === undefined ? null : `${item.q} ${item.u}`;
}

function render(items) {
  // Cheapest per unit wins the badge, but only within its own product group
  // and only among rows whose size we could actually parse.
  const best = new Map();
  for (const item of items) {
    if (item.pp === undefined) continue;
    const current = best.get(item.g);
    if (!current || item.pp < current.pp) best.set(item.g, item);
  }

  $results.replaceChildren(...items.map(item => {
    const li = document.createElement('li');
    li.className = 'card';

    const size = sizeOf(item);
    const isBest = best.get(item.g) === item;

    li.innerHTML = `
      <div class="name"></div>
      <div class="row">
        <span class="tag store"></span>
        ${size ? '<span class="tag size"></span>' : ''}
        ${isBest ? '<span class="tag best">Mejor precio</span>' : ''}
        <span class="price"></span>
        ${item.pp !== undefined ? '<span class="unit"></span>' : ''}
      </div>`;

    li.querySelector('.name').textContent = item.n;
    li.querySelector('.store').textContent = item.s;
    if (size) li.querySelector('.size').textContent = size;
    li.querySelector('.price').textContent = money.format(item.p);
    if (item.pp !== undefined) {
      li.querySelector('.unit').textContent = `${money.format(item.pp)} por ${item.pu}`;
    }
    return li;
  }));

  const n = items.length;
  $status.textContent = n === 0
    ? 'Sin resultados.'
    : `${n} ${n === 1 ? 'precio' : 'precios'}`;
}

// ------------------------------------------------------------ autocomplete

function suggestionsFor(query, found) {
  if (!query.trim()) return [];
  const seen = new Set();
  const out = [];
  for (const item of found) {
    if (seen.has(item.n)) continue;
    seen.add(item.n);
    out.push(item);
    if (out.length === 6) break;
  }
  return out;
}

function highlight(name, query) {
  const wanted = terms(query);
  const el = document.createElement('span');
  el.className = 'hit';
  // Bold the whole word when it starts with one of the typed terms.
  for (const word of name.split(/(\s+)/)) {
    const plain = terms(word)[0] || '';
    const hit = wanted.some(w => plain.startsWith(w));
    const node = document.createElement(hit ? 'b' : 'span');
    node.textContent = word;
    el.append(node);
  }
  return el;
}

function showSuggestions(query, found) {
  const options = suggestionsFor(query, found);
  cursor = -1;

  if (!options.length) {
    closeSuggestions();
    return;
  }

  $suggestions.replaceChildren(...options.map((item, i) => {
    const li = document.createElement('li');
    li.id = `suggestion-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.name = item.n;
    li.append(highlight(item.n, query));

    const price = document.createElement('span');
    price.className = 'n';
    price.textContent = money.format(item.p);
    li.append(price);

    li.addEventListener('pointerdown', event => {
      event.preventDefault();   // keep focus so the keyboard does not flicker
      choose(item.n);
    });
    return li;
  }));

  $suggestions.hidden = false;
  $q.setAttribute('aria-expanded', 'true');
}

function closeSuggestions() {
  $suggestions.hidden = true;
  $suggestions.replaceChildren();
  $q.setAttribute('aria-expanded', 'false');
  $q.removeAttribute('aria-activedescendant');
  cursor = -1;
}

function moveCursor(delta) {
  const options = [...$suggestions.children];
  if (!options.length) return;
  if (cursor >= 0) options[cursor].setAttribute('aria-selected', 'false');
  cursor = (cursor + delta + options.length) % options.length;
  options[cursor].setAttribute('aria-selected', 'true');
  options[cursor].scrollIntoView({ block: 'nearest' });
  $q.setAttribute('aria-activedescendant', options[cursor].id);
}

function choose(name) {
  $q.value = name;
  $clear.hidden = false;
  closeSuggestions();
  render(search(name));
}

// ------------------------------------------------------------------ events

$q.addEventListener('input', () => {
  const found = search($q.value);
  $clear.hidden = !$q.value;
  render(found);
  showSuggestions($q.value, found);
});

$q.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveCursor(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (cursor >= 0) choose($suggestions.children[cursor].dataset.name);
    else closeSuggestions();
    $q.blur();
  } else if (event.key === 'Escape') {
    closeSuggestions();
  }
});

$q.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

$clear.addEventListener('click', () => {
  $q.value = '';
  $clear.hidden = true;
  closeSuggestions();
  render(search(''));
  $q.focus();
});

// -------------------------------------------------------------------- boot
// Show the cached data at once, then check the manifest and swap in a newer
// version if the build has moved on (stale-while-revalidate).

function apply(payload) {
  buildIndex(payload.items);
  render(search($q.value));
  $footer.textContent =
    `${payload.items.length} precios · ${payload.stores.join(' · ')} · datos del ${payload.generated}`;
}

async function boot() {
  const cached = await cacheGet();
  if (cached) apply(cached.payload);

  let manifest;
  try {
    manifest = await (await fetch(MANIFEST, { cache: 'no-cache' })).json();
  } catch {
    if (!cached) $status.textContent = 'No se pudieron cargar los precios.';
    return;   // offline with a warm cache: keep showing what we have
  }

  if (cached && cached.version === manifest.version) return;

  try {
    const payload = await (await fetch(manifest.url)).json();
    await cacheSet({ version: manifest.version, payload });
    apply(payload);
  } catch {
    if (!cached) $status.textContent = 'No se pudieron cargar los precios.';
  }
}

boot();
