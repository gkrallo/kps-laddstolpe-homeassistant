'use strict';

/* ============================================================================
 *
 *  KPs Laddstolpe — Home Assistant-tillägg
 *  Fas 2: backend i simuleringsläge
 *
 *  Hela tillägget ligger i den här enda filen. Det är ett medvetet val: du
 *  uppdaterar den genom att öppna filen på GitHub, markera allt, klistra in den
 *  nya versionen och spara. En fil att få rätt i stället för elva.
 *
 *  Inga npm-beroenden. Bara Nodes inbyggda moduler, ingen React, inget
 *  byggsteg — tillägget byggs på sekunder på en Raspberry Pi.
 *
 *  Innehåll, i den ordning delarna behöver varandra:
 *
 *    1  Loggen
 *    2  Lagring på disk         atomära och strypta skrivningar
 *    3  Inställningar           HA-inställningar vs driftinställningar
 *    4  Certifikat              med automatisk omladdning varje timme
 *    5  Elpriser                hämtning, cache, kvartsmatchning, prisformel
 *    6  Laddboxen               gemensamt gränssnitt + simulator
 *    7  Sessioner               kvartsvis kostnad, kvittonycklar
 *    8  Bakgrundsloopen         30 sekunder, kabelns löpnummer, auto-avslut
 *    9  Webbservern             egen liten router, hastighetsbegränsare
 *   10  Gästsidan               HTML
 *   11  Adminfliken             HTML
 *   12  Rutter och uppstart
 *
 * ==========================================================================*/


/* ========================================================================== */
/* 1  Loggen                                                                */
/* ========================================================================== */

const log = (function () {
const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 };
let threshold = LEVELS.info;

/** Senaste raderna hålls i minnet så adminfliken kan visa dem utan filläsning. */
const RING = [];
const RING_MAX = 400;

function setLevel(level) {
  threshold = LEVELS[level] || LEVELS.info;
}

function write(level, message) {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level.toUpperCase()}] ${message}`;

  RING.push({ ts: stamp, level, message });
  if (RING.length > RING_MAX) RING.shift();

  if ((LEVELS[level] || LEVELS.info) >= threshold) {
    console.log(line);
  }
}

return {
  setLevel,
  recent: (n = 120) => RING.slice(-n),
  debug: (m) => write('debug', m),
  info: (m) => write('info', m),
  warn: (m) => write('warning', m),
  error: (m) => write('error', m),
};
})();

/* ========================================================================== */
/* 2  Lagring på disk                                                       */
/* ========================================================================== */

const store = (function () {
/**
 * All skrivning till disk går genom den här filen.
 *
 * Två regler, båda med SD-kortet i åtanke:
 *
 *  1. ATOMÄRT. Vi skriver till en .tmp-fil och byter namn på den över originalet.
 *     Namnbyte är en odelbar operation i filsystemet, så ett strömavbrott mitt i
 *     lämnar antingen den gamla eller den nya filen — aldrig en halv, trasig fil.
 *
 *  2. STRYPT. En fil skrivs som mest var N:e sekund. Ändringar däremellan hålls i
 *     minnet och skrivs vid nästa tillfälle, eller genast om anroparen begär det
 *     (vid tillståndsbyten som start och stopp, där vi inte får förlora något).
 */

const fs = require('node:fs');
const path = require('node:path');
const DATA_DIR = process.env.KPS_DATA_DIR || '/data';

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function resolve(name) {
  const full = path.join(DATA_DIR, name);
  ensureDir(path.dirname(full));
  return full;
}

function readJson(name, fallback) {
  const full = resolve(name);
  try {
    if (!fs.existsSync(full)) return fallback;
    const raw = fs.readFileSync(full, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    log.warn(`Kunde inte läsa ${name}: ${err.message}. Använder standardvärde.`);
    return fallback;
  }
}

function writeJsonNow(name, value) {
  const full = resolve(name);
  const tmp = `${full}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, full);
    return true;
  } catch (err) {
    log.error(`Kunde inte skriva ${name}: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch (_) { /* ingen kvar att städa */ }
    return false;
  }
}

/**
 * Strypt skrivare. Ger tillbaka en funktion som tar emot ett värde.
 * @param {string} name     filnamn under /data
 * @param {number} minMs    kortaste tid mellan två skrivningar
 */
function throttledWriter(name, minMs) {
  let pending = null;
  let timer = null;
  let lastWrite = 0;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending === null) return;
    const value = pending;
    pending = null;
    lastWrite = Date.now();
    writeJsonNow(name, value);
  }

  function save(value, { immediate = false } = {}) {
    pending = value;
    if (immediate) return flush();

    const since = Date.now() - lastWrite;
    if (since >= minMs) return flush();
    if (!timer) timer = setTimeout(flush, minMs - since);
  }

  return { save, flush, stats: () => ({ lastWrite, waiting: pending !== null }) };
}

return { DATA_DIR, readJson, writeJsonNow, throttledWriter, ensureDir };
})();

/* ========================================================================== */
/* 3  Inställningar                                                         */
/* ========================================================================== */

const config = (function () {
/**
 * Två sorters inställningar, medvetet åtskilda:
 *
 *  HA-INSTÄLLNINGAR (/data/options.json) skrivs av Home Assistant när du sparar
 *  under fliken Konfiguration. Kräver omstart. Här bor sådant som ändras nästan
 *  aldrig: certifikat, prisområde, inloggningsuppgifter.
 *
 *  DRIFTINSTÄLLNINGAR (/data/settings.json) ändras från adminfliken och slår
 *  igenom direkt. Här bor avgifter, SMS-läge och strömgräns.
 *
 * Blandar man ihop dem får man antingen omstart vid varje avgiftsändring, eller
 * hemligheter som ligger utanför HA:s säkerhetskopiering.
 */

const HA_DEFAULTS = {
  ssl: true,
  certfile: 'fullchain.pem',
  keyfile: 'privkey.pem',
  location_name: 'Laddstolpen',
  price_zone: 'SE3',
  mode: 'simulering',        // simulering | avlasning | skarp
  easee_username: '',
  easee_password: '',
  easee_charger_id: '',
  easee_equalizer_id: '',
  log_level: 'info',
};

/** Prisformel B: momsen ligger i självkostnaden men nämns aldrig. */
const SETTINGS_DEFAULTS = {
  // Din självkostnad, kronor per kWh exklusive moms
  supplierFeeSek: 0.069,   // elhandelspåslag
  gridTransferSek: 0.122,  // rörlig nätavgift
  energyTaxSek: 0.360,     // energiskatt
  vatMultiplier: 1.25,     // moms på självkostnaden, syns aldrig i gränssnittet

  // Ditt påslag, läggs på efter moms och redovisas som egen rad
  serviceFeeSek: 0.500,

  // Laddbox
  maxChargerCurrent: 16,
  offlineMaxCurrent: 12,

  // SMS: simulerat | dryrun | whitelist | live
  smsMode: 'simulerat',
  smsWhitelist: [],
  smsMaxPerDay: 40,
  smsMaxPerHourPerNumber: 3,
  smsMaxPerHourPerIp: 5,
};

let ha = { ...HA_DEFAULTS };
let settings = { ...SETTINGS_DEFAULTS };

const writer = store.throttledWriter('settings.json', 2000);

function loadHaOptions() {
  const raw = store.readJson('options.json', null);
  if (raw && typeof raw === 'object') {
    ha = { ...HA_DEFAULTS, ...raw };
  } else {
    log.warn('Hittade ingen options.json. Kör med standardvärden.');
    ha = { ...HA_DEFAULTS };
  }
  log.setLevel(ha.log_level);
  return ha;
}

function loadSettings() {
  const raw = store.readJson('settings.json', null);
  settings = raw && typeof raw === 'object'
    ? { ...SETTINGS_DEFAULTS, ...raw }
    : { ...SETTINGS_DEFAULTS };
  return settings;
}

const NUMERIC = [
  'supplierFeeSek', 'gridTransferSek', 'energyTaxSek', 'vatMultiplier',
  'serviceFeeSek', 'maxChargerCurrent', 'offlineMaxCurrent',
  'smsMaxPerDay', 'smsMaxPerHourPerNumber', 'smsMaxPerHourPerIp',
];
const SMS_MODES = ['simulerat', 'dryrun', 'whitelist', 'live'];

/** Tar emot delvisa uppdateringar från adminfliken och sparar. */
function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: 'Ogiltig inställningsdata.' };
  }

  const next = { ...settings };

  for (const key of NUMERIC) {
    if (!(key in patch)) continue;
    const n = Number(String(patch[key]).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${key} måste vara ett tal som inte är negativt.` };
    }
    next[key] = n;
  }

  if ('smsMode' in patch) {
    if (!SMS_MODES.includes(patch.smsMode)) {
      return { ok: false, error: `Okänt SMS-läge: ${patch.smsMode}` };
    }
    next.smsMode = patch.smsMode;
  }

  if ('smsWhitelist' in patch) {
    if (!Array.isArray(patch.smsWhitelist)) {
      return { ok: false, error: 'Vitlistan måste vara en lista med nummer.' };
    }
    next.smsWhitelist = patch.smsWhitelist.map((v) => String(v).trim()).filter(Boolean);
  }

  // Rimlighetsspärrar som skyddar mot fingerfel
  if (next.maxChargerCurrent < 6 || next.maxChargerCurrent > 32) {
    return { ok: false, error: 'Maxström måste ligga mellan 6 och 32 A.' };
  }
  if (next.serviceFeeSek > 10) {
    return { ok: false, error: 'Avgiften för stolpen ser orimlig ut. Ange kronor per kWh.' };
  }

  settings = next;
  writer.save(settings, { immediate: true });
  log.info('Driftinställningar uppdaterade från adminfliken.');
  return { ok: true, settings };
}

return {
  loadHaOptions,
  loadSettings,
  updateSettings,
  ha: () => ha,
  settings: () => settings,
  SMS_MODES,
};
})();

/* ========================================================================== */
/* 4  Certifikat                                                            */
/* ========================================================================== */

const tls = (function () {
/**
 * Certifikatet från DuckDNS-tillägget, med automatisk omladdning.
 *
 * Fas 1 läste filerna en enda gång vid start. Det var en bugg: DuckDNS förnyar
 * certifikatet ungefär en månad innan det går ut, men tillägget fortsatte
 * servera det gamla ur minnet — och den dag det verkligen gick ut skulle
 * gästerna plötsligt mötas av varningar om osäker anslutning.
 *
 * Nu kontrolleras filerna varje timme. Har de ändrats byts certifikatet ut i den
 * redan igångvarande servern med setSecureContext(), utan omstart och utan att
 * en pågående laddning störs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const SSL_DIR = process.env.KPS_SSL_DIR || '/ssl';
const CHECK_MS = 60 * 60 * 1000;

let current = null;   // { cert, key, certPath, keyPath, fingerprint, subject, validTo }
let lastError = null;
let server = null;
let timer = null;

function readFiles(options) {
  if (!options.ssl) {
    return { ok: false, reason: 'SSL är avstängt i tilläggets inställningar.' };
  }

  const certPath = path.join(SSL_DIR, options.certfile || 'fullchain.pem');
  const keyPath = path.join(SSL_DIR, options.keyfile || 'privkey.pem');

  for (const p of [certPath, keyPath]) {
    if (!fs.existsSync(p)) {
      return { ok: false, reason: `Filen ${p} finns inte. Kontrollera att DuckDNS-tillägget har hämtat ett certifikat.` };
    }
  }

  try {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    let subject = null; let validTo = null; let fingerprint = null;
    try {
      const x = new X509Certificate(cert);
      subject = x.subject.replace(/^CN=/, '');
      validTo = x.validTo;
      fingerprint = x.fingerprint256;
    } catch (_) { /* certifikatet går ändå att använda */ }
    return { ok: true, cert, key, certPath, keyPath, subject, validTo, fingerprint };
  } catch (err) {
    return { ok: false, reason: `Kunde inte läsa certifikatet: ${err.message}` };
  }
}

/** Läser certifikatet inför serverstart. */
function load(options) {
  const res = readFiles(options);
  if (res.ok) {
    current = res;
    lastError = null;
    log.info(`Certifikat läst från ${res.certPath}`);
    if (res.subject) log.info(`Certifikatet gäller för ${res.subject} till ${res.validTo}`);
  } else {
    current = null;
    lastError = res.reason;
  }
  return res;
}

/** Startar timmeskontrollen mot en redan igångvarande HTTPS-server. */
function watch(httpsServer, options) {
  server = httpsServer;
  if (timer) clearInterval(timer);
  timer = setInterval(() => check(options), CHECK_MS);
  if (timer.unref) timer.unref();
}

function check(options) {
  const res = readFiles(options);

  if (!res.ok) {
    if (lastError !== res.reason) log.warn(`Certifikatkontroll: ${res.reason}`);
    lastError = res.reason;
    return false;
  }

  lastError = null;
  if (current && res.fingerprint && res.fingerprint === current.fingerprint) return false;

  current = res;
  if (server && typeof server.setSecureContext === 'function') {
    try {
      server.setSecureContext({ cert: res.cert, key: res.key });
      log.info(`Nytt certifikat inläst utan omstart. Gäller till ${res.validTo}.`);
      return true;
    } catch (err) {
      log.error(`Kunde inte byta certifikat i drift: ${err.message}`);
    }
  }
  return false;
}

function status() {
  if (!current) return { ok: false, reason: lastError || 'Inget certifikat inläst.' };
  return {
    ok: true,
    path: current.certPath,
    subject: current.subject,
    validTo: current.validTo,
    daysLeft: current.validTo
      ? Math.round((Date.parse(current.validTo) - Date.now()) / 86400000)
      : null,
  };
}

return { load, watch, check, status, current: () => current };
})();

/* ========================================================================== */
/* 5  Elpriser                                                              */
/* ========================================================================== */

const prices = (function () {
/**
 * Elpriser från elprisetjustnu.se.
 *
 * Priset är fakturaunderlag, inte pynt. Tre regler följer av det:
 *
 *  1. CACHA. Dagens och morgondagens priser sparas på disk med sju dagars
 *     historik. Ligger tjänsten nere vid midnatt måste vi ändå kunna debitera
 *     midnattskvarten rätt.
 *
 *  2. GISSA ALDRIG TYST. Saknas priset för en kvart används senast kända värde,
 *     men kvarten märks som uppskattad och det syns på kvittot.
 *
 *  3. MATCHA PÅ TIDSSTÄMPEL, ALDRIG PÅ INDEX. Vid sommartidsomställning har
 *     dygnet 92 eller 100 kvartar i stället för 96. Räknar man "kvart nummer 34"
 *     blir varje pris fel den dagen.
 */

const BASE = 'https://www.elprisetjustnu.se/api/v1/prices';
const CACHE_FILE = 'prices.json';
const KEEP_DAYS = 7;
const FETCH_TIMEOUT_MS = 12000;

/** { "2026-08-26": [ {SEK_per_kWh, time_start, time_end}, ... ] } */
let cache = {};
let lastFetchAttempt = 0;
let lastFetchOk = 0;

function loadCache() {
  const raw = store.readJson(CACHE_FILE, null);
  cache = raw && typeof raw === 'object' && raw.days ? raw.days : {};
  lastFetchOk = (raw && raw.lastFetchOk) || 0;
  const n = Object.keys(cache).length;
  if (n) log.info(`Priscache läst: ${n} dygn.`);
}

function saveCache() {
  // Släng dygn äldre än KEEP_DAYS så filen inte växer i evighet
  const keys = Object.keys(cache).sort();
  while (keys.length > KEEP_DAYS + 2) {
    delete cache[keys.shift()];
  }
  store.writeJsonNow(CACHE_FILE, { days: cache, lastFetchOk });
}

/** Datum i svensk lokaltid som "YYYY-MM-DD" — API:et är dagsindelat lokalt. */
function localDateKey(date) {
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}

function urlFor(dateKey, zone) {
  const [y, m, d] = dateKey.split('-');
  return `${BASE}/${y}/${m}-${d}_${zone}.json`;
}

function validSlots(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const out = [];
  for (const item of data) {
    const p = Number(item && item.SEK_per_kWh);
    const s = Date.parse(item && item.time_start);
    const e = Date.parse(item && item.time_end);
    if (!Number.isFinite(p) || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    out.push({ sek: p, start: s, end: e });
  }
  return out.length ? out.sort((a, b) => a.start - b.start) : null;
}

async function fetchDay(dateKey, zone) {
  const url = urlFor(dateKey, zone);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'kps-laddstolpe/homeassistant' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 404 är normalt för morgondagen före ca kl 13 — inte ett fel värt att larma om
      log.debug(`Prisfil ${dateKey} svarade ${res.status}.`);
      return null;
    }
    return validSlots(await res.json());
  } catch (err) {
    log.warn(`Kunde inte hämta priser för ${dateKey}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Hämtar idag och imorgon. Behåller cachen orörd om hämtningen misslyckas. */
async function refresh({ force = false } = {}) {
  const zone = config.ha().price_zone || 'SE3';
  const now = Date.now();

  if (!force && now - lastFetchAttempt < 60 * 1000) return;
  lastFetchAttempt = now;

  const today = localDateKey(now);
  const tomorrow = localDateKey(now + 24 * 3600 * 1000);

  let changed = false;
  for (const key of [today, tomorrow]) {
    // Dagens hämtas om vi saknar den; morgondagens försöker vi tills den finns
    if (cache[key] && key === today && !force) continue;
    const slots = await fetchDay(key, zone);
    if (slots) {
      const isNew = !cache[key] || cache[key].length !== slots.length;
      cache[key] = slots;
      changed = true;
      lastFetchOk = Date.now();
      if (isNew) log.info(`Priser hämtade för ${key}: ${slots.length} kvartar (${zone}).`);
    }
  }

  if (changed) saveCache();
}

/**
 * Spotpriset för ett givet ögonblick.
 * @returns {{sek:number, start:number, end:number, estimated:boolean}|null}
 */
function spotAt(ms) {
  const key = localDateKey(ms);
  const slots = cache[key];

  if (slots) {
    const hit = slots.find((s) => ms >= s.start && ms < s.end);
    if (hit) return { sek: hit.sek, start: hit.start, end: hit.end, estimated: false };
  }

  // Ingen träff: leta upp senast kända pris före tidpunkten och märk som uppskattat
  let best = null;
  for (const day of Object.keys(cache)) {
    for (const s of cache[day]) {
      if (s.start <= ms && (!best || s.start > best.start)) best = s;
    }
  }
  if (best) return { sek: best.sek, start: best.start, end: best.end, estimated: true };

  return null;
}

/**
 * Prisformel B. Momsen ligger i självkostnaden men redovisas aldrig separat.
 *
 *   pris = (spot + påslag + nätavgift + energiskatt) × moms + avgift för stolpen
 */
function priceBreakdown(spotSek) {
  const s = config.settings();
  const energyExVat = spotSek + s.supplierFeeSek + s.gridTransferSek + s.energyTaxSek;
  const energySek = energyExVat * s.vatMultiplier;
  const serviceSek = s.serviceFeeSek;
  return {
    spotSek: round(spotSek, 4),
    energySek: round(energySek, 4),   // raden "Elkostnad" på kvittot
    serviceSek: round(serviceSek, 4), // raden "Avgift laddstolpe"
    totalSek: round(energySek + serviceSek, 4),
  };
}

/** Priset just nu, färdigt att visa. Null om vi inte har någon prisdata alls. */
function currentPrice(ms = Date.now()) {
  const spot = spotAt(ms);
  if (!spot) return null;
  return {
    ...priceBreakdown(spot.sek),
    estimated: spot.estimated,
    slotStart: new Date(spot.start).toISOString(),
    slotEnd: new Date(spot.end).toISOString(),
  };
}

/** Kommande kvartar för prisgrafen på gästsidan. */
function forecast(hours = 12, fromMs = Date.now()) {
  const startMs = Math.floor(fromMs / (15 * 60 * 1000)) * 15 * 60 * 1000;
  const out = [];
  for (let i = 0; i < hours * 4; i++) {
    const t = startMs + i * 15 * 60 * 1000;
    const spot = spotAt(t);
    if (!spot || spot.estimated) continue; // visa bara det vi faktiskt vet
    out.push({
      t: new Date(t).toISOString(),
      ...priceBreakdown(spot.sek),
    });
  }
  return out;
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function status() {
  const days = Object.keys(cache).sort();
  const today = localDateKey(Date.now());
  const tomorrow = localDateKey(Date.now() + 24 * 3600 * 1000);
  return {
    days,
    haveToday: Boolean(cache[today]),
    haveTomorrow: Boolean(cache[tomorrow]),
    slotsToday: cache[today] ? cache[today].length : 0,
    lastFetchOk: lastFetchOk ? new Date(lastFetchOk).toISOString() : null,
    zone: config.ha().price_zone || 'SE3',
  };
}

return { loadCache, refresh, spotAt, currentPrice, priceBreakdown, forecast, status, localDateKey };
})();

/* ========================================================================== */
/* 6  Laddboxen                                                             */
/* ========================================================================== */

const chargerModule = (function () {
/**
 * Laddboxen bakom ett gemensamt gränssnitt.
 *
 * Fas 2 använder enbart simulatorn. Fas 3 lägger till en riktig Easee-klient med
 * samma metoder, så att allt ovanför — bakgrundsloop, sessioner, prisberäkning —
 * inte behöver ändras när vi kopplar in den skarpa boxen.
 *
 * Gemensamt gränssnitt:
 *   readState()  -> { cableConnected, opMode, powerKw, sessionEnergyKwh, ok, error }
 *   start()      -> { ok, error }
 *   stop()       -> { ok, error }
 *   setLocked(b) -> { ok, error }
 *   setMaxCurrent(a) -> { ok, error }
 */

const OP_MODE = {
  1: 'Urkopplad',
  2: 'Kabel ansluten, väntar',
  3: 'Laddar',
  4: 'Färdig eller pausad',
};

/* ------------------------------------------------------------------ */
/* Simulerad laddbox                                                   */
/* ------------------------------------------------------------------ */

class SimulatedCharger {
  constructor() {
    this.cableConnected = false;
    this.charging = false;
    this.locked = false;
    this.maxCurrent = 16;

    this.targetKw = 11.0;   // full effekt vid trefas 16 A
    this.throttled = false; // simulerar att Equalizern stryper
    this.powerKw = 0;

    this.sessionEnergyKwh = 0;
    this.lifetimeEnergyKwh = 281.61;
    this.lastTick = Date.now();

    this._restore();
  }

  get kind() { return 'simulerad'; }

  /**
   * Simulatorns tillstånd sparas på disk.
   *
   * Utan detta glömmer den virtuella boxen att kabeln sitter i så fort tillägget
   * startas om — och då rapporterar den "urkopplad", bakgrundsloopen avslutar
   * sessionen, och omstartstestet blir meningslöst. En riktig Easee-box bryr sig
   * inte om att vår app startat om; simulatorn måste bete sig likadant för att
   * vara värd något som testverktyg.
   */
  _restore() {
    const s = store.readJson('sim.json', null);
    if (!s || typeof s !== 'object') return;
    this.cableConnected = Boolean(s.cableConnected);
    this.charging = Boolean(s.charging);
    this.locked = Boolean(s.locked);
    this.throttled = Boolean(s.throttled);
    this.maxCurrent = Number(s.maxCurrent) || 16;
    this.targetKw = Number(s.targetKw) || 11.0;
    this.sessionEnergyKwh = Number(s.sessionEnergyKwh) || 0;
    this.lifetimeEnergyKwh = Number(s.lifetimeEnergyKwh) || 281.61;
    // Tiden som gått medan tillägget var nere ska räknas med, precis som en
    // riktig box hade fortsatt ladda under en omstart.
    this.lastTick = Number(s.lastTick) || Date.now();
    log.info(`[Simulator] Tillstånd återläst: kabel ${this.cableConnected ? 'i' : 'ur'}, ${this.charging ? 'laddar' : 'stillastående'}.`);
  }

  _persist() {
    store.writeJsonNow('sim.json', {
      cableConnected: this.cableConnected,
      charging: this.charging,
      locked: this.locked,
      throttled: this.throttled,
      maxCurrent: this.maxCurrent,
      targetKw: this.targetKw,
      sessionEnergyKwh: this.sessionEnergyKwh,
      lifetimeEnergyKwh: this.lifetimeEnergyKwh,
      lastTick: this.lastTick,
    });
  }

  /** Räknar upp energin efter faktisk tid, så en omstart inte hoppar över kWh. */
  _advance() {
    const now = Date.now();
    const hours = (now - this.lastTick) / 3600000;
    this.lastTick = now;

    this.powerKw = this.charging && !this.throttled ? this.targetKw : 0;

    if (hours > 0 && this.powerKw > 0) {
      const added = this.powerKw * hours;
      this.sessionEnergyKwh += added;
      this.lifetimeEnergyKwh += added;
    }
  }

  _opMode() {
    if (!this.cableConnected) return 1;
    if (this.charging) return this.throttled ? 4 : 3;
    return 2;
  }

  async readState() {
    this._advance();
    // Strypt skrivning: energin behöver bara sparas då och då, annars sliter
    // simulatorn på SD-kortet i onödan.
    if (!this._lastPersist || Date.now() - this._lastPersist > 120000) {
      this._lastPersist = Date.now();
      this._persist();
    }
    return {
      ok: true,
      cableConnected: this.cableConnected,
      opMode: this._opMode(),
      powerKw: round(this.powerKw, 2),
      sessionEnergyKwh: round(this.sessionEnergyKwh, 3),
      lifetimeEnergyKwh: round(this.lifetimeEnergyKwh, 2),
      locked: this.locked,
      maxCurrent: this.maxCurrent,
      simulated: true,
    };
  }

  async start() {
    this._advance();
    if (!this.cableConnected) return { ok: false, error: 'Ingen kabel ansluten.' };
    this.charging = true;
    this._persist();
    log.info('[Simulator] Laddning startad.');
    return { ok: true };
  }

  async stop() {
    this._advance();
    this.charging = false;
    this._persist();
    log.info('[Simulator] Laddning stoppad.');
    return { ok: true };
  }

  async setLocked(locked) {
    this.locked = Boolean(locked);
    this._persist();
    return { ok: true };
  }

  async setMaxCurrent(amps) {
    this._advance();
    this.maxCurrent = amps;
    // 3-fas, 230 V per fas: ungefär 0,69 kW per ampere
    this.targetKw = round(amps * 3 * 230 / 1000, 2);
    this._persist();
    log.info(`[Simulator] Maxström satt till ${amps} A (~${this.targetKw} kW).`);
    return { ok: true };
  }

  /* --- knappar som bara finns i simuleringsläge, för adminfliken --- */

  plugIn() {
    this._advance();
    if (this.cableConnected) return { ok: false, error: 'Kabeln sitter redan i.' };
    this.cableConnected = true;
    this.sessionEnergyKwh = 0; // boxen nollställer sin sessionsräknare vid inkoppling
    this._persist();
    log.info('[Simulator] Kabel ansluten.');
    return { ok: true };
  }

  unplug() {
    this._advance();
    this.cableConnected = false;
    this.charging = false;
    this.powerKw = 0;
    this._persist();
    log.info('[Simulator] Kabel urkopplad.');
    return { ok: true };
  }

  setThrottled(on) {
    this._advance();
    this.throttled = Boolean(on);
    this._persist();
    log.info(`[Simulator] Lastbalanserare ${this.throttled ? 'stryper till 0 kW' : 'släpper på full effekt'}.`);
    return { ok: true };
  }

  /** Snabbspolar tiden så man slipper vänta en timme för att testa en laddning. */
  fastForward(minutes) {
    const m = Math.max(1, Math.min(600, Number(minutes) || 15));
    this._advance();
    this.lastTick -= m * 60 * 1000;
    this._advance();
    this._persist();
    log.info(`[Simulator] Spolade fram ${m} minuter.`);
    return { ok: true, minutes: m };
  }
}

/* ------------------------------------------------------------------ */
/* Easee, fas 3                                                        */
/* ------------------------------------------------------------------ */

const EASEE = 'https://api.easee.cloud/api';
const TOKEN_FILE = 'easee-token.json';

/**
 * Easee Cloud.
 *
 * Den gamla molnappen loggade in på nytt i varje varv av bakgrundsloopen —
 * 2 880 inloggningar per laddningsdygn. Det är exakt det anropsmönster som får
 * Easee att blockera en IP-adress, och en blockerad IP betyder att stolpen
 * slutar svara helt. Fyra regler följer av det:
 *
 *  1. EN TOKEN. Hämtas en gång och förnyas med refresh_token innan den går ut,
 *     aldrig genom att posta lösenordet igen. Token sparas på disk och överlever
 *     omstart, så en uppdatering av tillägget inte innebär en ny inloggning.
 *
 *  2. FÖRNYA I TID, MEN OCKSÅ REGELBUNDET. Easees refresh-token dör av
 *     inaktivitet — laddar ingen på en vecka hinner både access- och
 *     refresh-token gå ut, och då krävs full inloggning igen. Därför pollar
 *     loopen även i viloläge, om än glest.
 *
 *  3. BACKA AV VID FEL. 429 och 5xx ger exponentiell väntetid upp till en
 *     halvtimme. Att fortsätta hamra på en tjänst som säger nej är precis så
 *     man blir avstängd.
 *
 *  4. INGA SKRIVNINGAR I AVLÄSNINGSLÄGE. I fas 3 kan klienten bara läsa. Alla
 *     kommandon vägrar med ett tydligt besked tills läget ändras till skarpt.
 */
class EaseeCharger {
  constructor(opts) {
    this.username = (opts.username || '').trim();
    this.password = (opts.password || '').trim();
    this.chargerId = (opts.chargerId || '').trim();
    this.equalizerId = (opts.equalizerId || '').trim();
    this.readOnly = Boolean(opts.readOnly);

    this.token = null;
    this.refreshToken = null;
    this.expiresAt = 0;

    this.backoffUntil = 0;
    this.backoffStep = 0;
    this.lastLoginAt = 0;
    this.lastError = null;
    this.calls = [];        // tidsstämplar, för anropsräknaren
    this.logins = 0;
    this.refreshes = 0;

    this._restoreToken();
  }

  get kind() { return this.readOnly ? 'easee-avläsning' : 'easee'; }

  /* ---------------- token ---------------- */

  _restoreToken() {
    const t = store.readJson(TOKEN_FILE, null);
    if (!t || !t.token) return;
    this.token = t.token;
    this.refreshToken = t.refreshToken || null;
    this.expiresAt = Number(t.expiresAt) || 0;
    const left = Math.round((this.expiresAt - Date.now()) / 60000);
    log.info(`[Easee] Token återläst från disk, ${left > 0 ? left + ' minuter kvar' : 'utgången'}.`);
  }

  _saveToken() {
    store.writeJsonNow(TOKEN_FILE, {
      token: this.token,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      savedAt: new Date().toISOString(),
    });
  }

  _setToken(data) {
    this.token = data.accessToken;
    this.refreshToken = data.refreshToken || this.refreshToken;
    // Förnya en kvart innan utgång, så vi aldrig kör på en token som just dött
    const ttl = (Number(data.expiresIn) || 86400) * 1000;
    this.expiresAt = Date.now() + ttl - 15 * 60 * 1000;
    this._saveToken();
  }

  _backoff(reason) {
    this.backoffStep = Math.min(this.backoffStep + 1, 6);
    const wait = Math.min(60 * 1000 * Math.pow(2, this.backoffStep - 1), 30 * 60 * 1000);
    this.backoffUntil = Date.now() + wait;
    log.warn(`[Easee] ${reason}. Väntar ${Math.round(wait / 1000)} sekunder innan nästa försök.`);
  }

  _ok() { this.backoffStep = 0; this.backoffUntil = 0; this.lastError = null; }

  async _login() {
    // Aldrig mer än en inloggning var femte minut, hur illa det än går
    if (Date.now() - this.lastLoginAt < 5 * 60 * 1000) {
      return { ok: false, error: 'Väntar innan nästa inloggningsförsök.' };
    }
    if (!this.username || !this.password) {
      return { ok: false, error: 'Easee-uppgifter saknas i tilläggets konfiguration.' };
    }

    this.lastLoginAt = Date.now();
    const res = await this._fetch(`${EASEE}/accounts/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ userName: this.username, password: this.password }),
    });

    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        this.lastError = 'Fel användarnamn eller lösenord för Easee.';
        this._backoff('Inloggningen nekades');
        return { ok: false, error: this.lastError };
      }
      this.lastError = `Inloggningen misslyckades (${res.status}).`;
      this._backoff(`Inloggningen misslyckades (${res.status})`);
      return { ok: false, error: this.lastError };
    }

    this.logins += 1;
    this._setToken(res.data);
    this._ok();
    log.info('[Easee] Inloggad. Token giltig i cirka 24 timmar.');
    return { ok: true };
  }

  async _refresh() {
    if (!this.token || !this.refreshToken) return { ok: false, error: 'Ingen token att förnya.' };

    const res = await this._fetch(`${EASEE}/accounts/refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accessToken: this.token, refreshToken: this.refreshToken }),
    });

    if (!res.ok) {
      log.info(`[Easee] Kunde inte förnya token (${res.status}). Loggar in på nytt.`);
      this.token = null;
      this.refreshToken = null;
      return this._login();
    }

    this.refreshes += 1;
    this._setToken(res.data);
    this._ok();
    log.info('[Easee] Token förnyad utan ny inloggning.');
    return { ok: true };
  }

  /** Ser till att vi har en giltig token. */
  async _ensureToken() {
    if (Date.now() < this.backoffUntil) {
      const left = Math.round((this.backoffUntil - Date.now()) / 1000);
      return { ok: false, error: `Väntar ${left} sekunder efter tidigare fel mot Easee.` };
    }
    if (this.token && Date.now() < this.expiresAt) return { ok: true };
    if (this.token && this.refreshToken) return this._refresh();
    return this._login();
  }

  /* ---------------- anrop ---------------- */

  async _fetch(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    this.calls.push(Date.now());
    if (this.calls.length > 500) this.calls = this.calls.slice(-500);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      let data = null;
      try { data = await r.json(); } catch (_) { /* tomt svar är i sin ordning */ }
      return { ok: r.ok, status: r.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: null, netError: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Autentiserat anrop med ett omförsök om token hunnit dö. */
  async _api(path, { method = 'GET', body = null, retry = true } = {}) {
    const auth = await this._ensureToken();
    if (!auth.ok) return { ok: false, error: auth.error };

    const res = await this._fetch(`${EASEE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.ok) { this._ok(); return { ok: true, data: res.data }; }

    if (res.status === 401 && retry) {
      log.info('[Easee] Token underkänd. Förnyar och försöker igen.');
      this.expiresAt = 0;
      return this._api(path, { method, body, retry: false });
    }
    if (res.status === 429) {
      this._backoff('Easee svarade 429, för många anrop');
      return { ok: false, error: 'Easee begränsar antalet anrop just nu.' };
    }
    if (res.status >= 500 || res.status === 0) {
      this._backoff(res.status === 0 ? `Nätverksfel: ${res.netError}` : `Easee svarade ${res.status}`);
      return { ok: false, error: 'Ingen kontakt med Easee just nu.' };
    }

    this.lastError = `Easee svarade ${res.status} på ${path}`;
    return { ok: false, error: this.lastError };
  }

  /* ---------------- gränssnittet ---------------- */

  async readState() {
    if (!this.chargerId) {
      return { ok: false, error: 'Laddbox-id saknas i tilläggets konfiguration.' };
    }
    const res = await this._api(`/chargers/${encodeURIComponent(this.chargerId)}/state`);
    if (!res.ok) return { ok: false, error: res.error };

    const d = res.data || {};
    return {
      ok: true,
      cableConnected: d.cableLocked !== undefined || d.isCableConnected !== undefined
        ? Boolean(d.isCableConnected)
        : Number(d.chargerOpMode) > 1,
      opMode: Number(d.chargerOpMode) || 0,
      powerKw: Number(d.totalPower) || 0,
      sessionEnergyKwh: Number(d.sessionEnergy) || 0,
      lifetimeEnergyKwh: Number(d.lifetimeEnergy) || 0,
      locked: Boolean(d.isCableLocked),
      maxCurrent: Number(d.dynamicChargerCurrent) || Number(d.outputCurrent) || 0,
      simulated: false,
      raw: d,
    };
  }

  _blocked() {
    return {
      ok: false,
      error: 'Läget är avläsning. Inga kommandon skickas till laddboxen förrän du byter till skarpt läge.',
    };
  }

  async start() {
    if (this.readOnly) return this._blocked();
    const r = await this._api(`/chargers/${encodeURIComponent(this.chargerId)}/commands/start_charging`, { method: 'POST', body: {} });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async stop() {
    if (this.readOnly) return this._blocked();
    const r = await this._api(`/chargers/${encodeURIComponent(this.chargerId)}/commands/stop_charging`, { method: 'POST', body: {} });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async setLocked(locked) {
    if (this.readOnly) return this._blocked();
    const r = await this._api(`/chargers/${encodeURIComponent(this.chargerId)}/commands/lock_state`, { method: 'POST', body: { state: Boolean(locked) } });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async setMaxCurrent(amps) {
    if (this.readOnly) return this._blocked();
    const r = await this._api(`/chargers/${encodeURIComponent(this.chargerId)}/settings`, {
      method: 'POST',
      body: { dynamicChargerCurrent: amps },
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** För rå API-inspektören i adminfliken. */
  async raw(what) {
    const id = encodeURIComponent(this.chargerId);
    const eq = encodeURIComponent(this.equalizerId);
    if (what === 'state') return this._api(`/chargers/${id}/state`);
    if (what === 'details') return this._api(`/chargers/${id}/details`);
    if (what === 'config') return this._api(`/chargers/${id}/config`);
    if (what === 'chargers') return this._api('/accounts/chargers');
    if (what === 'equalizer') {
      if (!this.equalizerId) return { ok: false, error: 'Inget equalizer-id angivet.' };
      return this._api(`/equalizers/${eq}/state`);
    }
    return { ok: false, error: `Okänt val: ${what}` };
  }

  stats() {
    const hourAgo = Date.now() - 3600 * 1000;
    return {
      chargerId: this.chargerId || null,
      equalizerId: this.equalizerId || null,
      readOnly: this.readOnly,
      hasToken: Boolean(this.token),
      tokenExpiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      tokenMinutesLeft: this.expiresAt ? Math.round((this.expiresAt - Date.now()) / 60000) : null,
      callsLastHour: this.calls.filter((t) => t > hourAgo).length,
      logins: this.logins,
      refreshes: this.refreshes,
      backoffUntil: this.backoffUntil ? new Date(this.backoffUntil).toISOString() : null,
      lastError: this.lastError,
    };
  }
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * Tre lägen:
 *   simulering  virtuell laddbox, ingen kontakt med Easee
 *   avlasning   riktig Easee, men enbart läsning. Inga kommandon skickas.
 *   skarp       riktig Easee med kommandon
 */
function create(mode, opts) {
  if (mode === 'simulering') return new SimulatedCharger();
  return new EaseeCharger({ ...opts, readOnly: mode === 'avlasning' });
}

return { create, OP_MODE, SimulatedCharger, EaseeCharger };
})();

/* ========================================================================== */
/* 7  Sessioner                                                             */
/* ========================================================================== */

const sessions = (function () {
/**
 * Laddsessioner.
 *
 * Två filer, medvetet åtskilda:
 *   active.json   en enda pågående session. Skrivs ofta, men strypt.
 *   history.json  avslutade sessioner. Varje post skrivs en gång och rörs inte igen.
 *
 * Delas de inte upp måste hela historiken skrivas om varje halvminut, och det är
 * så man sliter ut ett SD-kort.
 *
 * Kostnaden ackumuleras kvart för kvart. Slutsumman är summan av de loggade
 * kvartarna och räknas ALDRIG om mot ett schablonpris — den gamla appen gjorde
 * det på ett ställe, och då kastades hela poängen med kvartsavräkningen bort.
 */

const crypto = require('node:crypto');
const ACTIVE_FILE = 'active.json';
const HISTORY_FILE = 'history.json';
const HISTORY_MAX = 2000;

/** Strypt till två minuter: vid strömavbrott förloras som mest två minuters energi. */
const activeWriter = store.throttledWriter(ACTIVE_FILE, 120 * 1000);

let active = null;
let history = [];

function load() {
  active = store.readJson(ACTIVE_FILE, null);
  history = store.readJson(HISTORY_FILE, []);
  if (!Array.isArray(history)) history = [];
  if (active && active.status !== 'CHARGING') active = null;
  if (active) {
    log.info(`Återupptar pågående session ${active.id} (${active.energyKwh} kWh, ${active.costSek} kr).`);
  }
  log.info(`Historik: ${history.length} avslutade sessioner.`);
}

function newId() {
  return crypto.randomUUID();
}

/** Kvittonyckeln är slumpad, inte ett löpnummer — annars kan man läsa grannens. */
function newReceiptKey() {
  return crypto.randomBytes(6).toString('base64url');
}

function nextNumber() {
  const nums = history.map((s) => s.number || 0);
  if (active && active.number) nums.push(active.number);
  return (nums.length ? Math.max(...nums) : 1000) + 1;
}

function start({ phone, cableEpisode, startEnergyKwh, simulated }) {
  if (active) return { ok: false, error: 'En laddning pågår redan.' };

  active = {
    id: newId(),
    number: nextNumber(),
    receiptKey: newReceiptKey(),
    phone: phone || null,
    status: 'CHARGING',
    simulated: Boolean(simulated),
    cableEpisode: cableEpisode || null,

    startedAt: new Date().toISOString(),
    endedAt: null,

    startEnergyKwh: Number(startEnergyKwh) || 0,
    energyKwh: 0,
    costEnergySek: 0,
    costServiceSek: 0,
    costSek: 0,

    usedEstimatedPrice: false,
    payment: 'UNPAID',      // UNPAID | GUEST_CLAIMS_PAID | CONFIRMED
    samples: [],
  };

  activeWriter.save(active, { immediate: true });
  log.info(`Session ${active.number} startad${phone ? ` för ${maskPhone(phone)}` : ''}.`);
  return { ok: true, session: active };
}

/**
 * Ett varv i bakgrundsloopen. Lägger till energin sedan förra avläsningen och
 * prissätter just den mängden mot priset för den kvart vi befinner oss i.
 */
function accumulate({ sessionEnergyKwh, powerKw, price }) {
  if (!active) return null;

  const raw = Number(sessionEnergyKwh);
  let total = Number.isFinite(raw) ? raw - active.startEnergyKwh : active.energyKwh;

  // Boxen har nollställt sin egen räknare mitt i sessionen
  if (Number.isFinite(raw) && raw + 0.001 < active.startEnergyKwh) {
    log.warn(`Laddboxens sessionsräknare nollställdes. Justerar utgångsvärdet.`);
    active.startEnergyKwh = 0;
    total = raw;
  }

  if (!Number.isFinite(total) || total < 0) total = active.energyKwh;

  const deltaKwh = Math.max(0, total - active.energyKwh);

  if (deltaKwh > 0 && price) {
    active.energyKwh = round(total, 3);
    active.costEnergySek = round(active.costEnergySek + deltaKwh * price.energySek, 4);
    active.costServiceSek = round(active.costServiceSek + deltaKwh * price.serviceSek, 4);
    active.costSek = round(active.costEnergySek + active.costServiceSek, 2);
    if (price.estimated) active.usedEstimatedPrice = true;
  }

  active.powerKw = Number(powerKw) || 0;
  active.updatedAt = new Date().toISOString();

  // En mätpunkt i minuten räcker för grafen och håller filen liten
  const last = active.samples[active.samples.length - 1];
  if (!last || Date.now() - Date.parse(last.t) >= 60000) {
    active.samples.push({
      t: active.updatedAt,
      kw: active.powerKw,
      kwh: active.energyKwh,
      sek: active.costSek,
      price: price ? price.totalSek : null,
    });
    if (active.samples.length > 1440) active.samples.shift();
  }

  activeWriter.save(active);
  return active;
}

function finish(reason) {
  if (!active) return null;

  activeWriter.flush();

  const done = {
    ...active,
    status: 'COMPLETED',
    endedAt: new Date().toISOString(),
    endReason: reason || 'okänd',
    costSek: round(active.costEnergySek + active.costServiceSek, 2),
    costEnergySek: round(active.costEnergySek, 2),
    costServiceSek: round(active.costServiceSek, 2),
  };

  history.push(done);
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);

  store.writeJsonNow(HISTORY_FILE, history);
  store.writeJsonNow(ACTIVE_FILE, null);
  active = null;

  log.info(`Session ${done.number} avslutad (${reason}): ${done.energyKwh} kWh, ${done.costSek} kr.`);
  return done;
}

function getActive() { return active; }
function getHistory(limit = 100) { return history.slice(-limit).reverse(); }
function byReceiptKey(key) {
  if (!key) return null;
  if (active && active.receiptKey === key) return active;
  return history.find((s) => s.receiptKey === key) || null;
}
function unpaid() { return history.filter((s) => s.payment !== 'CONFIRMED'); }

function setPayment(id, state) {
  const valid = ['UNPAID', 'GUEST_CLAIMS_PAID', 'CONFIRMED'];
  if (!valid.includes(state)) return { ok: false, error: 'Okänd betalningsstatus.' };
  const s = history.find((x) => x.id === id);
  if (!s) return { ok: false, error: 'Sessionen hittades inte.' };
  s.payment = state;
  store.writeJsonNow(HISTORY_FILE, history);
  return { ok: true, session: s };
}

/** Publik vy — allt som gästsidan får se. Aldrig telefonnummer. */
function publicView(s) {
  if (!s) return null;
  return {
    number: s.number,
    receiptKey: s.receiptKey,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    energyKwh: round(s.energyKwh, 2),
    powerKw: s.powerKw || 0,
    costEnergySek: round(s.costEnergySek, 2),
    costServiceSek: round(s.costServiceSek, 2),
    costSek: round(s.costSek, 2),
    usedEstimatedPrice: Boolean(s.usedEstimatedPrice),
    payment: s.payment,
    simulated: Boolean(s.simulated),
  };
}

function maskPhone(p) {
  const s = String(p);
  return s.length > 4 ? `${s.slice(0, 3)}…${s.slice(-2)}` : '…';
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function flush() { activeWriter.flush(); }

/**
 * Endast för simuleringsläget.
 *
 * "Spola fram 60 minuter" flyttar simulatorns egen klocka, men inte
 * väggklockan — så tidräknaren i gästvyn visade de två verkliga minuter som
 * gått medan energin visade en timmes laddning. Genom att flytta sessionens
 * starttid lika långt bakåt hänger de ihop igen, och kvittots varaktighet blir
 * rimlig i testerna i stället för missvisande.
 */
function shiftStartBack(minutes) {
  if (!active) return;
  const ms = minutes * 60 * 1000;
  active.startedAt = new Date(Date.parse(active.startedAt) - ms).toISOString();
  active.samples = active.samples.map((s) => ({
    ...s,
    t: new Date(Date.parse(s.t) - ms).toISOString(),
  }));
  activeWriter.save(active, { immediate: true });
}

return {
  load, start, accumulate, finish, flush, shiftStartBack,
  getActive, getHistory, byReceiptKey, unpaid, setPayment,
  publicView, maskPhone,
};
})();

/* ========================================================================== */
/* 8  Bakgrundsloopen                                                       */
/* ========================================================================== */

const loop = (function () {
/**
 * Bakgrundsloopen. Hjärtat i appen.
 *
 * Kör var 30:e sekund oavsett om någon har appen öppen. Läser laddboxen,
 * prissätter energin som tillkommit, och avslutar sessionen när kabeln dras ur.
 *
 * Två saker som den gamla appen gjorde fel och som rättas här:
 *
 *  DRIFTLÄGE 2 ÄR INTE URKOPPLAD. Gamla koden avslutade sessionen på opMode 1
 *  ELLER 2. Läge 2 betyder "kabel ansluten, väntar" och kan uppstå tillfälligt
 *  när lastbalanseraren stryper. Nu krävs att kabeln faktiskt rapporteras
 *  urkopplad, och att den gör det TVÅ avläsningar i rad.
 *
 *  KABELNS LÖPNUMMER. Varje gång kabeln går från urkopplad till ansluten får
 *  tillfället ett nytt nummer. Verifieringslänken i SMS:et bär med sig numret,
 *  så en länk som klickas hemifrån efter att någon annan satt i sin bil kan inte
 *  starta laddning på fel bil.
 */

/**
 * Två takter. Under laddning behövs 30 sekunder för att kostnaden ska följa
 * kvartarna. I viloläge räcker fem minuter — men vi slutar ALDRIG helt, för
 * Easees refresh-token dör av inaktivitet och då krävs full inloggning igen.
 */
const TICK_BUSY_MS = 30 * 1000;
const TICK_IDLE_MS = 5 * 60 * 1000;
const PRICE_REFRESH_MS = 15 * 60 * 1000;
const IDLE_FINISH_MS = 20 * 60 * 1000; // färdigladdad och 0 kW så länge -> avsluta

let charger = null;
let timer = null;

let snapshot = {
  ok: false,
  error: 'Ingen avläsning ännu.',
  cableConnected: false,
  opMode: 0,
  powerKw: 0,
  sessionEnergyKwh: 0,
  readAt: null,
};

let cableState = { episode: 0, connected: false };
let disconnectStrikes = 0;
let zeroPowerSince = null;
let lastPriceRefresh = 0;
let ticking = false;
let stopped = false;
let lastTickAt = null;

function loadCableState() {
  const raw = store.readJson('cable.json', null);
  if (raw && typeof raw.episode === 'number') cableState = raw;
}

function saveCableState() {
  store.writeJsonNow('cable.json', cableState);
}

function init(chargerInstance) {
  charger = chargerInstance;
  loadCableState();
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await refreshPricesIfDue();

    const state = await charger.readState();
    lastTickAt = new Date().toISOString();

    if (!state.ok) {
      snapshot = { ...snapshot, ok: false, error: state.error, readAt: lastTickAt };
      log.warn(`Kunde inte läsa laddboxen: ${state.error}`);
      // Sessionen behålls med oförändrade värden. Ett avbrott i molnet får
      // aldrig innebära att en pågående laddning tappas bort.
      return;
    }

    snapshot = { ...state, error: null, readAt: lastTickAt };
    trackCable(state);

    const active = sessions.getActive();
    if (!active) { disconnectStrikes = 0; zeroPowerSince = null; return; }

    if (await handleDisconnect(state)) return;

    const price = prices.currentPrice();
    if (!price) {
      log.warn('Ingen prisdata tillgänglig. Energin loggas men prissätts vid nästa varv.');
    }
    sessions.accumulate({
      sessionEnergyKwh: state.sessionEnergyKwh,
      powerKw: state.powerKw,
      price,
    });

    await handleIdleFinish(state);
  } catch (err) {
    log.error(`Fel i bakgrundsloopen: ${err.stack || err.message}`);
  } finally {
    ticking = false;
  }
}

function trackCable(state) {
  if (state.cableConnected && !cableState.connected) {
    cableState = { episode: cableState.episode + 1, connected: true, at: new Date().toISOString() };
    saveCableState();
    log.info(`Kabel ansluten. Löpnummer #${cableState.episode}.`);
  } else if (!state.cableConnected && cableState.connected) {
    cableState = { ...cableState, connected: false, at: new Date().toISOString() };
    saveCableState();
    log.info('Kabel urkopplad.');
  }
}

async function handleDisconnect(state) {
  // Enbart faktisk urkoppling räknas. Driftläge 2 gör det inte.
  const looksDisconnected = state.cableConnected === false || state.opMode === 1;

  if (!looksDisconnected) { disconnectStrikes = 0; return false; }

  disconnectStrikes += 1;
  if (disconnectStrikes < 2) {
    log.debug('Kabeln ser urkopplad ut. Väntar på bekräftelse nästa varv.');
    return false;
  }

  log.info('Kabeln urkopplad två avläsningar i rad. Avslutar sessionen.');
  await endSession('kabel urkopplad');
  disconnectStrikes = 0;
  return true;
}

async function handleIdleFinish(state) {
  const idle = state.powerKw <= 0.05 && (state.opMode === 4 || state.opMode === 2);

  if (!idle) { zeroPowerSince = null; return; }
  if (!zeroPowerSince) { zeroPowerSince = Date.now(); return; }

  if (Date.now() - zeroPowerSince >= IDLE_FINISH_MS) {
    log.info('Färdigladdad utan effekt i 20 minuter. Avslutar sessionen.');
    await endSession('färdigladdad');
    zeroPowerSince = null;
  }
}

async function endSession(reason) {
  const stop = await charger.stop();
  if (!stop.ok) log.warn(`Stoppkommandot misslyckades: ${stop.error}`);
  await charger.setLocked(false);
  return sessions.finish(reason);
}

async function refreshPricesIfDue() {
  const now = Date.now();
  if (now - lastPriceRefresh < PRICE_REFRESH_MS) return;
  lastPriceRefresh = now;
  await prices.refresh();
}

function nextDelay() {
  if (sessions.getActive()) return TICK_BUSY_MS;
  if (snapshot.ok && snapshot.cableConnected) return TICK_BUSY_MS;
  return TICK_IDLE_MS;
}

function schedule() {
  if (stopped) return;
  timer = setTimeout(async () => {
    await tick();
    schedule();
  }, nextDelay());
  if (timer.unref) timer.unref();
}

function start() {
  if (timer || stopped === false && timer) return;
  stopped = false;
  tick().then(schedule);
  log.info(`Bakgrundsloopen igång: ${TICK_BUSY_MS / 1000} s under laddning, ${TICK_IDLE_MS / 60000} min i viloläge.`);
}

function stop() {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}

return {
  init, start, stop, tick,
  getSnapshot: () => snapshot,
  getCableState: () => cableState,
  getLastTickAt: () => lastTickAt,
  endSession,
};
})();

/* ========================================================================== */
/* 9  Webbservern                                                           */
/* ========================================================================== */

const httpModule = (function () {
/**
 * En mycket liten webbserverhjälp. Ingen Express, inga npm-beroenden.
 *
 * Skälet är inte purism: varje beroende är ett paket till som ska hämtas och
 * byggas på en Raspberry Pi, och en sak till som kan gå sönder vid en
 * uppdatering. Vi behöver routing, JSON-svar och en hastighetsbegränsare —
 * tillsammans ett par hundra rader.
 */

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

class Router {
  constructor(name) {
    this.name = name;
    this.routes = [];
  }

  /** Sökvägar får en dynamisk del med :namn, till exempel /api/kvitto/:key */
  add(method, pattern, handler) {
    const names = [];
    const rx = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => {
      names.push(m.slice(1));
      return '([^/]+)';
    }) + '$');
    this.routes.push({ method, rx, names, handler, pattern });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = rx_exec(r.rx, pathname);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  /** Lista över registrerade sökvägar — används av adminfliken för att visa
   *  svart på vitt att gästsidan inte har några adminvägar. */
  list() {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }
}

function rx_exec(rx, s) {
  rx.lastIndex = 0;
  return rx.exec(s);
}

/* ------------------------------------------------------------------ */
/* Svarshjälp                                                          */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Robots-Tag': 'noindex, nofollow',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Läser en JSON-kropp med tak, så ingen kan skicka en oändlig ström. */
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); resolve({ ok: false, error: 'Förfrågan för stor.' }); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({ ok: true, body: {} });
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (err) {
        resolve({ ok: false, error: 'Kunde inte tolka JSON.' });
      }
    });
    req.on('error', () => resolve({ ok: false, error: 'Avbruten förfrågan.' }));
  });
}

/* ------------------------------------------------------------------ */
/* Hastighetsbegränsare                                                */
/* ------------------------------------------------------------------ */

/**
 * Glidande fönster i minnet. Räcker gott: en Raspberry Pi med en laddstolpe
 * behöver inte Redis, och en omstart nollställer räknarna vilket är acceptabelt.
 */
class RateLimiter {
  constructor() { this.buckets = new Map(); }

  /** @returns {{allowed:boolean, retryAfterSec:number, used:number}} */
  hit(key, limit, windowMs) {
    const now = Date.now();
    let times = this.buckets.get(key) || [];
    times = times.filter((t) => now - t < windowMs);

    if (times.length >= limit) {
      this.buckets.set(key, times);
      const retry = Math.ceil((windowMs - (now - times[0])) / 1000);
      return { allowed: false, retryAfterSec: Math.max(1, retry), used: times.length };
    }

    times.push(now);
    this.buckets.set(key, times);

    // Enkel städning så kartan inte växer i evighet
    if (this.buckets.size > 5000) {
      for (const [k, v] of this.buckets) {
        if (!v.length || now - v[v.length - 1] > windowMs) this.buckets.delete(k);
      }
    }
    return { allowed: true, retryAfterSec: 0, used: times.length };
  }

  count(key, windowMs) {
    const now = Date.now();
    return (this.buckets.get(key) || []).filter((t) => now - t < windowMs).length;
  }
}

/** Klientens IP. Bakom Ingress är den ointressant, på gästsidan är den vårt skydd. */
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'okänd';
}

/* ------------------------------------------------------------------ */
/* Begäranhanterare                                                    */
/* ------------------------------------------------------------------ */

function makeHandler(router, { surface }) {
  return async function handle(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) { /* behåll / */ }

    // Home Assistants Ingress lägger ett prefix framför alla sökvägar
    const prefix = req.headers['x-ingress-path'];
    if (prefix && pathname.startsWith(prefix)) {
      pathname = pathname.slice(prefix.length) || '/';
    }
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    const hit = router.match(req.method === 'HEAD' ? 'GET' : req.method, pathname);

    if (!hit) {
      if (surface === 'guest') {
        // Gästsidan berättar inte vad som finns eller inte finns
        return sendJson(res, 404, { error: 'Sidan finns inte.' });
      }
      return sendJson(res, 404, { error: `Okänd sökväg: ${pathname}` });
    }

    try {
      await hit.route.handler(req, res, {
        params: hit.params,
        query: new URL(req.url, 'http://localhost').searchParams,
        ip: clientIp(req),
        ingressPrefix: prefix || '',
      });
    } catch (err) {
      // Aldrig stackspår till klienten. Detaljerna hör hemma i tilläggets logg.
      log.error(`Fel i ${surface} ${req.method} ${pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Något gick fel. Försök igen.' });
    }
  };
}

return {
  Router, RateLimiter, makeHandler,
  sendJson, sendHtml, sendText, readJsonBody, clientIp,
};
})();

/* ========================================================================== */
/* 10  Gästsidan                                                            */
/* ========================================================================== */

const guestPage = (function () {
/**
 * Gästsidan. Ren HTML, CSS och vanilla JavaScript — inget React, inget byggsteg.
 *
 * Gränssnittet har sex tillstånd och ingen komplicerad datahantering, så ett
 * ramverk skulle mest kosta: en byggkedja som ska köras på en Raspberry Pi, ett
 * npm-träd att hålla uppdaterat, och minuter i stället för sekunder vid varje
 * installation. Utan det bygger tillägget på några sekunder.
 */

function escapeHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render({ locationName }) {
  const place = escapeHtml(locationName || 'Laddstolpen');

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0a140f">
<title>${place} — Laddstolpe</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  min-height:100dvh;background:#0a140f;
  background-image:radial-gradient(130% 60% at 50% 0%,#12241b 0%,#0a140f 66%);
  color:#EDF3EF;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  display:flex;align-items:flex-start;justify-content:center;padding:22px 16px 40px;
}
.wrap{width:100%;max-width:420px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.place{font-size:15px;font-weight:600;color:#F3D082}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#A9C9B6}
.live i{width:7px;height:7px;border-radius:50%;background:#6FD39B;display:block}
.live.busy i{background:#C9A961}.live.busy{color:#D8B978}
.live.off i{background:#7C8C84}.live.off{color:#93A39B}

.card{background:rgba(18,36,27,.72);border:1px solid rgba(226,177,68,.22);
  border-radius:18px;padding:26px 22px 24px;backdrop-filter:blur(10px);
  box-shadow:0 20px 50px rgba(0,0,0,.4)}

.hero{text-align:center;padding:2px 0 18px}
.icon{width:60px;height:60px;margin:0 auto 16px;border-radius:50%;
  border:1.5px solid rgba(226,177,68,.4);display:grid;place-items:center}
.icon svg{width:29px;height:29px}
h1{font-size:25px;font-weight:600;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px;color:#fff;text-wrap:balance}
.lead{font-size:16px;line-height:1.45;color:#BFD2C6;margin:0}
.tel{display:block;white-space:nowrap;color:#fff;font-weight:600;font-size:18px;margin:5px 0 2px;font-variant-numeric:tabular-nums}

.pricebox{background:rgba(10,20,15,.5);border:1px solid rgba(226,177,68,.26);
  border-radius:14px;padding:18px 16px 16px;text-align:center;margin-bottom:14px}
.pricebox .lbl{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:#9FB6A8;margin-bottom:8px}
.pricebox .big{font-size:42px;font-weight:700;line-height:1;color:#F3D082;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.pricebox .unit{font-size:17px;font-weight:500;color:#C9A961;margin-left:3px}
.pricebox .sub{font-size:13.5px;color:#A9BFB1;margin-top:10px;line-height:1.45}

details{border-top:1px solid rgba(226,177,68,.18)}
summary{list-style:none;cursor:pointer;padding:13px 2px;font-size:15px;color:#C4D6C9;
  display:flex;justify-content:space-between;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";font-size:19px;color:#E2B144;line-height:1}
details[open] summary::after{content:"–"}
summary:focus-visible{outline:2px solid #E2B144;outline-offset:2px;border-radius:3px}
.dbody{padding:0 2px 14px;font-size:14px;color:#AFC5B6;line-height:1.6}
.drow{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-variant-numeric:tabular-nums}
.drow.tot{border-top:1px solid rgba(226,177,68,.2);margin-top:6px;padding-top:9px;color:#EDF3EF;font-weight:600}

.field{margin-bottom:14px}
.field label{display:block;font-size:14.5px;color:#BFD2C6;margin-bottom:7px}
.field input{width:100%;font:inherit;font-size:21px;font-weight:500;letter-spacing:.02em;
  padding:15px 16px;border-radius:12px;border:1.5px solid rgba(226,177,68,.35);
  background:rgba(10,20,15,.7);color:#fff}
.field input::placeholder{color:#6F8578;font-weight:400}

button.btn{display:block;width:100%;font:inherit;font-size:19px;font-weight:600;
  padding:18px 16px;border-radius:14px;border:0;background:#E2B144;color:#14231A;cursor:pointer;
  letter-spacing:-.01em}
button.btn[disabled]{opacity:.55;cursor:default}
button.btn:focus-visible{outline:3px solid #F3D082;outline-offset:3px}
button.btn.ghost{background:transparent;color:#E6EFE9;border:1.5px solid rgba(230,239,233,.35)}
button.btn.stop{background:transparent;color:#F0A79E;border:1.5px solid rgba(240,167,158,.5)}
button.btn + button.btn{margin-top:10px}

.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.stat{background:rgba(10,20,15,.5);border:1px solid rgba(226,177,68,.2);border-radius:13px;padding:15px 14px;text-align:center}
.stat.wide{grid-column:1/-1}
.stat .l{font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;color:#9FB6A8;margin-bottom:7px}
.stat .v{font-size:30px;font-weight:700;line-height:1;color:#fff;font-variant-numeric:tabular-nums;letter-spacing:-.025em}
.stat.wide .v{font-size:46px;color:#F3D082}
.stat .u{font-size:15px;font-weight:500;color:#A9BFB1;margin-left:3px}

.runline{display:flex;align-items:center;gap:9px;font-size:14px;color:#A9C9B6;margin-bottom:16px;justify-content:center}
.runline svg{width:15px;height:15px}

.receipt{background:rgba(10,20,15,.5);border:1px solid rgba(226,177,68,.24);border-radius:14px;padding:16px;margin-bottom:14px}
.receipt .r{display:flex;justify-content:space-between;gap:12px;padding:8px 0;font-size:15.5px;color:#C4D6C9;font-variant-numeric:tabular-nums}
.receipt .r.total{border-top:1px solid rgba(226,177,68,.28);margin-top:8px;padding-top:13px;font-size:21px;font-weight:700;color:#F3D082}

.msg{margin:0 0 14px;padding:12px 14px;border-radius:11px;font-size:14.5px;line-height:1.5}
.msg.err{background:rgba(226,120,110,.12);border:1px solid rgba(226,120,110,.45);color:#F3B5AE}
.msg.info{background:rgba(226,177,68,.1);border:1px solid rgba(226,177,68,.35);color:#EBCE93}
.hidden{display:none}
.foot{margin-top:18px;text-align:center;font-size:12.5px;color:rgba(232,240,234,.42);line-height:1.6}
.simbadge{display:inline-block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:#D8B978;border:1px solid rgba(216,185,120,.45);border-radius:100px;padding:3px 10px;margin-top:12px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <span class="place">${place}</span>
    <span class="live" id="live"><i></i><span id="liveText">Läser av…</span></span>
  </div>

  <div class="card" id="card">
    <div class="hero">
      <div class="icon" id="icon" aria-hidden="true"></div>
      <h1 id="title">Läser av laddstolpen…</h1>
      <p class="lead" id="lead">Ett ögonblick.</p>
    </div>
    <div id="slot"></div>
  </div>

  <p class="foot" id="foot"></p>
</div>

<script>
(function () {
  "use strict";

  var ICONS = {
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="#E2B144" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9V5.5a2.5 2.5 0 0 1 5 0V9M14 9V5.5a2.5 2.5 0 0 1 5 0V9M3.5 9h17v3a8.5 8.5 0 0 1-17 0V9zM12 20.5v2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="#6FD39B" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="#C9A961" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg>',
    bolt:  '<svg viewBox="0 0 24 24" fill="#E2B144"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
    warn:  '<svg viewBox="0 0 24 24" fill="none" stroke="#E2786E" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
  };

  var el = {
    live: document.getElementById('live'),
    liveText: document.getElementById('liveText'),
    icon: document.getElementById('icon'),
    title: document.getElementById('title'),
    lead: document.getElementById('lead'),
    slot: document.getElementById('slot'),
    foot: document.getElementById('foot')
  };

  var state = null;
  var busyAction = false;
  var notice = null;
  var lastKey = '';
  var receipt = null;

  // Telefonen minns vilken laddning som är dess egen, så att kvittot kan visas
  // när sessionen tagit slut — och hittas igen senare om den är obetald.
  // Sparat lokalt i webblasaren; ingenting skickas nagonstans.
  var STORE = 'kps.receipt';
  function remember(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) {} }
  function recall() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function forget() { try { localStorage.removeItem(STORE); } catch (e) {} }

  function kr(n) { return Number(n).toFixed(2).replace('.', ','); }
  function num(n, d) { return Number(n).toFixed(d === undefined ? 1 : d).replace('.', ','); }

  function duration(fromIso) {
    if (!fromIso) return '';
    var ms = Date.now() - Date.parse(fromIso);
    if (!isFinite(ms) || ms < 0) ms = 0;
    var min = Math.floor(ms / 60000);
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (h > 0) return h + ' tim ' + m + ' min';
    return m + ' min';
  }

  function priceBlock(p, compact) {
    if (!p) {
      return '<div class="pricebox"><div class="lbl">Priset just nu</div>' +
             '<div class="sub" style="margin-top:0">Prisuppgift saknas just nu.<br>Laddningen mäts ändå och räknas rätt.</div></div>';
    }
    if (compact) {
      return '<div class="pricebox" style="padding:13px 14px"><div class="sub" style="margin-top:0">' +
             'Priset just nu <strong style="color:#F3D082">' + kr(p.totalSek) + ' kr/kWh</strong><br>' +
             'Varav elbörsen ' + kr(p.spotSek) + ' kr.</div></div>';
    }
    return '<div class="pricebox">' +
      '<div class="lbl">Priset just nu</div>' +
      '<div><span class="big">' + kr(p.totalSek) + '</span><span class="unit">kr/kWh</span></div>' +
      '<div class="sub">Varav elbörsen ' + kr(p.spotSek) + ' kr.<br>Resten är nätavgift, skatt och slitage.</div>' +
      (p.estimated ? '<div class="sub" style="color:#D8B978">Uppskattat pris — elbörsen svarar inte just nu.</div>' : '') +
      '</div>' +
      '<details><summary>Hur räknas priset?</summary><div class="dbody">' +
      '<div class="drow"><span>Elkostnad</span><span>' + kr(p.energySek) + ' kr</span></div>' +
      '<div class="drow"><span>Avgift för stolpen</span><span>' + kr(p.serviceSek) + ' kr</span></div>' +
      '<div class="drow tot"><span>Per kWh</span><span>' + kr(p.totalSek) + ' kr</span></div>' +
      '<p style="margin:12px 0 0">Elbörsens pris ändras var femtonde minut. Du betalar det som gäller just den kvart du laddar, inte ett snittpris.</p>' +
      '</div></details>';
  }

  function noticeBlock() {
    if (!notice) return '';
    return '<div class="msg ' + notice.kind + '">' + notice.text + '</div>';
  }

  function render() {
    if (!state) return;
    var s = state;
    var key = [s.view, s.session && s.session.number, s.price && s.price.totalSek,
               s.session && s.session.energyKwh, notice && notice.text, busyAction,
               receipt && receipt.number].join('|');

    // Rör inte DOM:en om inget ändrats — annars tappar man markören i textfältet
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (key === lastKey && typing) return;
    lastKey = key;

    var liveClass = 'live', liveText = 'Ledig';
    if (s.view === 'charging') { liveText = 'Laddar'; }
    else if (s.view === 'busy') { liveClass = 'live busy'; liveText = 'Upptagen'; }
    else if (s.view === 'ready') { liveText = 'Kabel ansluten'; }
    else if (s.view === 'readonly') { liveClass = 'live busy'; liveText = 'Avlasningslage'; }
    else if (s.view === 'done') { liveClass = 'live busy'; liveText = 'Klar'; }
    else if (s.view === 'offline') { liveClass = 'live off'; liveText = 'Ingen kontakt'; }
    el.live.className = liveClass;
    el.liveText.textContent = liveText;

    if (s.view === 'idle') {
      el.icon.innerHTML = ICONS.plug; el.icon.style.display = '';
      el.title.textContent = 'Sätt i laddkabeln';
      el.lead.textContent = 'Anslut kabeln till bilen och stolpen, så fortsätter det här av sig självt.';
      el.slot.innerHTML = noticeBlock() + receiptBanner() + priceBlock(s.price, false);

    } else if (s.view === 'ready') {
      el.icon.innerHTML = ICONS.check; el.icon.style.display = '';
      el.title.textContent = 'Redo att ladda';
      el.lead.textContent = 'Skriv ditt mobilnummer, så får du kvittot dit när du är klar.';
      el.slot.innerHTML = noticeBlock() + receiptBanner() +
        '<div class="field"><label for="tel">Ditt mobilnummer</label>' +
        '<input id="tel" type="tel" inputmode="numeric" autocomplete="tel" placeholder="070 123 45 67"></div>' +
        '<button class="btn" id="startBtn"' + (busyAction ? ' disabled' : '') + '>' +
        (busyAction ? 'Startar…' : 'Starta laddning') + '</button>' +
        priceBlock(s.price, true);

      var btn = document.getElementById('startBtn');
      if (btn) btn.addEventListener('click', doStart);

    } else if (s.view === 'charging') {
      var ses = s.session || {};
      el.icon.style.display = 'none';
      el.title.textContent = 'Laddar';
      el.lead.textContent = 'Du kan låsa mobilen och gå. Laddningen mäts vidare.';
      el.slot.innerHTML = noticeBlock() +
        '<div class="runline">' + ICONS.bolt + 'Pågått i ' + duration(ses.startedAt) + '</div>' +
        '<div class="stats">' +
          '<div class="stat wide"><div class="l">Att betala hittills</div><div><span class="v">' + kr(ses.costSek) + '</span><span class="u">kr</span></div></div>' +
          '<div class="stat"><div class="l">Laddat</div><div><span class="v">' + num(ses.energyKwh) + '</span><span class="u">kWh</span></div></div>' +
          '<div class="stat"><div class="l">Effekt</div><div><span class="v">' + num(ses.powerKw) + '</span><span class="u">kW</span></div></div>' +
        '</div>' +
        (s.price ? '<details><summary>Vad kostar det just nu?</summary><div class="dbody">' +
          '<div class="drow"><span>Priset denna kvart</span><span>' + kr(s.price.totalSek) + ' kr/kWh</span></div>' +
          '<div class="drow"><span>Varav elbörsen</span><span>' + kr(s.price.spotSek) + ' kr</span></div>' +
          '</div></details>' : '') +
        '<button class="btn stop" id="stopBtn" style="margin-top:14px"' + (busyAction ? ' disabled' : '') + '>' +
        (busyAction ? 'Avslutar…' : 'Avsluta laddning') + '</button>';

      var sb = document.getElementById('stopBtn');
      if (sb) sb.addEventListener('click', doStop);

    } else if (s.view === 'readonly') {
      el.icon.innerHTML = ICONS.check; el.icon.style.display = '';
      el.title.textContent = 'Kabeln ar ansluten';
      el.lead.textContent = 'Appen lases av mot laddboxen men skickar inga kommandon an. Starta laddningen i Easee-appen sa lange.';
      el.slot.innerHTML = noticeBlock() + receiptBanner() + priceBlock(s.price, false);

    } else if (s.view === 'busy') {
      el.icon.innerHTML = ICONS.clock; el.icon.style.display = '';
      el.title.textContent = 'Stolpen används just nu';
      el.lead.textContent = 'Någon annan laddar. Du kan inte starta förrän den blir ledig.';
      el.slot.innerHTML = noticeBlock() +
        '<div class="pricebox"><div class="lbl">Pågått i</div>' +
        '<div><span class="big" style="font-size:32px">' + duration(s.busySince) + '</span></div>' +
        '<div class="sub">Hur länge det dröjer beror på bilen — det vet vi inte.</div></div>';

    } else if (s.view === 'done') {
      var d = s.session || {};
      el.icon.style.display = 'none';
      el.title.textContent = 'Tack för att du laddade';
      el.lead.innerHTML = 'Laddning avslutad ' + new Date(d.endedAt || Date.now()).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) + '.';
      el.slot.innerHTML =
        '<div class="receipt">' +
        '<div class="r"><span>Laddat</span><span>' + num(d.energyKwh, 2) + ' kWh</span></div>' +
        '<div class="r"><span>Elkostnad</span><span>' + kr(d.costEnergySek) + ' kr</span></div>' +
        '<div class="r"><span>Avgift laddstolpe</span><span>' + kr(d.costServiceSek) + ' kr</span></div>' +
        '<div class="r total"><span>Att betala</span><span>' + kr(d.costSek) + ' kr</span></div>' +
        '</div>' +
        (d.usedEstimatedPrice ? '<div class="msg info">Delar av laddningen prissattes mot senast kända elpris eftersom elbörsen inte svarade.</div>' : '') +
        '<div class="msg info">Swish och SMS-kvitto kopplas in i fas 5.</div>' +
        '<button class="btn ghost" id="againBtn">Klar</button>';
      var ab = document.getElementById('againBtn');
      if (ab) ab.addEventListener('click', function () {
        var saved = recall();
        if (saved) remember({ key: saved.key, dismissed: true });
        lastKey = ''; poll();
      });

    } else {
      el.icon.innerHTML = ICONS.warn; el.icon.style.display = '';
      el.title.textContent = 'Ingen kontakt med laddstolpen';
      el.lead.textContent = 'Vi försöker igen automatiskt. Ingen laddning kan startas just nu.';
      el.slot.innerHTML = noticeBlock();
    }

    if (s.mode === 'simulering') {
      el.foot.innerHTML = '<span class="simbadge">Simuleringslage</span><br>Ingen riktig laddbox ar inkopplad.';
    } else if (s.mode === 'avlasning') {
      el.foot.innerHTML = '<span class="simbadge">Avlasningslage</span><br>Appen laser av laddboxen men styr den inte.';
    } else {
      el.foot.innerHTML = '';
    }
  }

  function setNotice(kind, text) {
    notice = text ? { kind: kind, text: text } : null;
    lastKey = '';
    render();
  }

  function poll() {
    fetch('api/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state = data;
        if (data.session) { receipt = null; render(); return; }
        return checkReceipt().then(render);
      })
      .catch(function () {
        state = { view: 'offline' };
        render();
      });
  }

  /**
   * Ingen laddning pagar. Har den har telefonen en egen session sparad hamtar
   * vi kvittot for den — sa att den som just dragit ur kabeln mots av sitt
   * kvitto i stallet for "Satt i laddkabeln".
   *
   * Kvittot ligger pa en egen adress med slumpad nyckel och har ingen
   * utgangstid. Det ar en obetald rakning; den ska finnas kvar tills den ar
   * betald, och den bryr sig inte om vad stolpen gor just nu.
   */
  function checkReceipt() {
    var saved = recall();
    if (!saved || !saved.key) { receipt = null; return Promise.resolve(); }

    return fetch('k/' + encodeURIComponent(saved.key), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.session) { forget(); receipt = null; return; }
        if (data.session.payment === 'CONFIRMED') { forget(); receipt = null; return; }
        receipt = data.session;
        if (!saved.dismissed && receipt.status === 'COMPLETED') {
          state.view = 'done';
          state.session = receipt;
        }
      })
      .catch(function () { receipt = null; });
  }

  function receiptBanner() {
    if (!receipt || receipt.status !== 'COMPLETED') return '';
    return '<div class="msg info" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
      '<span>Du har en obetald laddning pa ' + kr(receipt.costSek) + ' kr.</span>' +
      '<a href="#" id="openReceipt" style="color:#F3D082;white-space:nowrap;font-weight:600">Visa kvitto</a></div>';
  }

  function doStart() {
    var input = document.getElementById('tel');
    var phone = input ? input.value.trim() : '';
    if (!phone) { setNotice('err', 'Skriv ditt mobilnummer först.'); return; }

    busyAction = true; setNotice(null, null);
    fetch('api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        busyAction = false;
        if (!res.ok) { setNotice('err', res.body.error || 'Laddningen kunde inte startas.'); return; }
        if (res.body.session && res.body.session.receiptKey) {
          remember({ key: res.body.session.receiptKey, dismissed: false });
        }
        poll();
      })
      .catch(function () { busyAction = false; setNotice('err', 'Ingen kontakt med servern.'); });
  }

  function doStop() {
    busyAction = true; setNotice(null, null);
    fetch('api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        busyAction = false;
        if (!res.ok) { setNotice('err', res.body.error || 'Laddningen kunde inte avslutas.'); return; }
        poll();
      })
      .catch(function () { busyAction = false; setNotice('err', 'Ingen kontakt med servern.'); });
  }

  el.slot.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'openReceipt') {
      e.preventDefault();
      var saved = recall();
      if (saved) remember({ key: saved.key, dismissed: false });
      lastKey = ''; poll();
    }
  });

  poll();
  setInterval(poll, 5000);
})();
</script>
</body>
</html>`;
}

return { render };
})();

/* ========================================================================== */
/* 11  Adminfliken                                                          */
/* ========================================================================== */

const adminPage = (function () {
/**
 * Adminfliken. Nås enbart genom Home Assistants sidopanel, alltså bara av någon
 * som redan är inloggad i HA. Ingen egen inloggning — den gamla appens
 * lösenordsruta hade två fasta lösenord inbyggda som alltid fungerade, och
 * problemet försvinner helt när Ingress avgör vem du är.
 *
 * Fem flikar i fas 2. SMS-fliken tillkommer i fas 5.
 */

function render(ingressPrefix) {
  // Home Assistant serverar adminfliken bakom ett prefix som ändras mellan
  // sessioner. Vi bakar in det i sidan i stället för att förlita oss på att
  // webbläsaren löser relativa adresser rätt — det gör den inte om HA råkar
  // servera sidan utan avslutande snedstreck.
  const base = JSON.stringify((ingressPrefix || '') + '/');

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laddstolpe</title>
<style>
:root{--bg:#F4F6F5;--surf:#fff;--surf2:#EDF1EF;--ink:#16201C;--ink2:#3C4A44;
  --mut:#61706A;--line:#D7DEDA;--gold:#8A6314;--ok:#276B4E;--warn:#8F6410;--bad:#99332B;
  --okbg:#DCEBE3;--warnbg:#F4E9CF;--badbg:#F6E0DD}
@media (prefers-color-scheme:dark){:root{--bg:#0F1513;--surf:#161E1A;--surf2:#1C2621;
  --ink:#E6EDE9;--ink2:#C2CFC8;--mut:#8D9C95;--line:#27332D;--gold:#E2B144;--ok:#61C093;
  --warn:#D8AD4C;--bad:#E2786E;--okbg:#16281F;--warnbg:#2A2314;--badbg:#2C1917}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:940px;margin:0 auto;padding:18px 16px 60px}
h1{font-size:20px;margin:0 0 2px;letter-spacing:-.01em}
.sub{color:var(--mut);font-size:13px;margin:0 0 18px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:20px;overflow-x:auto}
.tab{font:inherit;font-size:14px;font-weight:500;white-space:nowrap;padding:10px 14px;
  background:none;border:0;border-bottom:2px solid transparent;color:var(--mut);cursor:pointer}
.tab[aria-selected=true]{color:var(--gold);border-bottom-color:var(--gold)}
.tab:focus-visible{outline:2px solid var(--gold);outline-offset:-2px}
.panel{display:none}.panel.on{display:block}
.h{font-size:11.5px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;
  color:var(--mut);margin:24px 0 10px}
.h:first-child{margin-top:0}
.card{background:var(--surf);border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin-bottom:12px}
.grid{display:grid;gap:10px;margin-bottom:12px}
.g2{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.hc{display:flex;gap:10px;align-items:flex-start;background:var(--surf);
  border:1px solid var(--line);border-radius:6px;padding:12px 13px}
.dot{width:9px;height:9px;border-radius:50%;margin-top:6px;flex:none;background:var(--mut)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.hc .t{font-size:13.5px;font-weight:600}
.hc .s{font-size:12.5px;color:var(--mut);line-height:1.45}
.kpi{background:var(--surf);border:1px solid var(--line);border-radius:6px;padding:13px 14px}
.kpi .l{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.kpi .v{font-size:25px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1}
.kpi .v.g{color:var(--gold)}
.kpi .u{font-size:14px;font-weight:500;color:var(--mut);margin-left:3px}
.row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;
  padding:10px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.lab{font-size:13.5px}
.hint{font-size:11.5px;color:var(--mut);line-height:1.4;margin-top:2px}
input.inp{font:inherit;font-size:13.5px;font-family:ui-monospace,Menlo,monospace;
  background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:5px;
  padding:8px 10px;width:120px;text-align:right;font-variant-numeric:tabular-nums}
input.inp:focus-visible{outline:2px solid var(--gold);outline-offset:1px}
.unit{font-size:12px;color:var(--mut);margin-left:6px;font-family:ui-monospace,Menlo,monospace}
button.b{font:inherit;font-size:13.5px;font-weight:600;padding:9px 14px;border-radius:6px;
  border:1px solid var(--line);background:var(--surf2);color:var(--ink);cursor:pointer}
button.b.gold{background:var(--gold);border-color:var(--gold);color:#fff}
@media (prefers-color-scheme:dark){button.b.gold{color:#1A2119}}
button.b.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
button.b:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
button.b[disabled]{opacity:.5;cursor:default}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.res{background:var(--okbg);border:1px solid var(--ok);border-radius:6px;padding:13px 15px;margin-top:12px}
.res .l{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ok);margin-bottom:5px}
.res .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ok)}
.res .s{font-size:12.5px;color:var(--mut);margin-top:6px;line-height:1.5}
.tw{border:1px solid var(--line);border-radius:6px;overflow-x:auto;margin-bottom:12px;background:var(--surf)}
table{border-collapse:collapse;width:100%;font-size:13px}
th{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);
  text-align:left;padding:9px 11px;background:var(--surf2);border-bottom:1px solid var(--line);font-weight:600;white-space:nowrap}
td{padding:9px 11px;border-bottom:1px solid var(--line);color:var(--ink2);vertical-align:top}
tr:last-child td{border-bottom:0}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  padding:2px 7px;border-radius:3px;border:1px solid}
.p-ok{color:var(--ok);border-color:var(--ok);background:var(--okbg)}
.p-warn{color:var(--warn);border-color:var(--warn);background:var(--warnbg)}
.p-bad{color:var(--bad);border-color:var(--bad);background:var(--badbg)}
pre.log{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.55;
  background:var(--surf);border:1px solid var(--line);border-radius:6px;padding:12px;
  max-height:340px;overflow:auto;margin:0;color:var(--ink2);white-space:pre-wrap;word-break:break-word}
.note{font-size:12.5px;color:var(--mut);line-height:1.5;margin:10px 0 0}
.msg{padding:11px 13px;border-radius:6px;font-size:13.5px;margin-bottom:12px}
.msg.ok{background:var(--okbg);border:1px solid var(--ok);color:var(--ok)}
.msg.bad{background:var(--badbg);border:1px solid var(--bad);color:var(--bad)}
.hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>KPs Laddstolpe</h1>
  <p class="sub" id="subtitle">Läser av…</p>

  <div class="tabs" role="tablist">
    <button class="tab" role="tab" aria-selected="true"  data-t="overview">Översikt</button>
    <button class="tab" role="tab" aria-selected="false" data-t="sessions">Sessioner</button>
    <button class="tab" role="tab" aria-selected="false" data-t="prices">Priser</button>
    <button class="tab" role="tab" aria-selected="false" data-t="charger">Laddbox</button>
    <button class="tab" role="tab" aria-selected="false" data-t="diag">Diagnostik</button>
  </div>

  <div class="panel on" data-p="overview" id="p-overview"></div>
  <div class="panel"    data-p="sessions" id="p-sessions"></div>
  <div class="panel"    data-p="prices"   id="p-prices"></div>
  <div class="panel"    data-p="charger"  id="p-charger"></div>
  <div class="panel"    data-p="diag"     id="p-diag"></div>
</div>

<script>
(function () {
  "use strict";
  var BASE = ${base};
  var D = null, msg = null, current = 'overview';

  function kr(n){ return Number(n||0).toFixed(2).replace('.',','); }
  function n1(n){ return Number(n||0).toFixed(1).replace('.',','); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function ts(iso){ return iso ? new Date(iso).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm'}) : '—'; }
  function hhmm(iso){ return iso ? new Date(iso).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'}) : '—'; }

  function api(path, body) {
    var opts = body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }
                    : { cache:'no-store' };
    return fetch(BASE + path, opts).then(function(r){
      return r.json().then(function(b){ return { ok:r.ok, body:b }; });
    });
  }

  function flash(kind, text){ msg = { kind:kind, text:text }; draw(); setTimeout(function(){ msg=null; draw(); }, 4000); }
  function msgHtml(){ return msg ? '<div class="msg '+msg.kind+'">'+esc(msg.text)+'</div>' : ''; }

  /* ---------------- Översikt ---------------- */
  function overview() {
    var s = D.snapshot, c = D.cert, p = D.prices, ses = D.active;
    var chargerOk = s.ok;
    var priceOk = p.haveToday;
    var certOk = c.ok;

    var h = msgHtml() + '<div class="h">Mår allt bra just nu?</div><div class="grid g2">';
    var modeLabel = { simulering:'Simulerad box', avlasning:'Easee, avlasning', skarp:'Easee, skarpt' }[D.mode] || D.mode;
    h += hc(chargerOk?'ok':'bad','Laddbox', chargerOk
        ? esc(modeLabel) + ' &middot; lage ' + s.opMode + ' &middot; ' + esc(D.opModeText)
        : esc(modeLabel) + ' &middot; ' + esc(s.error || 'Ingen kontakt'));
    if (D.easee) {
      var e = D.easee;
      var tokState = !e.hasToken ? 'bad' : (e.tokenMinutesLeft < 60 ? 'warn' : 'ok');
      h += hc(tokState, 'Easee-token', e.hasToken
        ? e.tokenMinutesLeft + ' min kvar &middot; ' + e.callsLastHour + ' anrop senaste timmen'
        : esc(e.lastError || 'Ingen token'));
    }
    h += hc(priceOk?'ok':'warn','Elpriser', priceOk
        ? (p.slotsToday + ' kvartar idag' + (p.haveTomorrow?', imorgon hämtad':', imorgon ej släppt än'))
        : 'Inga priser hämtade');
    h += hc(certOk?(c.daysLeft<14?'warn':'ok'):'bad','Certifikat', certOk
        ? esc(c.subject||'—') + ' · ' + c.daysLeft + ' dagar kvar'
        : esc(c.reason||'saknas'));
    h += hc('ok','Lagring','Senast skrivet ' + hhmm(D.storage.lastWrite) + ' · ' + D.historyCount + ' avslutade');
    h += '</div>';

    if (ses) {
      h += '<div class="h">Pågående laddning</div><div class="grid g3">'
        + kpi('Att betala', kr(ses.costSek), 'kr', true)
        + kpi('Laddat', n1(ses.energyKwh), 'kWh')
        + kpi('Effekt', n1(ses.powerKw), 'kW')
        + '</div><div class="card">'
        + row('Startad', ts(ses.startedAt))
        + row('Session', '#' + ses.number)
        + row('Kabelns löpnummer', '#' + (D.cable.episode||0))
        + (ses.usedEstimatedPrice ? row('Prisdata','<span class="pill p-warn">delvis uppskattad</span>') : '')
        + '</div><div class="btns"><button class="b danger" data-act="endsession">Avsluta sessionen</button></div>';
    } else {
      h += '<div class="h">Pågående laddning</div><div class="card"><div class="note" style="margin:0">Ingen laddning pågår.</div></div>';
    }
    return h;
  }

  function hc(state,t,s){ return '<div class="hc"><span class="dot '+state+'"></span><span><span class="t">'+esc(t)+'</span><br><span class="s">'+s+'</span></span></div>'; }
  function kpi(l,v,u,g){ return '<div class="kpi"><div class="l">'+esc(l)+'</div><div><span class="v'+(g?' g':'')+'">'+v+'</span><span class="u">'+esc(u)+'</span></div></div>'; }
  function row(l,v){ return '<div class="row"><span class="lab">'+esc(l)+'</span><span class="mono">'+v+'</span></div>'; }

  /* ---------------- Sessioner ---------------- */
  function sessionsPanel() {
    var h = msgHtml() + '<div class="h">Avslutade laddningar</div>';
    if (!D.history.length) return h + '<div class="card"><div class="note" style="margin:0">Inga avslutade laddningar ännu.</div></div>';
    h += '<div class="tw"><table><thead><tr><th>Nr</th><th>Slutade</th><th>kWh</th><th>Belopp</th><th>Orsak</th><th>Betalt</th></tr></thead><tbody>';
    D.history.forEach(function(s){
      var pill = s.payment==='CONFIRMED' ? '<span class="pill p-ok">Betald</span>'
               : s.payment==='GUEST_CLAIMS_PAID' ? '<span class="pill p-warn">Gästen anger betald</span>'
               : '<span class="pill p-bad">Obetald</span>';
      h += '<tr><td class="mono">#'+s.number+'</td><td class="mono">'+ts(s.endedAt)+'</td>'
        +  '<td class="mono">'+n1(s.energyKwh)+'</td><td class="mono">'+kr(s.costSek)+'</td>'
        +  '<td>'+esc(s.endReason||'')+'</td><td>'+pill
        +  (s.payment!=='CONFIRMED' ? ' <button class="b" style="padding:3px 8px;font-size:11.5px" data-act="paid" data-id="'+esc(s.id)+'">Bekräfta</button>' : '')
        +  '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* ---------------- Priser ---------------- */
  function pricesPanel() {
    var s = D.settings, p = D.priceNow;
    var h = msgHtml() + '<div class="h">Din självkostnad</div><div class="card">'
      + inp('supplierFeeSek','Elhandelspåslag','Tibber',s.supplierFeeSek,'kr')
      + inp('gridTransferSek','Nätavgift, rörlig','Lidköpings Elnät',s.gridTransferSek,'kr')
      + inp('energyTaxSek','Energiskatt','',s.energyTaxSek,'kr')
      + '</div><div class="h">Ditt påslag</div><div class="card">'
      + inp('serviceFeeSek','Avgift för stolpen','Visas som egen rad på kvittot',s.serviceFeeSek,'kr')
      + '</div><div class="btns"><button class="b gold" data-act="savesettings">Spara</button></div>';

    if (p) {
      h += '<div class="res"><div class="l">Vid elbörspris ' + kr(p.spotSek) + ' kr blir priset</div>'
        +  '<div class="v">' + kr(p.totalSek) + ' kr/kWh</div>'
        +  '<div class="s">Varav elkostnad ' + kr(p.energySek) + ' kr och avgift ' + kr(p.serviceSek) + ' kr.'
        +  (p.estimated ? '<br>Obs: uppskattat pris, elbörsen svarar inte.' : '') + '</div></div>';
    }
    h += '<p class="note">Momsen ligger inbakad i självkostnaden och nämns aldrig — varken här eller på kvittot.</p>';

    h += '<div class="h">Prisdata</div><div class="card">'
      + row('Prisområde', esc(D.prices.zone))
      + row('Dygn i cachen', D.prices.days.join(', ') || '—')
      + row('Kvartar idag', String(D.prices.slotsToday))
      + row('Morgondagens priser', D.prices.haveTomorrow ? 'hämtade' : 'ej släppta än')
      + row('Senast lyckad hämtning', ts(D.prices.lastFetchOk))
      + '</div><div class="btns"><button class="b" data-act="refreshprices">Hämta om priserna nu</button></div>';
    return h;
  }

  function inp(key,label,hint,val,unit){
    return '<div class="row"><span><span class="lab">'+esc(label)+'</span>'
      + (hint?'<div class="hint">'+esc(hint)+'</div>':'') + '</span>'
      + '<span><input class="inp" data-set="'+key+'" value="'+String(val).replace('.',',')+'"><span class="unit">'+esc(unit)+'</span></span></div>';
  }

  /* ---------------- Laddbox ---------------- */
  function chargerPanel() {
    var s = D.snapshot, st = D.settings;
    var h = msgHtml() + '<div class="h">Strömgräns</div><div class="card">'
      + inp('maxChargerCurrent','Max laddström','Sätts på alla faser samtidigt',st.maxChargerCurrent,'A')
      + inp('offlineMaxCurrent','Gräns om molnet tappas','Boxens egen reservgräns',st.offlineMaxCurrent,'A')
      + '</div><div class="btns"><button class="b gold" data-act="savesettings">Spara</button></div>';

    if (D.simulated) {
      h += '<div class="h">Simulerad laddbox</div>'
        + '<div class="card">'
        + row('Kabel', s.cableConnected ? 'ansluten' : 'urkopplad')
        + row('Driftläge', s.opMode + ' · ' + esc(D.opModeText))
        + row('Effekt', n1(s.powerKw) + ' kW')
        + row('Boxens sessionsräknare', n1(s.sessionEnergyKwh) + ' kWh')
        + '</div>'
        + '<div class="btns">'
        + '<button class="b" data-act="sim" data-cmd="plug">Sätt i kabeln</button>'
        + '<button class="b" data-act="sim" data-cmd="unplug">Dra ur kabeln</button>'
        + '<button class="b" data-act="sim" data-cmd="throttle">Strypa till 0 kW</button>'
        + '<button class="b" data-act="sim" data-cmd="unthrottle">Släpp på effekten</button>'
        + '<button class="b" data-act="sim" data-cmd="ff15">Spola fram 15 min</button>'
        + '<button class="b" data-act="sim" data-cmd="ff60">Spola fram 60 min</button>'
        + '</div>'
        + '<p class="note">Med de här knapparna testar du hela kedjan utan bil: sätt i kabeln, starta från gästsidan, spola fram tiden och se kostnaden räknas upp mot rätt kvartspris. "Strypa till 0 kW" härmar Equalizern — energin ska då sluta öka utan att sessionen avslutas.</p>';
    } else if (D.easee) {
      var e = D.easee;
      h += '<div class="h">Easee</div><div class="card">'
        + row('Lage', D.mode === 'avlasning' ? 'Avlasning — inga kommandon skickas' : 'Skarpt')
        + row('Laddbox-id', esc(e.chargerId || 'saknas'))
        + row('Equalizer-id', esc(e.equalizerId || '—'))
        + row('Token', e.hasToken ? e.tokenMinutesLeft + ' min kvar' : 'ingen')
        + row('Inloggningar', String(e.logins))
        + row('Tokenfornyelser', String(e.refreshes))
        + row('Anrop senaste timmen', String(e.callsLastHour))
        + (e.backoffUntil ? row('Vantar till', ts(e.backoffUntil)) : '')
        + (e.lastError ? row('Senaste fel', esc(e.lastError)) : '')
        + '</div>'
        + '<p class="note">Inloggningar ska vara ett litet tal och tokenfornyelser vaxa langsamt. Stiger inloggningarna i takt med tiden ar nagot fel — det var precis det monster som fick den gamla appen att riskera IP-sparr hos Easee.</p>';
    }
    return h;
  }

  /* ---------------- Diagnostik ---------------- */
  function diagPanel() {
    var s = D.snapshot;
    var h = msgHtml() + '<div class="h">Levande värden</div><div class="tw"><table><tbody>'
      + dr('cableConnected', String(s.cableConnected))
      + dr('opMode', s.opMode + ' · ' + esc(D.opModeText))
      + dr('powerKw', n1(s.powerKw) + ' kW')
      + dr('sessionEnergyKwh', n1(s.sessionEnergyKwh) + ' kWh')
      + dr('Kabelns löpnummer', '#' + (D.cable.episode||0))
      + dr('Läst', ts(s.readAt))
      + dr('Boxens temperatur', '<span style="color:var(--mut)">— läses inte</span>')
      + '</tbody></table></div>'
      + '<p class="note">Sista raden är avsiktlig. Den gamla appen visade 28,4 °C — en hårdkodad siffra. En diagnostikvy som visar påhittade värden är sämre än ingen alls.</p>';

    h += '<div class="h">Systemet</div><div class="card">'
      + row('Version', esc(D.version))
      + row('Node', esc(D.node))
      + row('Arkitektur', esc(D.arch))
      + row('Tidszon', esc(D.tz))
      + row('Uppe sedan', esc(D.uptime))
      + row('Certifikat', D.cert.ok ? esc(D.cert.subject) + ' · ' + D.cert.daysLeft + ' dagar' : esc(D.cert.reason))
      + row('Datamapp', esc(D.dataDir))
      + '</div>';

    h += '<div class="h">Gästsidans sökvägar</div><div class="card"><div class="mono" style="white-space:pre-wrap;line-height:1.7">'
      + esc(D.guestRoutes.join('\\n')) + '</div></div>'
      + '<p class="note">Hela listan över vad den publika servern kan svara på. Ingen adminväg finns med — det är inte ett lösenord som skyddar dem, de existerar helt enkelt inte här.</p>';

    if (D.easee) {
      h += '<div class="h">Ra API-inspektor</div><div class="btns">'
        + '<button class="b" data-act="raw" data-what="state">Laddarstatus</button>'
        + '<button class="b" data-act="raw" data-what="details">Detaljer</button>'
        + '<button class="b" data-act="raw" data-what="config">Konfiguration</button>'
        + '<button class="b" data-act="raw" data-what="equalizer">Equalizer</button>'
        + '<button class="b" data-act="raw" data-what="chargers">Mina laddboxar</button>'
        + '</div><pre class="log" id="rawOut">Valj vad du vill se. Svaret visas har, orort.</pre>';
    }

    h += '<div class="h">Logg</div><pre class="log">' + esc(D.log.map(function(l){
      return l.ts.replace('T',' ').slice(0,19) + '  ' + l.level.toUpperCase().padEnd(7) + l.message;
    }).join('\\n')) + '</pre>';
    return h;
  }

  function dr(k,v){ return '<tr><td>'+esc(k)+'</td><td class="mono">'+v+'</td></tr>'; }

  /* ---------------- ritning ---------------- */
  function draw() {
    if (!D) return;
    document.getElementById('subtitle').textContent =
      D.locationName + ' \u00b7 ' + ({ simulering:'simuleringslage', avlasning:'avlasningslage', skarp:'skarpt lage' }[D.mode] || D.mode) + ' \u00b7 fas 3';
    document.getElementById('p-overview').innerHTML = current==='overview' ? overview() : '';
    document.getElementById('p-sessions').innerHTML = current==='sessions' ? sessionsPanel() : '';
    document.getElementById('p-prices').innerHTML   = current==='prices'   ? pricesPanel()   : '';
    document.getElementById('p-charger').innerHTML  = current==='charger'  ? chargerPanel()  : '';
    document.getElementById('p-diag').innerHTML     = current==='diag'     ? diagPanel()     : '';
  }

  function load(){ return api('api/admin/state').then(function(r){ D = r.body; draw(); }); }

  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click', function(){
      current = t.dataset.t;
      document.querySelectorAll('.tab').forEach(function(x){ x.setAttribute('aria-selected', x===t?'true':'false'); });
      document.querySelectorAll('.panel').forEach(function(p){ p.classList.toggle('on', p.dataset.p===current); });
      draw();
    });
  });

  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;

    if (act === 'savesettings') {
      var patch = {};
      document.querySelectorAll('[data-set]').forEach(function(i){ patch[i.dataset.set] = i.value; });
      api('api/admin/settings', patch).then(function(r){
        if (!r.ok) return flash('bad', r.body.error || 'Kunde inte spara.');
        flash('ok','Sparat.'); load();
      });
    } else if (act === 'sim') {
      api('api/admin/sim', { cmd: b.dataset.cmd }).then(function(r){
        if (!r.ok) return flash('bad', r.body.error || 'Kommandot gick inte igenom.');
        load();
      });
    } else if (act === 'refreshprices') {
      api('api/admin/prices/refresh', {}).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Priser hämtade.':(r.body.error||'Misslyckades.')); load();
      });
    } else if (act === 'endsession') {
      api('api/admin/session/end', {}).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Sessionen avslutad.':(r.body.error||'Misslyckades.')); load();
      });
    } else if (act === 'raw') {
      var out = document.getElementById('rawOut');
      if (out) out.textContent = 'Hamtar...';
      api('api/admin/easee/raw', { what: b.dataset.what }).then(function(r){
        if (out) out.textContent = r.ok ? JSON.stringify(r.body.data, null, 2) : (r.body.error || 'Misslyckades.');
      });
    } else if (act === 'paid') {
      api('api/admin/session/payment', { id: b.dataset.id, state: 'CONFIRMED' }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Markerad som betald.':(r.body.error||'Misslyckades.')); load();
      });
    }
  });

  load();
  setInterval(function(){
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    var inspecting = current === 'diag' && document.getElementById('rawOut')
      && document.getElementById('rawOut').textContent.indexOf('{') === 0;
    if (!typing && !inspecting) load();
  }, 5000);
})();
</script>
</body>
</html>`;
}

return { render };
})();

/* ========================================================================== */
/* 12  Rutter och uppstart                                                  */
/* ========================================================================== */

/**
 * KPs Laddstolpe — fas 2.
 *
 * Två lyssnare i samma process, med helt skilda rutt-tabeller:
 *
 *   Port 8443  Gästsidan.   Publik, ingen inloggning. Vidarebefordras i routern.
 *   Port 8099  Adminfliken. Endast via HA Ingress. Aldrig exponerad utåt.
 *
 * Adminvägarna registreras aldrig på gästroutern. Det är inte ett lösenord som
 * skyddar dem — de existerar helt enkelt inte i den servern, så det finns ingen
 * dörr att dyrka upp.
 */

const http = require('node:http');
const https = require('node:https');
const os = require('node:os');

const chargerFactory = chargerModule;
const { OP_MODE } = chargerModule;
const { Router, RateLimiter, makeHandler, sendJson, sendHtml, readJsonBody } = httpModule;

const VERSION = '0.3.0';
const GUEST_PORT = 8443;
const INGRESS_PORT = 8099;
const STARTED_AT = Date.now();

const limiter = new RateLimiter();
let charger = null;

/**
 * Startspärr. Sätts synkront innan något await hinner köras, så två samtidiga
 * tryck på "Starta laddning" inte kan skapa två sessioner på samma laddning.
 * Node kör en sats i taget, så en synkron flagga räcker — men bara om den sätts
 * före första await, inte efter.
 */
let startInFlight = false;

/* ------------------------------------------------------------------ */
/* Hjälpare                                                            */
/* ------------------------------------------------------------------ */

function normalizePhone(raw) {
  const clean = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^0[1-9]\d{7,10}$/.test(clean)) return '+46' + clean.slice(1);
  if (/^\+46[1-9]\d{7,10}$/.test(clean)) return clean;
  if (/^46[1-9]\d{7,10}$/.test(clean)) return '+' + clean;
  return null;
}

function uptimeText() {
  const s = Math.floor((Date.now() - STARTED_AT) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} dygn ${h} tim`;
  if (h) return `${h} tim ${m} min`;
  return `${m} min ${s % 60} s`;
}

/* ------------------------------------------------------------------ */
/* Gästroutern                                                         */
/* ------------------------------------------------------------------ */

const guest = new Router('guest');

guest.get('/healthz', (req, res) => {
  sendJson(res, 200, {
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    lastTick: loop.getLastTickAt(),
  });
});

guest.get('/', (req, res) => {
  sendHtml(res, 200, guestPage.render({ locationName: config.ha().location_name }));
});

guest.get('/api/status', (req, res) => {
  const snap = loop.getSnapshot();
  const active = sessions.getActive();
  const price = prices.currentPrice();

  let view = 'idle';
  let session = null;
  let busySince = null;

  if (!snap.ok) {
    view = 'offline';
  } else if (active) {
    // Gästen som startade sessionen och en förbipasserande ska se olika saker.
    // I fas 2 finns ingen inloggning ännu, så alla ser laddvyn. Från fas 5 knyts
    // vyn till det verifierade numret och andra får "upptagen".
    view = 'charging';
    session = sessions.publicView(active);
    busySince = active.startedAt;
  } else if (snap.cableConnected) {
    view = 'ready';
  }

  const mode = config.ha().mode;
  if (mode === 'avlasning' && view === 'ready') view = 'readonly';

  sendJson(res, 200, {
    view,
    session,
    busySince,
    price,
    mode,
    simulated: Boolean(snap.simulated),
    locationName: config.ha().location_name,
  });
});

guest.post('/api/start', async (req, res, ctx) => {
  // Spärren sätts först av allt, före varje await
  if (startInFlight) {
    return sendJson(res, 409, { error: 'En laddning håller på att startas. Försök igen om en stund.' });
  }
  if (sessions.getActive()) {
    return sendJson(res, 409, { error: 'Stolpen används just nu.' });
  }
  if (config.ha().mode === 'avlasning') {
    return sendJson(res, 503, {
      error: 'Laddstolpen är i avläsningsläge och kan inte startas härifrån än.',
    });
  }
  startInFlight = true;

  try {
    const rl = limiter.hit(`start:${ctx.ip}`, 5, 60 * 60 * 1000);
    if (!rl.allowed) {
      return sendJson(res, 429, { error: `För många försök. Vänta ${rl.retryAfterSec} sekunder.` });
    }

    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

    const phone = normalizePhone(parsed.body.phone);
    if (!phone) return sendJson(res, 400, { error: 'Kontrollera mobilnumret. Skriv det som 070 123 45 67.' });

    // Servern läser laddboxen på nytt. Vi litar aldrig på vad webbläsaren visade
    // — den kan ha stått öppen i en timme.
    const state = await charger.readState();
    if (!state.ok) return sendJson(res, 503, { error: 'Ingen kontakt med laddstolpen just nu.' });
    if (!state.cableConnected) return sendJson(res, 409, { error: 'Ingen kabel är ansluten till stolpen.' });
    if (sessions.getActive()) return sendJson(res, 409, { error: 'Stolpen används just nu.' });

    const started = sessions.start({
      phone,
      cableEpisode: loop.getCableState().episode,
      startEnergyKwh: state.sessionEnergyKwh,
      simulated: Boolean(state.simulated),
    });
    if (!started.ok) return sendJson(res, 409, { error: started.error });

    const cmd = await charger.start();
    if (!cmd.ok) {
      // Kommandot gick inte fram. Låtsas aldrig att en laddning startat.
      sessions.finish('start misslyckades');
      return sendJson(res, 502, { error: `Laddningen kunde inte startas: ${cmd.error}` });
    }
    await charger.setLocked(true);

    log.info(`Gäst startade session #${started.session.number} från ${ctx.ip}.`);
    await loop.tick();
    return sendJson(res, 200, { ok: true, session: sessions.publicView(sessions.getActive()) });
  } finally {
    startInFlight = false;
  }
});

guest.post('/api/stop', async (req, res, ctx) => {
  const active = sessions.getActive();
  if (!active) return sendJson(res, 409, { error: 'Ingen laddning pågår.' });

  const rl = limiter.hit(`stop:${ctx.ip}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) return sendJson(res, 429, { error: 'För många försök. Vänta en stund.' });

  await loop.tick();                    // sista avläsningen innan vi summerar
  const done = await loop.endSession('avslutad av gästen');
  return sendJson(res, 200, { ok: true, session: sessions.publicView(done) });
});

guest.get('/k/:key', (req, res, ctx) => {
  // Kvittosidan. Egen adress, ingen utgångstid, frikopplad från stolpens
  // nuvarande tillstånd — grannen ska se sitt kvitto även om någon annan laddar.
  const s = sessions.byReceiptKey(ctx.params.key);
  if (!s) return sendJson(res, 404, { error: 'Kvittot hittades inte.' });
  return sendJson(res, 200, { session: sessions.publicView(s) });
});

/* ------------------------------------------------------------------ */
/* Adminroutern                                                        */
/* ------------------------------------------------------------------ */

const admin = new Router('admin');

admin.get('/healthz', (req, res) => sendJson(res, 200, { status: 'ok', surface: 'admin' }));

admin.get('/', (req, res, ctx) => {
  sendHtml(res, 200, adminPage.render(ctx.ingressPrefix));
});

admin.get('/api/admin/state', (req, res) => {
  const snap = loop.getSnapshot();
  const active = sessions.getActive();
  sendJson(res, 200, {
    version: VERSION,
    locationName: config.ha().location_name,
    simulated: charger.kind === 'simulerad',
    node: process.version,
    arch: `${process.platform}/${process.arch}`,
    tz: process.env.TZ || 'ej satt',
    uptime: uptimeText(),
    dataDir: store.DATA_DIR,
    hostname: os.hostname(),

    snapshot: snap,
    mode: config.ha().mode,
    easee: charger.stats ? charger.stats() : null,
    opModeText: OP_MODE[snap.opMode] || 'okänt',
    cable: loop.getCableState(),
    cert: tls.status(),
    prices: prices.status(),
    priceNow: prices.currentPrice(),
    settings: config.settings(),

    active: active ? { ...sessions.publicView(active), startedAt: active.startedAt } : null,
    history: sessions.getHistory(60),
    historyCount: sessions.getHistory(9999).length,
    storage: { lastWrite: new Date().toISOString() },

    guestRoutes: guest.list(),
    log: log.recent(150),
  });
});

admin.post('/api/admin/settings', async (req, res) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const result = config.updateSettings(parsed.body);
  if (!result.ok) return sendJson(res, 400, { error: result.error });

  if (charger.setMaxCurrent) await charger.setMaxCurrent(config.settings().maxChargerCurrent);
  return sendJson(res, 200, { ok: true, settings: result.settings });
});

admin.post('/api/admin/prices/refresh', async (req, res) => {
  await prices.refresh({ force: true });
  return sendJson(res, 200, { ok: true, prices: prices.status() });
});

admin.post('/api/admin/session/end', async (req, res) => {
  if (!sessions.getActive()) return sendJson(res, 409, { error: 'Ingen laddning pågår.' });
  await loop.tick();
  const done = await loop.endSession('avslutad från admin');
  return sendJson(res, 200, { ok: true, session: sessions.publicView(done) });
});

admin.post('/api/admin/session/payment', async (req, res) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const result = sessions.setPayment(parsed.body.id, parsed.body.state);
  if (!result.ok) return sendJson(res, 400, { error: result.error });
  return sendJson(res, 200, { ok: true });
});

admin.post('/api/admin/easee/raw', async (req, res) => {
  if (!charger.raw) {
    return sendJson(res, 400, { error: 'Inspektören fungerar bara när en riktig Easee är inkopplad.' });
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const out = await charger.raw(String(parsed.body.what || 'state'));
  if (!out.ok) return sendJson(res, 502, { error: out.error });
  return sendJson(res, 200, { ok: true, data: out.data });
});

admin.post('/api/admin/sim', async (req, res) => {
  if (charger.kind !== 'simulerad') {
    return sendJson(res, 400, { error: 'Simulatorknapparna fungerar bara i simuleringsläge.' });
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

  const cmd = String(parsed.body.cmd || '');
  let out;
  switch (cmd) {
    case 'plug': out = charger.plugIn(); break;
    case 'unplug': out = charger.unplug(); break;
    case 'throttle': out = charger.setThrottled(true); break;
    case 'unthrottle': out = charger.setThrottled(false); break;
    case 'ff15': out = charger.fastForward(15); sessions.shiftStartBack(15); break;
    case 'ff60': out = charger.fastForward(60); sessions.shiftStartBack(60); break;
    default: return sendJson(res, 400, { error: `Okänt kommando: ${cmd}` });
  }
  if (!out.ok) return sendJson(res, 409, { error: out.error });

  await loop.tick();
  return sendJson(res, 200, { ok: true });
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  log.info(`KPs Laddstolpe ${VERSION} startar.`);

  const ha = config.loadHaOptions();
  config.loadSettings();

  const MODE_TEXT = {
    simulering: 'SIMULERINGSLÄGE — virtuell laddbox',
    avlasning: 'AVLÄSNINGSLÄGE — riktig Easee, men inga kommandon skickas',
    skarp: 'SKARPT LÄGE — riktig Easee med kommandon',
  };
  log.info(`Plats: ${ha.location_name} · Prisområde: ${ha.price_zone}`);
  log.info(MODE_TEXT[ha.mode] || `Okänt läge: ${ha.mode}`);

  sessions.load();
  prices.loadCache();

  charger = chargerFactory.create(ha.mode, {
    username: ha.easee_username,
    password: ha.easee_password,
    chargerId: ha.easee_charger_id,
    equalizerId: ha.easee_equalizer_id,
  });
  // Strömgränsen skickas bara i lägen där vi faktiskt får skriva
  if (ha.mode !== 'avlasning') {
    await charger.setMaxCurrent(config.settings().maxChargerCurrent);
  }
  loop.init(charger);

  await prices.refresh({ force: true });

  /* --- lyssnare A: gästsidan --- */
  const cert = tls.load(ha);
  const guestHandler = makeHandler(guest, { surface: 'guest' });
  let guestServer;

  if (cert.ok) {
    guestServer = https.createServer({ cert: cert.cert, key: cert.key }, guestHandler);
    tls.watch(guestServer, ha);
  } else {
    guestServer = http.createServer(guestHandler);
    log.warn(`Startar gästsidan UTAN HTTPS. ${cert.reason}`);
  }

  guestServer.on('error', (err) => { log.error(`Gästsidan kunde inte starta: ${err.message}`); process.exit(1); });
  guestServer.listen(GUEST_PORT, '0.0.0.0', () => {
    log.info(`Gästsidan lyssnar på ${cert.ok ? 'https' : 'http'}://0.0.0.0:${GUEST_PORT}`);
  });

  /* --- lyssnare B: adminfliken --- */
  const adminServer = http.createServer(makeHandler(admin, { surface: 'admin' }));
  adminServer.on('error', (err) => { log.error(`Adminfliken kunde inte starta: ${err.message}`); process.exit(1); });
  adminServer.listen(INGRESS_PORT, '0.0.0.0', () => {
    log.info(`Adminfliken lyssnar på http://0.0.0.0:${INGRESS_PORT} (endast via Ingress)`);
  });

  loop.start();

  const shutdown = (signal) => {
    log.info(`${signal} mottagen. Sparar och stänger av.`);
    loop.stop();
    sessions.flush();
    guestServer.close();
    adminServer.close();
    setTimeout(() => process.exit(0), 400);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => {
    log.error(`Ohanterat fel: ${(err && err.stack) || err}`);
  });
}

main().catch((err) => {
  log.error(`Kunde inte starta: ${err.stack || err.message}`);
  process.exit(1);
});
