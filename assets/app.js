// rosa camina — a barcode-first price catalogue, read-only. Everything runs
// in the browser: the country's catalogue and the chosen city's prices are
// static JSON files, the search index is built on load, and both files are
// cached in IndexedDB so repeat visits start instantly.
//
// An item is a barcode. Searching lists one line per item; tapping it opens
// the item's page, which says the lowest price in the city and who has it,
// the highest, and the national average. The contract with the pipeline is
// rose-walks/website/docs/data-format.md; the spec is docs/specs/core.md.

// One copy of this script serves every country page. The page that loads it
// says which one it is on <html>: relative URLs resolve against the page, so
// 'data/…' is that country's folder.
const { country, locale, currency } = document.documentElement.dataset;

const MANIFEST = 'data/manifest.json';
const dbName = cc => `rosa-camina-${cc}`;   // same origin, so one cache per country
const STORE = 'cache';
const ITEMS_KEY = 'items';
const pricesKey = slug => `prices:${slug}`;
const CITY_KEY = `rosa-camina-city-${country}`;   // localStorage: the city chosen here
const COUNTRY_KEY = 'rosa-camina-country';        // localStorage: the last country visited

const MIN_QUERY = 3;      // no word this long yet: the list stays empty
const DEBOUNCE_MS = 150;  // redraw at most this often while typing

const $q = document.getElementById('q');
const $clear = document.getElementById('clear');
const $results = document.getElementById('results');
const $status = document.getElementById('status');
const $footer = document.getElementById('footer');
const $scan = document.getElementById('scan');
const $search = document.getElementById('search');     // the search view: status + results
const $item = document.getElementById('item');         // the item view
const $city = document.getElementById('city');         // the city button in the top bar
const $cities = document.getElementById('cities');     // the city picker view
const $cityQ = document.getElementById('city-q');
const $cityList = document.getElementById('city-list');

const money = new Intl.NumberFormat(locale, { style: 'currency', currency });

// -------------------------------------------------------------- analytics
// Umami counts the visits (its tag is on every page; website/docs/umami.md in
// rose-walks says what is collected and why); the events below are what the
// tag cannot see. The tracker may be slow, blocked or absent, so a call never
// throws and never waits: an event is handed over when the tracker is there
// and kept for it otherwise, until the page has finished loading. Every
// duration goes out twice, in milliseconds and as a bucket, because the
// dashboard counts distinct values and 1,340 is not 1,352.

const PENDING = [];
const PAGE = country;

function track(name, data) {
  PENDING.push([name, data]);
  flush();
}

function flush() {
  try {
    if (!window.umami) {
      if (PENDING.length > 20) PENDING.shift();   // blocked: keep only the latest
      return;
    }
    while (PENDING.length) window.umami.track(...PENDING.shift());
  } catch { /* analytics never breaks the page */ }
}
window.addEventListener('load', flush);

// "Actualizar el sitio" leaves this flag before reloading, so that the next
// country load can be told apart: it is the cost of that button.
const AFTER_REFRESH = (() => {
  try {
    const flag = sessionStorage.getItem('rosa-camina-refreshed') === '1';
    if (flag) sessionStorage.removeItem('rosa-camina-refreshed');
    return flag;
  } catch { return false; }
})();

function bucket(ms, edges) {
  const s = n => `${n}s`;
  const secs = ms / 1000;
  if (secs < edges[0]) return `<${s(edges[0])}`;
  for (let i = 1; i < edges.length; i++) {
    if (secs < edges[i]) return `${edges[i - 1]}-${s(edges[i])}`;
  }
  return `>${s(edges[edges.length - 1])}`;
}
const LOAD_EDGES = [0.5, 1, 2, 5];
const SEARCH_EDGES = [0.1, 0.25, 0.5, 1];
const ms = t => Math.round(t);

function visit() {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    page: PAGE,
    nav: nav ? nav.type : 'unknown',
    after_refresh: AFTER_REFRESH,
    connection: navigator.connection?.effectiveType || 'unknown',
    scanner: !!($scan && !$scan.hidden),
    storage: storageOk !== false,
  };
}

window.addEventListener('error', event =>
  track('error', { page: PAGE, message: String(event.message || event).slice(0, 200) }));
window.addEventListener('unhandledrejection', event =>
  track('error', { page: PAGE, message: String(event.reason?.message || event.reason).slice(0, 200) }));

// ------------------------------------------------------------------ state

let catalogue = null;    // the items payload
let index = [];          // [{ item, terms }]
let byCode = new Map();  // barcode -> item
let cities = [];         // from the manifest: [{ slug, name, url, count }]
let city = null;         // the chosen one, or null
let prices = new Map();  // barcode -> { d, s, h } in the chosen city
let ready = false;       // catalogue loaded at least once
let timer = 0;
let storageOk = null;
let indexMs = 0;

// ---------------------------------------------------------------- storage
// Every access is guarded: private windows, blocked site data and Safari's
// eviction of script-writable storage all make these throw or come back empty.

// One connection per access, closed after it, so that a later version bump
// finds no connection held open by another tab; an old tab holding one
// blocks the upgrade, and then the open is given up rather than waited for
// (a cache miss costs a download, a hang costs the page).
const OPEN_TIMEOUT_MS = 3000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(country), 2);
    const giveUp = setTimeout(() => reject(new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS);
    req.onupgradeneeded = () => {
      // Version 1 held one payload under one key; its shape is gone.
      if (req.result.objectStoreNames.contains(STORE)) req.result.deleteObjectStore(STORE);
      req.result.createObjectStore(STORE);
    };
    req.onblocked = () => { clearTimeout(giveUp); reject(new Error('IndexedDB upgrade blocked')); };
    req.onsuccess = () => {
      clearTimeout(giveUp);
      storageOk = true;
      req.result.onversionchange = () => req.result.close();   // let a newer script upgrade
      resolve(req.result);
    };
    req.onerror = () => { clearTimeout(giveUp); storageOk = false; reject(req.error); };
  });
}

async function cacheGet(key) {
  let db;
  try {
    db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    storageOk = false;
    return null;
  } finally {
    db?.close();
  }
}

async function cacheSet(key, value) {
  let db;
  try {
    db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);   // a commit that fails (quota) aborts without an error event
    });
  } catch {
    storageOk = false;
  } finally {
    db?.close();
  }
}

const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* no storage */ } };
const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };

// ------------------------------------------------------------------ search
// Accent- and case-insensitive prefix matching over the item name. At this
// size a linear scan is instant; when the catalogue grows to a hundred
// thousand items this is the one function to swap for a real inverted index.

function terms(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9%]+/g) || [];
}

function buildIndex(items) {
  const started = performance.now();
  byCode = new Map(items.map(item => [item.e, item]));
  index = items.map(item => ({ item, terms: terms(item.n) }));
  indexMs = performance.now() - started;
}

function search(wanted) {
  return index
    .filter(entry => wanted.every(w => entry.terms.some(t => t.startsWith(w))))
    .map(entry => entry.item)
    .sort(byUnitAverage);
}

// The catalogue is ordered by barcode, which is what keeps its diffs small;
// it says nothing about what a reader wants to see first. So the page
// decides: the cheapest per kilo or litre on the national average first,
// and items whose size no store published last, since they cannot compare.
function byUnitAverage(a, b) {
  const aUnknown = a.pa === undefined;
  const bUnknown = b.pa === undefined;
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
  if (!aUnknown && a.pa !== b.pa) return a.pa - b.pa;
  return a.n.localeCompare(b.n, 'es');
}

// ---------------------------------------------------------------- barcodes
// A query that is nothing but the digits of a barcode is looked up instead
// of matched as text: it opens the item, or says there is none.

const CODE = /^\d{7,14}$/;   // the catalogue drops leading zeros: an EAN-8 can be seven
// A UPC-A is an EAN-13 with a leading zero, and scanners and stores disagree
// on whether to write it. The catalogue drops leading zeros; so does this.
const codeKey = code => code.replace(/^0+/, '');

// ----------------------------------------------------------------- routes
// Three views on one page, told apart by the hash so that the back button
// and a shared link work: the search (no hash), an item (#/i/<barcode>)
// and the city picker (#/ciudad).

const ITEM_ROUTE = /^#\/i\/(\d{7,14})$/;
const CITY_ROUTE = '#/ciudad';

function show(view) {
  $search.hidden = view !== 'search';
  $item.hidden = view !== 'item';
  $cities.hidden = view !== 'cities';
}

function route() {
  const hash = location.hash;
  const item = hash.match(ITEM_ROUTE);
  if (item) {
    renderItem(codeKey(item[1]));
  } else if (hash === CITY_ROUTE) {
    renderCities();
  } else {
    show('search');
    if (ready) update();   // the list for what is in the box, redrawn for the city on screen
    $q.focus({ preventScroll: true });
  }
}
window.addEventListener('hashchange', () => { pushed = Math.max(0, pushed - 1); route(); });

// Views the page itself pushed onto the history, so that "back" can go back
// through them and never off the site: a visitor who arrived on an item
// link has nothing behind it, and leaves the view in place instead.
let pushed = 0;
let arrivedAt = '';   // an item link a first visit came in on, kept while the city is asked
function enter(hash) {
  if (location.hash === hash) return;   // already there: no entry, no hashchange
  pushed += 2;                          // hashchange takes one back
  location.hash = hash;
}
function leave() {
  if (pushed > 0) { history.back(); return; }   // the hashchange it fires takes the one back
  history.replaceState(null, '', location.pathname + location.search + arrivedAt);
  arrivedAt = '';
  route();
}

let opening = 'link';   // how the next item page was reached, for the analytics
function openItem(code, how) {
  opening = how;
  if (ITEM_ROUTE.test(location.hash)) {
    // From one item straight to another: the same entry, so that "back"
    // still returns to the list and never to a page the reader left.
    history.replaceState(null, '', location.pathname + location.search + `#/i/${code}`);
    route();
    return;
  }
  enter(`#/i/${code}`);
}

// Typing, clearing or escaping in the search box means the reader wants the
// list: an item page or the city picker in front of it is left first. Only
// the reader's own input does this, never a redraw.
function backToList() {
  arrivedAt = '';   // the reader typed: the list, not the item a link brought them to
  if (ITEM_ROUTE.test(location.hash) || location.hash === CITY_ROUTE) leave();
}

// ----------------------------------------------------------------- render

function nameWithHits(name, wanted) {
  const el = document.createElement('span');
  // Mark the whole word when it starts with one of the typed terms, so the
  // reason a line matched is visible.
  for (const word of name.split(/(\s+)/)) {
    const plain = terms(word)[0] || '';
    const hit = plain && wanted.some(w => plain.startsWith(w));
    const node = document.createElement(hit ? 'mark' : 'span');
    node.textContent = word;
    el.append(node);
  }
  return el;
}

const sizeOf = item => item.q === undefined ? null : `${item.q} ${item.u}`;

// One line per item: the name, and flush right the price that matters most,
// the city's lowest when there is one and the national average otherwise,
// labelled so the two are never confused. Tapping opens the item.
function card(item, wanted) {
  const li = document.createElement('li');
  li.className = 'card';
  const local = prices.get(item.e);
  const size = sizeOf(item);
  li.innerHTML = `
    <a class="name" href="#/i/${item.e}"></a>
    <span class="price"><b></b><small></small></span>
    <div class="row">
      ${size ? '<span class="tag size"></span>' : ''}
      ${item.pa !== undefined ? '<span class="unit"></span>' : ''}
    </div>`;
  const link = li.querySelector('.name');
  link.append(nameWithHits(item.n, wanted));
  link.addEventListener('click', event => { event.preventDefault(); openItem(item.e, 'search'); });
  li.querySelector('.price b').textContent = money.format(local ? local.d : item.a);
  li.querySelector('.price small').textContent = local ? 'desde' : 'promedio país';
  if (size) li.querySelector('.size').textContent = size;
  if (item.pa !== undefined) {
    li.querySelector('.unit').textContent = `${money.format(item.pa)} por ${item.pu}, promedio`;
  }
  return li;
}

// A word as short as "car" matches thousands of items, and drawing them all
// freezes a phone. So the list is drawn a page at a time, cheapest first,
// and "Mostrar más" adds the next page.
const PAGE_SIZE = 100;
let shown = { items: [], wanted: [], count: 0 };

const $more = document.createElement('button');
$more.type = 'button';
$more.className = 'more';
$more.hidden = true;
$more.addEventListener('click', () => drawMore());
$results.after($more);

function drawMore() {
  const { items, wanted, count } = shown;
  const next = items.slice(count, count + PAGE_SIZE).map(item => card(item, wanted));
  $results.append(...next);
  shown.count = count + next.length;
  const left = items.length - shown.count;
  if (left <= 0 && document.activeElement === $more && next.length) {
    next[0].tabIndex = -1;
    next[0].focus();
  }
  $more.hidden = left <= 0;
  $more.textContent = `Mostrar ${Math.min(left, PAGE_SIZE)} más (quedan ${left})`;
}

function hideRows() {
  $results.replaceChildren();
  $more.hidden = true;
}

function render(items, wanted) {
  shown = { items, wanted, count: 0 };
  $results.replaceChildren();
  drawMore();
  const n = items.length;
  $status.textContent = n ? `${n} ${n === 1 ? 'producto' : 'productos'}` : 'Sin resultados.';
}

function idle() {
  hideRows();
  $status.textContent = ready
    ? `Escribí al menos ${MIN_QUERY} letras para buscar un producto.`
    : 'Cargando el catálogo…';
}

// The item page: the name and size, the city's prices, the national
// average. "Desde" names every store tied at the lowest price; "Hasta"
// names nobody and is shown only when it differs from "Desde", since a
// single price is not a range.
function renderItem(code) {
  const item = byCode.get(code);
  show('item');
  if (!item) {
    $item.innerHTML = `
      <a class="back" href="#/">‹ Buscar</a>
      <p class="status">${ready ? `No hay ningún producto con el código ${code}.` : 'Cargando el catálogo…'}</p>`;
    return;
  }
  const local = prices.get(code);
  const size = sizeOf(item);
  const where = city ? city.name : 'tu ciudad';
  const stores = local ? local.s.join(' · ') : '';
  $item.innerHTML = `
    <a class="back" href="#/">‹ Buscar</a>
    <h2 class="item-name"></h2>
    ${size ? '<p class="item-size"></p>' : ''}
    <section class="prices">
      <h3>Precios en <span class="where"></span></h3>
      ${local ? `
      <dl>
        <div class="from"><dt>Desde</dt><dd><b class="amount"></b> <span class="stores"></span></dd></div>
        ${local.h !== local.d ? '<div class="to"><dt>Hasta</dt><dd><b class="amount"></b></dd></div>' : ''}
      </dl>` : `
      <p class="none">Todavía no hay precios de ${where} para este producto.</p>`}
      <h3>Promedio en todo el país</h3>
      <p class="average"><b class="amount"></b> ${item.pa !== undefined ? '<span class="unit"></span>' : ''}</p>
    </section>
    <p class="code">Código de barras <span></span></p>`;
  $item.querySelector('.item-name').textContent = item.n;
  if (size) $item.querySelector('.item-size').textContent = size;
  $item.querySelector('.where').textContent = where;
  if (local) {
    $item.querySelector('.from .amount').textContent = money.format(local.d);
    $item.querySelector('.stores').textContent = stores;
    const to = $item.querySelector('.to .amount');
    if (to) to.textContent = money.format(local.h);
  }
  $item.querySelector('.average .amount').textContent = money.format(item.a);
  if (item.pa !== undefined) {
    $item.querySelector('.average .unit').textContent = `${money.format(item.pa)} por ${item.pu}`;
  }
  $item.querySelector('.code span').textContent = item.e;
  $item.querySelector('.back').addEventListener('click', event => {
    event.preventDefault();
    leave();
  });
  // A redraw of the same item (a city change, a newer build) is not a
  // visit: it neither scrolls nor counts.
  if (shownCode !== code) {
    shownCode = code;
    window.scrollTo(0, 0);
    track('item', { page: PAGE, city: city?.slug || 'none', how: opening, local: !!local });
  }
  opening = 'link';
}
let shownCode = null;

// ------------------------------------------------------------------ cities
// A country page opens with a city picker unless the city is remembered.
// Only cities the manifest names appear; typing narrows them.

function renderCities() {
  show('cities');
  const wanted = terms($cityQ.value);
  const matching = cities.filter(c => !wanted.length || wanted.every(w => terms(c.name).some(t => t.startsWith(w))));
  $cityList.replaceChildren(...matching.map(c => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'city-choice';
    button.innerHTML = '<span class="name"></span><span class="hint"></span>';
    button.querySelector('.name').textContent = c.name;
    button.querySelector('.hint').textContent = `${c.count} productos con precio local`;
    if (city && city.slug === c.slug) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => chooseCity(c, 'chosen'));
    li.append(button);
    return li;
  }));
  if (!matching.length) {
    const li = document.createElement('li');
    li.className = 'status';
    li.textContent = 'Ninguna ciudad se llama así. Por ahora tenemos precios de: ' + cities.map(c => c.name).join(', ') + '.';
    $cityList.append(li);
  }
  $cityQ.focus({ preventScroll: true });
}
$cityQ?.addEventListener('input', renderCities);

async function chooseCity(chosen, how) {
  city = chosen;
  prices = new Map();   // never the previous city's prices under this one's name
  remember(CITY_KEY, chosen.slug);
  $city.textContent = chosen.name;
  $city.hidden = false;
  track('city', { page: PAGE, city: chosen.slug, how });   // remembered, only or chosen
  const loaded = await loadPrices(chosen);
  if (city?.slug !== chosen.slug) return;   // another city was chosen while this one loaded
  prices = loaded;
  if (location.hash === CITY_ROUTE) leave();
  else route();
  // The list is redrawn with the city's prices; an item page was redrawn
  // by route() and stays where it is.
  if (!ITEM_ROUTE.test(location.hash)) update();
  footer();
  return true;   // routed
}

$city?.addEventListener('click', () => { $cityQ.value = ''; enter(CITY_ROUTE); });

// ---------------------------------------------------------------- analytics of a search

const SETTLE_MS = 1500;
let typedAt = 0;
let burst = null;
let settle = 0;
let lastSent = '';

function noteSearch(query, kind, words, results, redraw) {
  const latency = typedAt ? performance.now() - typedAt : redraw;
  if (!burst || burst.query !== query) burst = { query, kind, words, redraws: 0, slowest: 0 };
  burst.results = results;
  burst.latency = latency;
  burst.redraws += 1;
  burst.slowest = Math.max(burst.slowest, redraw);
  clearTimeout(settle);
  settle = setTimeout(sendSearch, SETTLE_MS);
}

function sendSearch() {
  clearTimeout(settle);
  if (!burst || burst.query === lastSent) return;
  lastSent = burst.query;
  const hits = burst.results === 0 ? '0' : burst.results <= 10 ? '1-10'
    : burst.results <= 50 ? '11-50' : burst.results <= 200 ? '51-200' : '>200';
  track('search', {
    page: PAGE,
    city: city?.slug || 'none',
    kind: burst.kind,
    query: burst.query.slice(0, 100),
    words: burst.words,
    results: burst.results,
    hits,
    latency_ms: ms(burst.latency),
    latency: bucket(burst.latency, SEARCH_EDGES),
    redraw_ms: ms(burst.slowest),
    redraws: burst.redraws,
  });
}

document.addEventListener('visibilitychange', () => { if (document.hidden) sendSearch(); });

// Typing redraws the list and never navigates: a code that is being typed
// digit by digit would open the wrong item half way. A known code is listed
// as the one result it is; Enter, or a scan, opens it.
function update() {
  const started = performance.now();
  const code = $q.value.trim();
  if (ready && CODE.test(code)) {
    const item = byCode.get(codeKey(code));
    noteSearch(code, 'barcode', 1, item ? 1 : 0, performance.now() - started);
    if (item) render([item], []);
    else {
      hideRows();
      $status.textContent = `No hay ningún producto con el código ${code}.`;
    }
    return;
  }
  const wanted = terms($q.value);
  const long = wanted.filter(w => w.length >= MIN_QUERY);
  if (!long.length) {
    sendSearch();
    idle();
    return;
  }
  const items = search(wanted);
  render(items, wanted);
  noteSearch(wanted.join(' '), 'text', wanted.length, items.length, performance.now() - started);
}

// ------------------------------------------------------------------ events

$q.addEventListener('input', () => {
  typedAt = performance.now();
  $clear.hidden = !$q.value;
  backToList();
  clearTimeout(timer);
  timer = setTimeout(update, DEBOUNCE_MS);
});

$q.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $q.value = '';
    $clear.hidden = true;
    backToList();
    update();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(timer);
    const code = $q.value.trim();
    if (ready && CODE.test(code) && byCode.has(codeKey(code))) {
      noteSearch(code, 'barcode', 1, 1, 0);
      sendSearch();
      $q.blur();
      openItem(codeKey(code), 'barcode');   // from the list or from another item alike
      return;
    }
    backToList();
    update();
    sendSearch();
    $q.blur();
  }
});

$clear.addEventListener('click', () => {
  $q.value = '';
  $clear.hidden = true;
  backToList();
  clearTimeout(timer);
  update();
  $q.focus();
});

// -------------------------------------------------------------------- scan
// "Escanear código" reads a barcode with the phone's camera and opens the
// item. It needs the browser's own BarcodeDetector, which Chrome on Android
// has and most others do not; where it is missing the button stays hidden
// and a code can still be typed. Nothing leaves the phone: frames are read
// here.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const SCAN_EVERY_MS = 150;

let $scanner = null;
let stream = null;

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
  $scanner.addEventListener('close', () => {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    $scanner.querySelector('video').srcObject = null;
  });
  document.body.append($scanner);
  return $scanner;
}

// A phone has several rear cameras and "the rear one" may be the ultra-wide,
// whose focus is fixed: a product held close is a blur. So the camera wanted
// is one that can refocus by itself; the first answer is kept when it can,
// otherwise the other rear cameras are tried.
const SHARP = { width: { ideal: 1920 }, height: { ideal: 1080 } };
const canRefocus = media =>
  (media.getVideoTracks()[0].getCapabilities?.().focusMode || []).includes('continuous');
const stop = media => media.getTracks().forEach(track => track.stop());

async function openCamera() {
  const first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', ...SHARP } });
  if (canRefocus(first)) return first;
  const used = first.getVideoTracks()[0].getSettings().deviceId;
  const others = (await navigator.mediaDevices.enumerateDevices())
    .filter(d => d.kind === 'videoinput' && d.deviceId !== used && /back|rear|environment|trasera/i.test(d.label));
  if (!others.length) return first;
  stop(first);
  for (const { deviceId } of others) {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, ...SHARP } });
      if (canRefocus(media)) return media;
      stop(media);
    } catch { /* that one would not open; try the next */ }
  }
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', ...SHARP } });
}

async function tune(media) {
  const track = media.getVideoTracks()[0];
  const can = track.getCapabilities?.() || {};
  const wanted = {};
  if ((can.focusMode || []).includes('continuous')) wanted.focusMode = 'continuous';
  if (can.zoom) wanted.zoom = Math.min(Math.max(2, can.zoom.min), can.zoom.max);
  try { await track.applyConstraints({ advanced: [wanted] }); } catch { /* it scans untuned */ }
}

async function scan() {
  const pressed = performance.now();
  const dialog = scannerDialog();
  const video = dialog.querySelector('video');
  let mine;
  try {
    mine = await openCamera();
    await tune(mine);
  } catch {
    backToList();
    $status.textContent = 'No se pudo usar la cámara. Revisá el permiso del sitio.';
    track('scan', { page: PAGE, outcome: 'no_camera', ms: ms(performance.now() - pressed) });
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
      const took = performance.now() - pressed;
      const code = codeKey(hit.rawValue);
      const known = byCode.has(code);
      track('scan', {
        page: PAGE, outcome: 'found', format: hit.format, known,
        ms: ms(took), took: bucket(took, LOAD_EDGES),
      });
      if (known) openItem(code, 'scan');
      else {
        $q.value = hit.rawValue;
        $clear.hidden = false;
        backToList();
        update();   // "No hay ningún producto…", on the search view
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, SCAN_EVERY_MS));
  }
  track('scan', {
    page: PAGE, outcome: document.hidden ? 'tab_hidden' : 'cancelled',
    ms: ms(performance.now() - pressed),
  });
}

if ($scan && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
  $scan.hidden = false;
  $scan.addEventListener('click', scan);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && $scanner?.open) $scanner.close();
  });
}

// -------------------------------------------------------------------- boot
// Show the cached catalogue at once, then check the manifest and swap in a
// newer version if the build has moved on (stale-while-revalidate). The
// city's prices follow the same path, keyed by city.

async function download(url, what, reason, slug) {
  const started = performance.now();
  const response = await fetch(url);
  const text = await response.text();
  const fetched = performance.now();
  const payload = JSON.parse(text);
  const parsed = performance.now();
  const entry = performance.getEntriesByName(response.url).pop();
  const rows = Array.isArray(payload.items) ? payload.items.length : Object.keys(payload.items).length;
  track('catalog', {
    country, file: what, city: slug || 'none', reason,
    fetch_ms: ms(fetched - started),
    fetch: bucket(fetched - started, LOAD_EDGES),
    parse_ms: ms(parsed - fetched),
    bytes: entry ? entry.encodedBodySize : text.length,
    rows,
    connection: navigator.connection?.effectiveType || 'unknown',
  });
  return payload;
}

const ageDays = generated => Math.round((Date.now() - Date.parse(generated)) / 86400000);
const versionIn = url => (url.match(/[?&]v=([^&]+)/) || [])[1] || url;

function applyCatalogue(payload) {
  catalogue = payload;
  buildIndex(payload.items);
  ready = true;
}

function footer() {
  if (!catalogue) return;
  const parts = [`${catalogue.items.length} productos`];
  if (city) parts.push(`${prices.size} con precio en ${city.name}`);
  parts.push(`datos del ${catalogue.generated}`);
  $footer.textContent = parts.join(' · ');
}

// The city's prices, as a map by barcode: the cached copy when its version
// is the manifest's, else downloaded. Offline with nothing cached leaves
// the city priceless and the page says so on each item. The caller decides
// whether the map is still wanted: the city may have changed meanwhile.
async function loadPrices(chosen) {
  const key = pricesKey(chosen.slug);
  const version = versionIn(chosen.url);
  const cached = await cacheGet(key);
  if (cached && cached.version === version) return new Map(Object.entries(cached.payload.items));
  try {
    const payload = await download(chosen.url, 'prices', cached ? 'update' : 'cold', chosen.slug);
    cacheSet(key, { version, payload });   // in the background: the page never waits for storage
    return new Map(Object.entries(payload.items));
  } catch {
    return cached ? new Map(Object.entries(cached.payload.items)) : new Map();
  }
}

function reportLoad(source, check, usableAt) {
  const data = {
    ...visit(),
    source, check,
    city: city?.slug || 'none',
    ms: ms(usableAt),
    took: bucket(usableAt, LOAD_EDGES),
    index_ms: ms(indexMs),
  };
  if (catalogue) {
    data.rows = catalogue.items.length;
    data.age_days = ageDays(catalogue.generated);
  }
  track('load', data);
}

// The city: remembered, the only one, or asked for, once. A reader who
// types past the picker without choosing is not sent back to it by a
// build arriving later; the button in the top bar is there for that.
let asked = false;
async function settleCity() {
  const remembered = recall(CITY_KEY);
  const known = cities.find(c => c.slug === remembered);
  if (known) return chooseCity(known, 'remembered');
  if (cities.length === 1) return chooseCity(cities[0], 'only');
  $city.textContent = 'Elegir ciudad';
  $city.hidden = false;
  if (asked) return false;
  asked = true;
  if (ITEM_ROUTE.test(location.hash)) arrivedAt = location.hash;   // shown once the city is known
  history.replaceState(null, '', CITY_ROUTE);   // no entry: there is nothing to go back to yet
  renderCities();
  return true;
}

const MANIFEST_TIMEOUT_MS = 10000;

// The catalogue as it is now: the city settled, the route drawn, the list
// or the item on screen.
async function present() {
  // The city as the build on screen names it: its price file's version
  // lives in that entry, so the entry must be the current manifest's.
  const chosen = city && cities.find(c => c.slug === city.slug);
  if (chosen) {
    city = chosen;
    $city.textContent = chosen.name;
    const loaded = await loadPrices(chosen);
    if (city === chosen) prices = loaded;
    route();
  } else {
    city = null;   // none yet, or the build dropped it
    if (!await settleCity()) route();   // a choice routes by itself
  }
  if (!ITEM_ROUTE.test(location.hash)) update();
  footer();
}

async function boot() {
  if (!$search || !$item || !$cities) {
    // A page cached from before this script, run with this script: fetch
    // the page again past the cache, once, instead of failing on it.
    try {
      if (sessionStorage.getItem('rosa-camina-reloaded') !== '1') {
        sessionStorage.setItem('rosa-camina-reloaded', '1');
        location.reload();
        return;
      }
    } catch { /* no storage: nothing to do but stop */ }
    $status.textContent = 'La página quedó vieja. Volvé al inicio y tocá "Actualizar el sitio".';
    return;
  }
  remember(COUNTRY_KEY, country);
  try { indexedDB.deleteDatabase('rosa-camina'); } catch { /* the pre-country cache */ }
  show('search');
  idle();

  // The cached catalogue is shown at once, cities and all; the manifest is
  // asked afterwards and a newer build swapped in when it arrives.
  const cached = await cacheGet(ITEMS_KEY);
  let usableAt = 0;
  if (cached) {
    applyCatalogue(cached.payload);
    cities = cached.cities || [];
    await present();
    usableAt = performance.now();
  }

  let manifest;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(MANIFEST_TIMEOUT_MS) : undefined;
    const response = await fetch(MANIFEST, { cache: 'no-cache', signal });
    manifest = await response.json();
  } catch {
    if (!cached) $status.textContent = 'No se pudo cargar el catálogo.';
    reportLoad(cached ? 'cache' : 'none', 'offline', usableAt);
    return;
  }

  let check = 'current';
  const fresh = manifest.cities || [];
  if (cached && cached.version === manifest.version) {
    // The catalogue is current; a city's price file may still be newer.
    const shown = city && cities.find(c => c.slug === city.slug);
    const changed = JSON.stringify(cities) !== JSON.stringify(fresh);
    cities = fresh;
    if (changed) cacheSet(ITEMS_KEY, { ...cached, cities: fresh });
    if (shown ? (fresh.find(c => c.slug === shown.slug) || {}).url !== shown.url : changed) await present();
  } else {
    try {
      const payload = await download(manifest.url, 'items', cached ? 'update' : AFTER_REFRESH ? 'refresh' : 'cold');
      applyCatalogue(payload);
      cacheSet(ITEMS_KEY, { version: manifest.version, payload, cities: fresh });   // in the background
      cities = fresh;
      await present();   // the same city again, its prices as this build has them
      if (!cached) usableAt = performance.now();
      check = 'updated';
    } catch {
      check = 'failed';
      if (!cached) {
        $status.textContent = 'No se pudo cargar el catálogo.';
        reportLoad('none', check, usableAt);
        return;
      }
    }
  }
  reportLoad(cached ? 'cache' : 'network', check, usableAt);
}

boot();
