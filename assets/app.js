// rosa camina — read-only price comparison. Everything runs in the browser:
// the data is a static JSON file, the search index is built on load, and the
// payload is cached in IndexedDB so repeat visits start instantly.
//
// There is no product picker: the result list *is* the search. Typing filters
// every price matching the text, so two stores' names for the same bottle sit
// next to each other instead of being collapsed into one "product".

// One copy of this script serves every country. The page that loads it
// (uy/index.html, ar/index.html) says which one it is on <html>, and relative
// URLs resolve against that page, so 'data/…' is the country's own folder.
const { country, locale, currency } = document.documentElement.dataset;

const MANIFEST = 'data/manifest.json';
const DB_NAME = `rosa-camina-${country}`;   // same origin, so one cache per country
const STORE = 'cache';
const KEY = 'payload';

const MIN_QUERY = 2;      // below this the list stays empty
const DEBOUNCE_MS = 150;  // redraw at most this often while typing

const $q = document.getElementById('q');
const $clear = document.getElementById('clear');
const $results = document.getElementById('results');
const $status = document.getElementById('status');
const $footer = document.getElementById('footer');

const money = new Intl.NumberFormat(locale, { style: 'currency', currency });

let index = [];        // [{ item, terms }]
let ready = false;     // data loaded at least once
let timer = 0;

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
    terms: terms([item.n, item.s, item.g].filter(Boolean).join(' '))
  }));
}

function search(wanted) {
  return index
    .filter(entry => wanted.every(w => entry.terms.some(t => t.startsWith(w))))
    .map(entry => entry.item)
    .sort(byUnitPrice);
}

// The data file is ordered by store and item id, which is what keeps its
// diffs small; it says nothing about what a reader wants to see first. So
// the page decides: cheapest per kilo or litre, and rows whose size the
// store never published last, since they cannot be compared.
function byUnitPrice(a, b) {
  const aUnknown = a.pp === undefined;
  const bUnknown = b.pp === undefined;
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
  if (!aUnknown && a.pp !== b.pp) return a.pp - b.pp;
  return a.n.localeCompare(b.n, 'es');
}

// ----------------------------------------------------------------- render

function nameWithHits(name, wanted) {
  const el = document.createElement('span');
  // Mark the whole word when it starts with one of the typed terms, so the
  // reason a row matched is visible without a separate suggestion list.
  for (const word of name.split(/(\s+)/)) {
    const plain = terms(word)[0] || '';
    const hit = plain && wanted.some(w => plain.startsWith(w));
    const node = document.createElement(hit ? 'mark' : 'span');
    node.textContent = word;
    el.append(node);
  }
  return el;
}

function card(item, wanted) {
  const li = document.createElement('li');
  li.className = 'card';

  const size = item.q === undefined ? null : `${item.q} ${item.u}`;

  li.innerHTML = `
    <div class="name"></div>
    <div class="row">
      <span class="tag store"></span>
      ${size ? '<span class="tag size"></span>' : ''}
      <span class="price"></span>
      ${item.pp !== undefined ? '<span class="unit"></span>' : ''}
    </div>`;

  li.querySelector('.name').append(nameWithHits(item.n, wanted));
  li.querySelector('.store').textContent = item.s;
  if (size) li.querySelector('.size').textContent = size;
  li.querySelector('.price').textContent = money.format(item.p);
  if (item.pp !== undefined) {
    li.querySelector('.unit').textContent = `${money.format(item.pp)} por ${item.pu}`;
  }
  return li;
}

function render(items, wanted) {
  // No row is singled out: the page states prices and the reader compares
  // them. Deciding which listings are the same product is deferred.
  $results.replaceChildren(...items.map(item => card(item, wanted)));

  const n = items.length;
  $status.textContent = n ? `${n} ${n === 1 ? 'precio' : 'precios'}` : 'Sin resultados.';
}

// The landing state, and anything shorter than MIN_QUERY: no rows, just a hint.
function idle() {
  $results.replaceChildren();
  $status.textContent = ready
    ? `Escribí al menos ${MIN_QUERY} letras para ver precios.`
    : 'Cargando precios…';
}

function update() {
  const wanted = terms($q.value);
  const long = wanted.filter(w => w.length >= MIN_QUERY);
  if (!long.length) {
    idle();
    return;
  }
  render(search(wanted), wanted);
}

// ------------------------------------------------------------------ events

$q.addEventListener('input', () => {
  $clear.hidden = !$q.value;
  clearTimeout(timer);
  timer = setTimeout(update, DEBOUNCE_MS);
});

$q.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $q.value = '';
    $clear.hidden = true;
    update();
  } else if (event.key === 'Enter') {
    event.preventDefault();   // nothing to submit; fold the keyboard away
    clearTimeout(timer);
    update();
    $q.blur();
  }
});

$clear.addEventListener('click', () => {
  $q.value = '';
  $clear.hidden = true;
  clearTimeout(timer);
  update();
  $q.focus();
});

// -------------------------------------------------------------------- boot
// Show the cached data at once, then check the manifest and swap in a newer
// version if the build has moved on (stale-while-revalidate).

function apply(payload) {
  buildIndex(payload.items);
  ready = true;
  update();
  $footer.textContent =
    `${payload.items.length} precios · ${payload.stores.join(' · ')} · datos del ${payload.generated}`;
}

async function boot() {
  // Before the site had countries there was one cache under this name;
  // nothing reads it any more, so give the space back.
  try { indexedDB.deleteDatabase('rosa-camina'); } catch { /* no storage */ }

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
