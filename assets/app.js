// rosa camina — read-only price comparison. Everything runs in the browser:
// the data is a static JSON file, the search index is built on load, and the
// payload is cached in IndexedDB so repeat visits start instantly.
//
// There is no product picker: the result list *is* the search. Typing filters
// every price matching the text, so two stores' names for the same bottle sit
// next to each other instead of being collapsed into one "product".

// One copy of this script serves every page. The page that loads it says
// which one it is on <html>. A country page (uy/, ar/) reads its own folder:
// relative URLs resolve against the page, so 'data/…' is that country's.
// The world page (mundo/) names the countries it spans in data-countries,
// reads each one's folder ('../uy/data/…') and shows every price in dollars.
const { country, locale, currency, countries } = document.documentElement.dataset;
const WORLD = countries ? countries.split(' ') : null;

const MANIFEST = 'data/manifest.json';
const RATES = 'data/rates.json';
const BARCODES = 'data/barcodes.json';
const dbName = cc => `rosa-camina-${cc}`;   // same origin, so one cache per country
const STORE = 'cache';
const KEY = 'payload';

const MIN_QUERY = 2;      // below this the list stays empty
const DEBOUNCE_MS = 150;  // redraw at most this often while typing

const $q = document.getElementById('q');
const $clear = document.getElementById('clear');
const $results = document.getElementById('results');
const $status = document.getElementById('status');
const $footer = document.getElementById('footer');
const $scan = document.getElementById('scan');   // absent from a page older than this script

const money = new Intl.NumberFormat(locale, { style: 'currency', currency });

let index = [];        // [{ item, terms }]
let rows = new Map();  // rowKey -> item, what a barcode points at
let ready = false;     // data loaded at least once
let timer = 0;

// ---------------------------------------------------------------- storage
// Every access is guarded: private windows, blocked site data and Safari's
// eviction of script-writable storage all make these throw or come back empty.

function openDb(cc) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(cc), 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(cc = country) {
  try {
    const db = await openDb(cc);
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;   // a cache miss is normal, never fatal
  }
}

async function cacheSet(value, cc = country) {
  try {
    const db = await openDb(cc);
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

// Shown on a card of the world page, and searchable there: "argentina yerba".
const COUNTRY_NAMES = { uy: 'Uruguay', ar: 'Argentina' };

// A row's identity: the store's item id is unique within a store, and a
// store within a country. On a country page there is no country to name.
const rowKey = (cc, store, id) => `${cc || ''}|${store}|${id}`;

function buildIndex(items) {
  rows = new Map(items.map(item => [rowKey(item.c, item.s, item.i), item]));
  index = items.map(item => ({
    item,
    terms: terms([item.n, item.s, item.g, item.c && COUNTRY_NAMES[item.c]].filter(Boolean).join(' '))
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

// ---------------------------------------------------------------- barcodes
// A query that is nothing but the digits of a barcode is looked up instead of
// matched as text, so scanning and typing a code are the same search. The
// codes are a file beside the catalogue (data/barcodes.json) naming the rows
// each one stands for; it is read the first time a code is searched, never
// cached here, and a country that has none yet is simply a code nobody knows.

const CODE = /^\d{8,14}$/;

// A UPC-A is an EAN-13 with a leading zero, and scanners and stores disagree
// on whether to write it, so codes are compared without leading zeros.
const codeKey = code => code.replace(/^0+/, '');

let barcodes = null;   // Map: codeKey -> [rowKey], once loaded

async function loadBarcodes() {
  const sources = WORLD ? WORLD.map(cc => [cc, `../${cc}/${BARCODES}`]) : [['', BARCODES]];
  const loaded = await Promise.allSettled(sources.map(async ([cc, url]) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.status === 404) return [cc, {}];
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return [cc, await response.json()];
  }));
  const ok = loaded.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) throw new Error('no barcodes');
  const map = new Map();
  for (const [cc, codes] of ok) {
    for (const [code, refs] of Object.entries(codes)) {
      const key = codeKey(code);
      map.set(key, [...(map.get(key) || []), ...refs.map(ref => rowKey(cc, ref.s, ref.i))]);
    }
  }
  barcodes = map;
}

async function lookup(code) {
  if (!barcodes) {
    $results.replaceChildren();
    $status.textContent = 'Buscando el código…';
    try {
      await loadBarcodes();
    } catch {
      if ($q.value.trim() === code) $status.textContent = 'No se pudieron cargar los códigos.';
      return;
    }
    if ($q.value.trim() !== code) return;   // the reader moved on while it loaded
  }
  // A code may name a row the catalogue no longer has; those are skipped.
  const items = (barcodes.get(codeKey(code)) || []).map(key => rows.get(key)).filter(Boolean);
  if (items.length) render(items.sort(byUnitPrice), []);
  else {
    $results.replaceChildren();
    $status.textContent = `Todavía no hay precios para el código ${code}.`;
  }
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
      ${item.c ? '<span class="tag place"></span>' : ''}
      <span class="tag store"></span>
      ${size ? '<span class="tag size"></span>' : ''}
      <span class="price"></span>
      ${item.pp !== undefined ? '<span class="unit"></span>' : ''}
    </div>`;

  li.querySelector('.name').append(nameWithHits(item.n, wanted));
  if (item.c) li.querySelector('.place').textContent = COUNTRY_NAMES[item.c] || item.c;
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
  const code = $q.value.trim();
  if (ready && CODE.test(code)) {
    lookup(code);
    return;
  }
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

// -------------------------------------------------------------------- scan
// "Escanear código" reads a barcode with the phone's camera and searches for
// it. It needs the browser's own BarcodeDetector, which Chrome on Android has
// and most others do not; where it is missing the button stays hidden and a
// code can still be typed. Nothing leaves the phone: frames are read here.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const SCAN_EVERY_MS = 150;

let $scanner = null;   // the dialog, built on first use
let stream = null;     // the camera, while the dialog is open

function scannerDialog() {
  if ($scanner) return $scanner;
  $scanner = document.createElement('dialog');
  $scanner.className = 'scanner';
  $scanner.setAttribute('aria-label', 'Escanear código');
  $scanner.innerHTML = `
    <video playsinline muted></video>
    <p>Apuntá la cámara al código de barras.</p>
    <button type="button">Cancelar</button>`;
  $scanner.querySelector('button').addEventListener('click', () => $scanner.close());
  // Every way out (a code read, Cancelar, Escape, the back button) ends here.
  $scanner.addEventListener('close', () => {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    $scanner.querySelector('video').srcObject = null;
  });
  document.body.append($scanner);
  return $scanner;
}

async function scan() {
  const dialog = scannerDialog();
  const video = dialog.querySelector('video');
  let mine;
  try {
    mine = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    $status.textContent = 'No se pudo usar la cámara. Revisá el permiso del sitio.';
    return;
  }
  stream = mine;
  video.srcObject = mine;
  dialog.showModal();
  try { await video.play(); } catch { /* closed before the first frame */ }

  const supported = await BarcodeDetector.getSupportedFormats();
  const detector = new BarcodeDetector({ formats: FORMATS.filter(f => supported.includes(f)) });
  while (stream === mine) {
    let found = [];
    try { found = await detector.detect(video); } catch { /* no frame yet */ }
    const hit = found.find(b => CODE.test(b.rawValue));
    if (hit && stream === mine) {
      dialog.close();
      $q.value = hit.rawValue;
      $clear.hidden = false;
      clearTimeout(timer);
      update();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, SCAN_EVERY_MS));
  }
}

if ($scan && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
  $scan.hidden = false;
  $scan.addEventListener('click', scan);
  // A camera left on behind a hidden tab is a lit indicator and a drained battery.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && $scanner?.open) $scanner.close();
  });
}

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

// ------------------------------------------------------------------- world
// The world page has no data of its own. For each country it takes the
// catalogue (from that country's cache when the manifest says it is current,
// which also warms the cache for the country page) and the exchange rates,
// and converts every price to dollars once, here, on load: results are sorted
// by price per kilo or litre across countries, so every match would need
// converting on every keystroke otherwise. The conversion happens on the
// in-memory rows only. What is cached stays in local currency, because the
// country pages read the same cache.

async function loadCountry(cc) {
  const base = `../${cc}/`;
  const manifest = await (await fetch(base + MANIFEST, { cache: 'no-cache' })).json();
  let cached = await cacheGet(cc);
  if (!cached || cached.version !== manifest.version) {
    const payload = await (await fetch(base + manifest.url)).json();
    cached = { version: manifest.version, payload };
    await cacheSet(cached, cc);
  }
  const quotes = await (await fetch(base + RATES, { cache: 'no-cache' })).json();
  const known = quotes.rates.filter(r => r !== null);
  if (!known.length) throw new Error(`no exchange rate for ${cc}`);
  return { cc, payload: cached.payload, rate: known[known.length - 1], currency: quotes.currency };
}

function inDollars({ cc, payload, rate }) {
  return payload.items.map(item => {
    const row = { ...item, c: cc, p: item.p / rate };
    if (item.pp !== undefined) row.pp = item.pp / rate;
    return row;
  });
}

async function bootWorld() {
  const loaded = await Promise.allSettled(WORLD.map(loadCountry));
  const ok = loaded.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) {
    $status.textContent = 'No se pudieron cargar los precios.';
    return;
  }
  buildIndex(ok.flatMap(inDollars));
  ready = true;
  update();

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const parts = ok.map(c =>
    `${COUNTRY_NAMES[c.cc]}: ${c.payload.items.length} precios del ${c.payload.generated}, ` +
    `1 US$ = ${number.format(c.rate)} ${c.currency}`);
  const missing = WORLD.filter(cc => !ok.some(c => c.cc === cc)).map(cc => COUNTRY_NAMES[cc] || cc);
  if (missing.length) parts.push(`sin datos de ${missing.join(', ')}`);
  $footer.textContent = parts.join(' · ');
}

if (WORLD) bootWorld(); else boot();
