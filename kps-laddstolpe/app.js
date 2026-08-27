'use strict';

/* ============================================================================
 *
 *  KPs Laddstolpe — Home Assistant-tillägg
 *  Fas 3: skarp Easee, endast avläsning
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
  sms_username: '',
  sms_password: '',
  sms_sender: 'KPsLadd',
  swish_number: '',
  swish_name: '',
  public_host: '',
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
  // Av som standard: boxar med permanent kabellås sköter det själva, och då
  // gör våra kommandon bara skada.
  lockCableDuringSession: false,
  // På som standard: stolpen ska stå avstängd när ingen laddar, annars kan vem
  // som helst koppla in sig utan att gå via appen.
  disableWhenIdle: true,

  // Numret ska vara ett bevis, inte ett textfält. Stäng bara av vid felsökning.
  requireVerification: true,

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

  if ('requireVerification' in patch) {
    next.requireVerification = patch.requireVerification === true || patch.requireVerification === 'true';
  }

  if ('disableWhenIdle' in patch) {
    next.disableWhenIdle = patch.disableWhenIdle === true || patch.disableWhenIdle === 'true';
  }

  if ('lockCableDuringSession' in patch) {
    next.lockCableDuringSession = patch.lockCableDuringSession === true
      || patch.lockCableDuringSession === 'true';
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
  0: 'Offline',
  1: 'Urkopplad',
  2: 'Kabel ansluten, väntar',
  3: 'Laddar',
  4: 'Färdigladdad',
  5: 'Fel',
  6: 'Redo att ladda',
  7: 'Väntar på godkännande',
  8: 'Loggar ut',
};

/**
 * Easees kod för varför strömmen är begränsad, i klartext.
 *
 * Numret säger allt men bara till den som har tabellen framför sig. Din box
 * rapporterade kod 28 mitt under laddning — det betyder "begränsad av
 * Equalizern", alltså precis den lastbalansering appen finns för att räkna
 * rätt på. Det är värt att kunna läsa direkt.
 *
 * Källa: developer.easee.com/docs/enumerations
 */
const NO_CURRENT_REASON = {
  0: 'Allt normalt',
  1: 'Lastbalansering: kretsens ström räcker inte',
  2: 'Lastbalansering: dynamisk kretsström för låg',
  3: 'Lastbalansering: reservström vid frånkoppling för låg',
  4: 'Lastbalansering: kretsens säkring för liten',
  5: 'Lastbalansering: står i kö för tilldelad effekt',
  6: 'Lastbalansering: står i kö bland färdigladdade',
  7: 'Fel: ogiltig nättyp',
  8: 'Fel: huvudenheten väntar på strömbegäran',
  9: 'Fel: ingen kontakt med huvudenheten',
  10: 'Equalizerns ström räcker inte',
  11: 'Fel: fas inte ansluten',
  25: 'Begränsad av kretsens säkring',
  26: 'Begränsad av kretsens maxström',
  27: 'Begränsad av dynamisk kretsström',
  28: 'Begränsad av Equalizern',
  29: 'Begränsad av kretsens lastbalansering',
  30: 'Begränsad av inställningar för frånkopplat läge',
  50: 'Lastbalansering: sekundär enhet inaktiv',
  51: 'Lastbalansering: laddarens ström för låg',
  52: 'Lastbalansering: dynamisk laddarström för låg',
  53: 'Laddaren är avstängd',
  54: 'Väntar på schemalagd laddning',
  55: 'Väntar på godkännande',
  56: 'Fel: laddaren i feltillstånd',
  57: 'Fel: bilen beter sig oväntat',
  75: 'Begränsad av kabelns märkström',
  76: 'Begränsad av schema',
  77: 'Begränsad av laddarens maxström',
  78: 'Begränsad av dynamisk laddarström',
  79: 'Bilen laddar inte',
  80: 'Egen inställd gräns, eller bilen rampar upp',
  81: 'Begränsad av bilen',
  100: 'Okänt fel',
};

/**
 * Sitter kabeln i?
 *
 * Specifikationen sa att Easee returnerar `isCableConnected`. Det gör den inte —
 * åtminstone inte för den här boxen och firmware 343. Fältet saknas helt i
 * svaret, och min första version läste därför alltid av "false" mitt under
 * pågående laddning. I avläsningsläge var det bara en felaktig rad i
 * diagnostiken. I skarpt läge hade bakgrundsloopen avslutat varje session efter
 * en minut, eftersom "kabeln urkopplad två avläsningar i rad" hade varit sant
 * hela tiden.
 *
 * Driftläget är det tillförlitliga svaret. 0 betyder att boxen är offline och
 * säger ingenting om kabeln — då behåller vi det vi trodde förut hellre än att
 * gissa fel.
 */
function cableFromState(d, previous) {
  if (typeof d.isCableConnected === 'boolean') return d.isCableConnected;
  const op = Number(d.chargerOpMode);
  if (op === 0) return previous === undefined ? false : previous;
  return op >= 2;
}

/* ------------------------------------------------------------------ */
/* Simulerad laddbox                                                   */
/* ------------------------------------------------------------------ */

class SimulatedCharger {
  constructor() {
    this.cableConnected = false;
    this.charging = false;
    this.locked = false;
    this.enabled = true;   // laddaren påslagen; false = stolpen låst
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
    this.enabled = s.enabled === undefined ? true : Boolean(s.enabled);
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
      enabled: this.enabled,
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
      lockedPermanently: false,
      maxCurrent: this.maxCurrent,
      allocatedCurrent: this.throttled ? 0 : this.maxCurrent,
      phaseCurrents: { l1: null, l2: null, l3: null, n: null },
      eqAvailable: { l1: null, l2: null, l3: null },
      voltage: null,
      deratingActive: this.throttled,
      // 53 = "Laddaren är avstängd", samma kod en riktig box skickar
      reasonForNoCurrent: this.enabled ? null : 53,
      enabled: this.enabled,
      errorCode: 0,
      online: true,
      cloud: true,
      wifiRssi: null,
      firmware: null,
      latestPulse: new Date().toISOString(),
      simulated: true,
    };
  }

  async start() {
    this._advance();
    if (!this.cableConnected) return { ok: false, error: 'Ingen kabel ansluten.' };
    if (!this.enabled) {
      // Precis som en riktig box: kommandot kvitteras, men ingenting händer.
      log.warn('[Simulator] Laddaren är avstängd. Startkommandot får ingen effekt.');
      return { ok: true };
    }
    this.charging = true;
    this._persist();
    log.info('[Simulator] Laddning startad.');
    return { ok: true };
  }

  async stop() {
    this._advance();
    // "Boxen hänger sig": kommandot kvitteras men ingenting händer. Det är det
    // otäckaste felet i hela appen — strömmen går men vi slutar räkna — och det
    // går inte att framkalla på en riktig box, så simulatorn får göra det.
    if (this.stuck) {
      log.warn('[Simulator] Stoppkommandot kvitteras men boxen fortsätter ladda.');
      return { ok: true };
    }
    this.charging = false;
    this._persist();
    log.info('[Simulator] Laddning stoppad.');
    return { ok: true };
  }

  setStuck(on) {
    this.stuck = Boolean(on);
    log.info(`[Simulator] Boxen ${this.stuck ? 'vägrar nu stanna' : 'lyder igen'}.`);
    return { ok: true };
  }

  async setLocked(locked) {
    this.locked = Boolean(locked);
    this._persist();
    return { ok: true };
  }

  async setEnabled(enabled) {
    this._advance();
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.charging = false;
    this._persist();
    log.info(`[Simulator] Laddaren ${this.enabled ? 'påslagen' : 'avstängd'}.`);
    return { ok: true };
  }

  async resume() {
    this._advance();
    if (!this.enabled || !this.cableConnected) return { ok: true };
    this.charging = true;
    this._persist();
    log.info('[Simulator] Laddning återupptagen.');
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

  noteCommand(entry) {
    this.commandLog = this.commandLog || [];
    this.commandLog.push({ t: new Date().toISOString(), ...entry });
    if (this.commandLog.length > 100) this.commandLog.shift();
  }

  stats() {
    return {
      chargerId: 'simulerad',
      equalizerId: null,
      readOnly: false,
      hasToken: true,
      tokenMinutesLeft: null,
      callsLastHour: 0,
      logins: 0,
      refreshes: 0,
      backoffUntil: null,
      lastError: null,
      commandLog: (this.commandLog || []).slice(-25).reverse(),
    };
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

// Tidsgränsen var 15 sekunder. Din box har behövt 17 bara på att återuppta en
// laddning, och ett svar som kommer på artonde sekunden är inte ett haveri.
const EASEE_TIMEOUT_MS = 25 * 1000;
const READ_BACKOFF_MAX_MS = 2 * 60 * 1000;    // "inte just nu" — molnfel, tidsgräns
const HARD_BACKOFF_MAX_MS = 30 * 60 * 1000;   // "sluta fråga" — 429, nekad inloggning

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
    this.backoffHard = false;
    this.lastReadMs = null;   // hur länge senaste avläsningen tog
    this.lastLoginAt = 0;
    this.lastError = null;
    this.calls = [];        // tidsstämplar, för anropsräknaren
    this.logins = 0;
    this.refreshes = 0;
    this.commandLog = [];   // varje kommando som skickats, med utfall

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

  /**
   * Två backoffar, inte en.
   *
   * Den hårda finns för att skydda kontot: svarar Easee 429, eller nekar
   * inloggningen, är det enda rimliga att sluta fråga en lång stund. Att hamra
   * vidare är precis så man blir avstängd.
   *
   * Den mjuka gäller sådant som bara betyder "inte just nu" — ett 502 från
   * molnet, eller ett svar som inte hann fram innan tidsgränsen. Att stänga av
   * avläsningen i en halvtimme för det är fel: det är just avläsningen som
   * skulle ha visat att felet gått över, och under tiden står gästen framför en
   * skärm som säger att stolpen inte svarar. Taket är två minuter.
   */
  _backoff(reason, { hard = false } = {}) {
    this.backoffStep = Math.min(this.backoffStep + 1, 6);
    const base = hard ? 60 * 1000 : 15 * 1000;
    const cap = hard ? HARD_BACKOFF_MAX_MS : READ_BACKOFF_MAX_MS;
    const wait = Math.min(base * Math.pow(2, this.backoffStep - 1), cap);
    this.backoffUntil = Date.now() + wait;
    this.backoffHard = hard;
    log.warn(`[Easee] ${reason}. Väntar ${Math.round(wait / 1000)} sekunder innan nästa försök.`);
  }

  _ok() { this.backoffStep = 0; this.backoffUntil = 0; this.backoffHard = false; this.lastError = null; }

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
        this._backoff('Inloggningen nekades', { hard: true });
        return { ok: false, error: this.lastError };
      }
      this.lastError = `Inloggningen misslyckades (${res.status}).`;
      // Nätverksfel och molnfel är övergående; 429 är det inte.
      this._backoff(`Inloggningen misslyckades (${res.status})`, { hard: res.status === 429 });
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
      // waiting: vi FRÅGADE inte. Det är inte samma sak som att frågan gick
      // fel, och bakgrundsloopen ska inte räkna det som ett misslyckande.
      return { ok: false, waiting: true, retryInSeconds: left, error: `Väntar ${left} sekunder efter tidigare fel mot Easee.` };
    }
    if (this.token && Date.now() < this.expiresAt) return { ok: true };
    if (this.token && this.refreshToken) return this._refresh();
    return this._login();
  }

  /* ---------------- anrop ---------------- */

  async _fetch(url, opts) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, EASEE_TIMEOUT_MS);
    this.calls.push(Date.now());
    if (this.calls.length > 500) this.calls = this.calls.slice(-500);
    const t0 = Date.now();
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      let data = null;
      try { data = await r.json(); } catch (_) { /* tomt svar är i sin ordning */ }
      return { ok: r.ok, status: r.status, data, ms: Date.now() - t0 };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        ms: Date.now() - t0,
        timedOut,
        netError: timedOut ? `svarade inte inom ${EASEE_TIMEOUT_MS / 1000} sekunder` : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Autentiserat anrop med ett omförsök om token hunnit dö. */
  async _api(path, { method = 'GET', body = null, retry = true } = {}) {
    const auth = await this._ensureToken();
    if (!auth.ok) return { ok: false, error: auth.error, waiting: auth.waiting, retryInSeconds: auth.retryInSeconds };

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
      this._backoff('Easee svarade 429, för många anrop', { hard: true });
      return { ok: false, error: 'Easee begränsar antalet anrop just nu.' };
    }
    if (res.status >= 500 || res.status === 0) {
      this._backoff(res.status === 0 ? `Easee ${res.netError}` : `Easee svarade ${res.status}`);
      return {
        ok: false,
        error: res.timedOut ? 'Easee svarade inte i tid.' : 'Ingen kontakt med Easee just nu.',
      };
    }

    this.lastError = `Easee svarade ${res.status} på ${path}`;
    return { ok: false, error: this.lastError };
  }

  /* ---------------- gränssnittet ---------------- */

  async readState() {
    if (!this.chargerId) {
      return { ok: false, error: 'Laddbox-id saknas i tilläggets konfiguration.' };
    }
    const t0 = Date.now();
    const res = await this._api(`/chargers/${encodeURIComponent(this.chargerId)}/state`);
    if (!res.ok) {
      if (!res.waiting) this.lastReadMs = Date.now() - t0;
      return { ok: false, error: res.error, waiting: res.waiting, retryInSeconds: res.retryInSeconds };
    }
    this.lastReadMs = Date.now() - t0;
    if (this.lastReadMs > 5000) {
      log.debug(`[Easee] Avläsningen tog ${(this.lastReadMs / 1000).toFixed(1)} sekunder.`);
    }

    const d = res.data || {};
    const cable = cableFromState(d, this._lastCable);
    this._lastCable = cable;

    return {
      ok: true,
      cableConnected: cable,
      opMode: Number(d.chargerOpMode) || 0,
      powerKw: Number(d.totalPower) || 0,
      sessionEnergyKwh: Number(d.sessionEnergy) || 0,
      lifetimeEnergyKwh: Number(d.lifetimeEnergy) || 0,
      locked: Boolean(d.cableLocked),
      lockedPermanently: Boolean(d.lockCablePermanently),

      // Vad boxen FAR dra kontra vad den faktiskt tilldelats just nu.
      // Skillnaden mellan de tva ar lastbalanseringen i en enda siffra.
      maxCurrent: Number(d.dynamicChargerCurrent) || 0,
      allocatedCurrent: Number(d.outputCurrent) || 0,

      phaseCurrents: {
        l1: numOrNull(d.circuitTotalPhaseConductorCurrentL1),
        l2: numOrNull(d.circuitTotalPhaseConductorCurrentL2),
        l3: numOrNull(d.circuitTotalPhaseConductorCurrentL3),
        n: numOrNull(d.inCurrentT2),
      },
      eqAvailable: {
        l1: numOrNull(d.eqAvailableCurrentP1),
        l2: numOrNull(d.eqAvailableCurrentP2),
        l3: numOrNull(d.eqAvailableCurrentP3),
      },
      voltage: numOrNull(d.voltage),
      deratingActive: Boolean(d.deratingActive),
      reasonForNoCurrent: numOrNull(d.reasonForNoCurrent),
      errorCode: numOrNull(d.errorCode),
      online: d.isOnline !== undefined ? Boolean(d.isOnline) : null,
      cloud: d.connectedToCloud !== undefined ? Boolean(d.connectedToCloud) : null,
      wifiRssi: numOrNull(d.wiFiRSSI),
      firmware: numOrNull(d.chargerFirmware),
      latestPulse: d.latestPulse || null,

      simulated: false,
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

  /**
   * Slår på eller stänger av laddaren.
   *
   * Det här är låset på stolpen. Står den avstängd kan ingen ladda, oavsett vad
   * de kopplar in — och det är hela poängen med en stolpe i ett stugområde.
   * Easee vill ha både inställningen och kommandot; inställningen är det som
   * består, kommandot är det som slår igenom direkt.
   */
  async setEnabled(enabled) {
    if (this.readOnly) return this._blocked();
    const id = encodeURIComponent(this.chargerId);

    const setting = await this._api(`/chargers/${id}/settings`, {
      method: 'POST',
      body: { enabled: Boolean(enabled) },
    });

    const cmd = await this._api(
      `/chargers/${id}/commands/${enabled ? 'enable_charger' : 'disable_charger'}`,
      { method: 'POST', body: {} },
    );

    if (!setting.ok && !cmd.ok) {
      return { ok: false, error: setting.error || cmd.error };
    }
    return { ok: true };
  }

  /** För en laddning som pausats eller väntar på godkännande. */
  async resume() {
    if (this.readOnly) return this._blocked();
    const r = await this._api(
      `/chargers/${encodeURIComponent(this.chargerId)}/commands/resume_charging`,
      { method: 'POST', body: {} },
    );
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

  /** Varje kommando som skickas hamnar här, så du kan granska i efterhand. */
  noteCommand(entry) {
    this.commandLog.push({ t: new Date().toISOString(), ...entry });
    if (this.commandLog.length > 100) this.commandLog.shift();
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
      backoffSeconds: this.backoffUntil > Date.now() ? Math.round((this.backoffUntil - Date.now()) / 1000) : 0,
      backoffHard: Boolean(this.backoffHard),
      lastReadMs: this.lastReadMs,
      lastError: this.lastError,
      commandLog: this.commandLog.slice(-25).reverse(),
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
/** Skiljer ett verkligt nollvarde fran ett falt som saknas. */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function create(mode, opts) {
  if (mode === 'simulering') return new SimulatedCharger();
  return new EaseeCharger({ ...opts, readOnly: mode === 'avlasning' });
}

return { create, OP_MODE, NO_CURRENT_REASON, SimulatedCharger, EaseeCharger };
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
    // En session sparad av en äldre version saknar fälten. Utan detta kraschar
    // första varvet efter uppdateringen, mitt i någons laddning.
    if (!Array.isArray(active.unpriced)) active.unpriced = [];
    if (typeof active.unpricedKwh !== 'number') active.unpricedKwh = 0;
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

    // Energi som mätts upp men ännu inte kunnat prissättas, med tidpunkt, så
    // att den kan prissättas mot RÄTT kvart när prisdata kommer.
    unpriced: [],
    unpricedKwh: 0,
  };

  activeWriter.save(active, { immediate: true });
  log.info(`Session ${active.number} startad${phone ? ` för ${maskPhone(phone)}` : ''}.`);
  return { ok: true, session: active };
}

/** Lägger en uppmätt mängd energi till kostnaden, till ett givet pris. */
function charge(kwh, price) {
  active.costEnergySek = round(active.costEnergySek + kwh * price.energySek, 4);
  active.costServiceSek = round(active.costServiceSek + kwh * price.serviceSek, 4);
  active.costSek = round(active.costEnergySek + active.costServiceSek, 2);
  if (price.estimated) active.usedEstimatedPrice = true;
}

/**
 * Prissätter energi som mätts upp medan prisdata saknades.
 *
 * Varje post bär tidpunkten då energin togs ut, och `prices.currentPrice(ms)`
 * slår upp den kvart som gällde just då. Kommer priserna tillbaka senare på
 * dygnet blir kostnaden alltså densamma som om de aldrig varit borta. Går en
 * post fortfarande inte att prissätta får den ligga kvar och prövas nästa varv.
 */
function settleUnpriced() {
  const kvar = [];
  let settled = 0;

  for (const chunk of active.unpriced) {
    const p = prices.currentPrice(chunk.at);
    if (!p) { kvar.push(chunk); continue; }
    charge(chunk.kwh, p);
    settled += chunk.kwh;
  }

  if (settled > 0) {
    active.unpriced = kvar;
    active.unpricedKwh = round(Math.max(0, active.unpricedKwh - settled), 3);
    log.info(`Prissatte ${round(settled, 3)} kWh i efterhand mot priserna som gällde när energin togs ut.`);
  }
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

  if (deltaKwh > 0) {
    // Mätvärdet är ett faktum och skrivs alltid fram. Förut skedde det bara om
    // ett pris fanns, så saknades prisdata stod räknaren stilla — och när
    // priset kom tillbaka debiterades hela mellanrummet till priset i det
    // ögonblicket, i stället för till priserna som gällde när strömmen gick.
    active.energyKwh = round(total, 3);

    if (price) {
      charge(deltaKwh, price);
    } else {
      // Spara mängden MED tidpunkt. Prissätts i efterhand mot rätt kvart.
      active.unpriced.push({ at: Date.now(), kwh: round(deltaKwh, 4) });
      active.unpricedKwh = round(active.unpricedKwh + deltaKwh, 3);
      // Ett tak så att filen inte växer om priserna är borta i timmar. Slås
      // äldsta posterna ihop förloras bara kvartsupplösningen, aldrig energin.
      if (active.unpriced.length > 400) {
        const old = active.unpriced.splice(0, 200);
        const sum = old.reduce((a, c) => a + c.kwh, 0);
        active.unpriced.unshift({ at: old[0].at, kwh: round(sum, 4) });
      }
    }
  }

  // Har priserna kommit tillbaka? Betala av skulden mot rätt kvart.
  if (price && active.unpriced.length) settleUnpriced();

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

  // Sista chansen att prissätta det som mätts upp utan pris.
  if (active.unpriced && active.unpriced.length) {
    settleUnpriced();
    if (active.unpriced.length) {
      log.warn(`Session ${active.number}: ${active.unpricedKwh} kWh kunde inte prissättas — `
        + 'appen har ingen prisdata alls för den perioden. Energin står på kvittot, kostnaden för den gör det inte.');
    }
  }

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
    // Energi som är uppmätt men ännu inte prissatt. Noll i normalfallet.
    unpricedKwh: round(s.unpricedKwh || 0, 2),
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
const TICK_WATCHED_MS = 10 * 1000;   // någon har gästsidan öppen just nu
const TICK_BUSY_MS = 30 * 1000;      // laddning pågår, ingen tittar
const TICK_IDLE_MS = 5 * 60 * 1000;  // viloläge — men aldrig helt tyst
const TICK_WAKE_MS = 700;            // gäst kom till sidan medan loopen sov
const PRICE_REFRESH_MS = 15 * 60 * 1000;
const IDLE_FINISH_MS = 20 * 60 * 1000; // färdigladdad och 0 kW så länge -> avsluta

/**
 * När slutar "senast kända läge" vara ett svar och blir en gissning?
 *
 * Tidigare räckte EN misslyckad avläsning för att gästsidan skulle säga "ingen
 * kontakt med laddstolpen", och det satt kvar tills en avläsning lyckades —
 * vilket i viloläge var minst fem minuter bort. Nu visas det vi vet, med
 * åldern utskriven, och larmet kommer först när det verkligen är tyst.
 */
const STALE_MS = 90 * 1000;          // äldre än så: visa åldern för gästen
const OFFLINE_MS = 4 * 60 * 1000;    // äldre än så: säg att kontakten är borta
const OFFLINE_STRIKES = 4;           // eller så många misslyckade FÖRSÖK i rad

let charger = null;
let timer = null;

let snapshot = {
  ok: false,
  error: 'Ingen avläsning ännu.',
  cableConnected: false,
  opMode: 0,
  powerKw: 0,
  sessionEnergyKwh: 0,
  readAt: null,      // när uppgifterna VAR sanna — rörs aldrig av ett misslyckande
  failStreak: 0,
  waiting: false,
  triedAt: null,     // när vi senast försökte
};

let cableState = { episode: 0, connected: false };
let disconnectStrikes = 0;
let zeroPowerSince = null;
let lastPriceRefresh = 0;
let ticking = false;
let stopped = false;
let lastGuestPollAt = 0;
const WATCHER_WINDOW_MS = 60 * 1000;
let lastTickAt = null;
let lastGoodAt = 0;      // millisekunder, för åldersräkning utan Date.parse
let failStreak = 0;
let armedAt = 0;
let armedFor = 0;

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
      // Skilj på "vi frågade och fick fel" och "vi frågade inte, vi väntar".
      // Det andra är inget misslyckande och ska inte räknas som ett.
      if (!state.waiting) failStreak += 1;

      // readAt rörs INTE. Den ska fortsätta betyda "när uppgifterna var sanna",
      // annars ser en fem minuter gammal avläsning färsk ut i diagnostiken.
      snapshot = {
        ...snapshot,
        ok: false,
        error: state.error,
        waiting: Boolean(state.waiting),
        retryInSeconds: state.retryInSeconds || null,
        failStreak,
        triedAt: lastTickAt,
      };

      const age = lastGoodAt ? Math.round((Date.now() - lastGoodAt) / 1000) : null;
      const tail = age === null ? 'ingen lyckad avläsning ännu' : `senast lyckad för ${age} s sedan`;
      // Första miss loggas som debug. Blir det två i rad är det värt en varning.
      if (state.waiting || failStreak < 2) log.debug(`Ingen ny avläsning: ${state.error} (${tail}).`);
      else log.warn(`Kunde inte läsa laddboxen, ${failStreak} försök i rad: ${state.error} (${tail}).`);

      // Sessionen behålls med oförändrade värden. Ett avbrott i molnet får
      // aldrig innebära att en pågående laddning tappas bort.
      return;
    }

    if (failStreak > 0) log.info(`Kontakten med laddboxen är tillbaka efter ${failStreak} misslyckade försök.`);
    failStreak = 0;
    lastGoodAt = Date.now();

    // En rad per förändring, inte en rad per varv. Med debug påslaget blir det
    // en tidslinje man kan läsa: syns ingen rad när kabeln sätts i har boxen
    // inte berättat det, och då är det inte appen som sover.
    if (state.opMode !== snapshot.opMode || state.cableConnected !== snapshot.cableConnected) {
      log.debug(`Boxen ändrade sig: driftläge ${snapshot.opMode} -> ${state.opMode}, `
        + `kabel ${snapshot.cableConnected ? 'i' : 'ur'} -> ${state.cableConnected ? 'i' : 'ur'}, `
        + `${state.powerKw.toFixed(2)} kW.`);
    }
    snapshot = {
      ...state,
      error: null,
      waiting: false,
      retryInSeconds: null,
      failStreak: 0,
      readAt: lastTickAt,
      triedAt: lastTickAt,
    };
    trackCable(state);

    const active = sessions.getActive();
    if (!active) { disconnectStrikes = 0; zeroPowerSince = null; return; }

    if (await handleDisconnect(state)) return;

    const price = prices.currentPrice();
    if (!price) {
      // Löftet i den här raden var tomt förut: energin skrevs inte fram alls
      // utan pris. Nu sparas den med tidpunkt och prissätts mot rätt kvart.
      log.warn('Ingen prisdata tillgänglig. Energin mäts och sparas, och prissätts när priserna kommer.');
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
  // Enbart faktisk urkoppling räknas. Driftläge 2 gör det inte — det betyder
  // "kabel ansluten, väntar". Driftläge 0 betyder att boxen tappat kontakten
  // med molnet och säger ingenting alls om kabeln; att avsluta en laddning på
  // den grunden vore att straffa gästen för ett nätverksglapp.
  if (state.opMode === 0) { disconnectStrikes = 0; return false; }
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

/**
 * Avslutar den pågående sessionen. Idempotent: anropas den när ingen session
 * finns händer ingenting.
 *
 * I simuleringsläge var ett extra stoppkommando ofarligt. Från fas 4 går det
 * till den riktiga laddboxen, och då är ett kommando som skickas två gånger
 * både ett bortkastat API-anrop och en risk — det andra kan i värsta fall
 * stoppa en laddning som just startat.
 */
async function endSession(reason, { force = false } = {}) {
  if (!sessions.getActive()) {
    log.debug('endSession anropad utan pågående session. Ignorerar.');
    return null;
  }

  // Kabeln urkopplad? Då finns inget att stoppa — bilen är redan borta.
  const cableGone = loop.getSnapshot().cableConnected === false;

  if (!cableGone) {
    const stopped = await stopChargingSequence();

    // Fortfarande igång. Att avsluta sessionen nu vore att sluta räkna medan
    // strömmen går — gästen skulle ladda gratis och du betala för det. Bättre
    // att låta sessionen leva och säga som det är.
    if (!force && stopped.ok && stopped.verified === false) {
      log.error('Laddningen gick inte att stoppa. Sessionen hålls öppen och fortsätter räknas.');
      return { stopFailed: true };
    }
  }

  await applyCableLock(false);

  // Sista avläsningen innan vi låser, så energin är räknad.
  await loop.tick();
  const done = sessions.finish(reason);

  // Och så låset på igen. Stolpen ska stå avstängd mellan laddningarna.
  await lockPole();
  await loop.tick();   // så adminfliken visar det låsta läget direkt

  // Kvitto-SMS. Fastnar det får sessionen ändå sitt kvitto på webben, så vi
  // låter aldrig ett misslyckat SMS stoppa avslutet.
  if (done && done.phone) {
    sendReceiptSms(done).catch((err) => log.error(`Kvitto-SMS misslyckades: ${err.message}`));
  }

  return done;
}

async function refreshPricesIfDue() {
  const now = Date.now();
  if (now - lastPriceRefresh < PRICE_REFRESH_MS) return;
  lastPriceRefresh = now;
  await prices.refresh();
}

/**
 * Tre takter.
 *
 * Att någon står vid stolpen och tittar på skärmen är den situation där en
 * snabb avläsning gör verklig nytta. Resten av tiden ser ingen skillnaden, och
 * då är varje extra anrop mot Easee bortkastat.
 *
 * Att titta prövas FÖRST, oavsett om en laddning pågår. Förut låg villkoret
 * inuti "pågår en session?", vilket betydde att den snabba takten aldrig gällde
 * innan laddningen startat — alltså precis i det ögonblick gästen just satt i
 * kabeln och väntar på att skärmen ska ändra sig. Det var därför det kunde ta
 * minuter innan "sätt i kabeln" byttes ut.
 *
 * Kabelvillkoret frågar inte längre efter snapshot.ok. En misslyckad avläsning
 * ska inte sänka takten till fem minuter — det är just då vi vill försöka igen.
 */
function nextDelay() {
  if (isWatched()) return TICK_WATCHED_MS;
  if (sessions.getActive()) return TICK_BUSY_MS;
  if (snapshot.cableConnected) return TICK_BUSY_MS;
  if (failStreak > 0) return TICK_BUSY_MS;   // tappad kontakt: leta tillbaka den
  return TICK_IDLE_MS;
}

function isWatched() { return Date.now() - lastGuestPollAt < WATCHER_WINDOW_MS; }

function delayLabel(ms) {
  if (ms <= TICK_WAKE_MS) return 'gäst kom till sidan';
  if (ms === TICK_WATCHED_MS) return 'någon tittar';
  if (ms === TICK_BUSY_MS) return failStreak > 0 ? 'söker kontakt' : 'kabel i eller laddning';
  return 'viloläge';
}

/**
 * Gästen öppnade sidan. Utan det här registrerades bara tidpunkten, medan den
 * väntan som redan var igång löpte klart — upp till fem minuter. Nu kortas den.
 *
 * Bara övergången "ingen tittade" -> "någon tittar" väcker loopen, så en sida
 * som pollar var femte sekund kan inte framkalla mer än en extra avläsning per
 * minut, hur många gånger den än laddas om.
 */
function noteGuestPoll() {
  const arriving = !isWatched();
  lastGuestPollAt = Date.now();
  if (!arriving || stopped || ticking || !timer) return;

  const age = lastGoodAt ? Date.now() - lastGoodAt : Infinity;
  const want = age > TICK_WATCHED_MS ? TICK_WAKE_MS : TICK_WATCHED_MS;
  const left = armedFor - (Date.now() - armedAt);
  if (left <= want) return;

  log.debug(`Gäst öppnade sidan. Kortar väntan från ${Math.round(left / 1000)} s till ${(want / 1000).toFixed(1)} s.`);
  arm(want);
}

function cadence() {
  const ms = nextDelay();
  return {
    ms,
    label: delayLabel(ms),
    watched: isWatched(),
    failStreak,
    ageSeconds: lastGoodAt ? Math.round((Date.now() - lastGoodAt) / 1000) : null,
  };
}

function arm(ms) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  armedAt = Date.now();
  armedFor = ms;
  log.debug(`Nästa avläsning om ${(ms / 1000).toFixed(1)} s — ${delayLabel(ms)}.`);
  timer = setTimeout(async () => {
    await tick();
    schedule();
  }, ms);
  if (timer.unref) timer.unref();
}

function schedule() {
  if (stopped) return;
  arm(nextDelay());
}

/**
 * Ett gemensamt svar på "hur färsk är den här avläsningen", så att adminfliken
 * och gästsidan aldrig kan säga olika saker om samma ögonblicksbild. Förut
 * läste de olika fält ur den: gästen tittade på `ok`, diagnostiken på
 * `cableConnected`. Därför kunde diagnostiken visa "kabel ansluten" samtidigt
 * som gästen fick "ingen kontakt med laddstolpen".
 */
function contact() {
  const age = lastGoodAt ? Date.now() - lastGoodAt : null;
  const ageSeconds = age === null ? null : Math.round(age / 1000);

  if (age === null) {
    return { state: 'lost', ageSeconds: null, reason: snapshot.error || 'Ingen avläsning ännu.', retryInSeconds: snapshot.retryInSeconds || null };
  }
  if (snapshot.ok && age < STALE_MS) {
    return { state: 'ok', ageSeconds, reason: null, retryInSeconds: null };
  }
  // Larmet kräver BÅDE att uppgifterna hunnit bli gamla OCH att vi verkligen
  // försökt några gånger. Ett par snabba nej i rad från molnet ska inte räcka
  // — det är sekunder, och gästen märker det bara som en skärm som skriker.
  if (age > OFFLINE_MS || (failStreak >= OFFLINE_STRIKES && age > STALE_MS)) {
    return { state: 'lost', ageSeconds, reason: snapshot.error || null, retryInSeconds: snapshot.retryInSeconds || null };
  }
  return { state: 'stale', ageSeconds, reason: snapshot.error || null, retryInSeconds: snapshot.retryInSeconds || null };
}

function start() {
  if (timer) return;
  stopped = false;
  tick().then(schedule);
  log.info(`Bakgrundsloopen igång: ${TICK_WATCHED_MS / 1000} s när någon tittar, ${TICK_BUSY_MS / 1000} s under laddning, ${TICK_IDLE_MS / 60000} min i viloläge.`);
}

function stop() {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}

return {
  init, start, stop, tick, noteGuestPoll, cadence, contact,
  STALE_MS,
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
    mail:  '<svg viewBox="0 0 24 24" fill="none" stroke="#E2B144" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5h18v12H3zM3 7l9 6 9-6"/></svg>',
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
  // Vad som pagar just nu: null, 'start' eller 'stop'. Var tidigare en enkel
  // ja/nej-flagga, vilket gjorde att avsluta-knappen sa "Avslutar..." medan
  // laddningen fortfarande holl pa att starta.
  var busyAction = null;
  var notice = null;
  var lastKey = '';
  var receipt = null;
  var receivedAt = 0;
  var lagMs = 0;
  // Telefonen nadde inte servern. Ett HELT annat fel an att servern inte nar
  // laddboxen, och forut fick bada samma skarm och samma text.
  var netFail = false;

  // Verifieringen pagar: token och nummer mellan "skicka kod" och "skriv kod".
  //
  // De har SAKNADE deklaration i 0.5.0. En tilldelning skapade dem som globala
  // i efterhand, men render() LASER verifyToken varje varv sa fort kabeln sitter
  // i — och en lasning fore forsta tilldelningen kastar ReferenceError. Sidan
  // kraschade alltsa vid varje avlasning med kabeln i, och den gamla breda
  // felhanteringen ritade om det till "Ingen kontakt med laddstolpen".
  var verifyToken = null;
  var verifyPhone = null;

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

  /** "för 2 minuter sedan", i ord som går att läsa på en telefon i solsken. */
  function agoText(sec) {
    if (sec === null || sec === undefined) return 'nyss';
    if (sec < 90) return 'för ' + Math.max(5, Math.round(sec / 5) * 5) + ' sekunder sedan';
    var m = Math.round(sec / 60);
    return 'för ' + m + (m === 1 ? ' minut sedan' : ' minuter sedan');
  }

  /**
   * En diskret rad när uppgifterna börjat bli gamla. Förut fanns bara två
   * lägen: helt aktuellt, eller en varningstriangel. Det mellersta läget —
   * "vi vet vad som gällde nyss, men inte just nu" — är det vanligaste av dem
   * alla när molnet krånglar, och det är det som ska stå här.
   */
  function staleBlock(s) {
    if (!s || s.contact !== 'stale') return '';
    return '<div class="msg info">Uppgifterna är avlästa ' + esc(agoText(s.ageSeconds))
      + '. Vi försöker igen automatiskt.</div>';
  }

  /**
   * Fanns bara i adminfliken förut. Gästsidan hade escTel men ingen allmän
   * variant, och staleBlock anropade en esc som inte existerade här — vilket
   * är precis vad som gick sönder i 0.5.1.
   */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function netFailScreen() {
    el.live.className = 'live off';
    el.liveText.textContent = 'Ingen anslutning';
    el.icon.innerHTML = ICONS.warn; el.icon.style.display = '';
    el.title.textContent = 'Telefonen når inte appen';
    el.lead.textContent = 'Det ser ut som att mobilen tappat nätet. Laddningen påverkas inte — den fortsätter som den ska. Sidan hittar tillbaka av sig själv.';
    el.slot.innerHTML = '';
    el.foot.innerHTML = '';
  }

  /**
   * Går det fel när sidan ritas upp ska det synas som just det.
   *
   * I 0.5.1 låg ritningen inne i samma löfteskedja som hämtningen, så ett
   * programfel i vår egen kod hamnade i nätverkets felhantering och visades som
   * "Telefonen når inte appen". Då letar man efter fel på mobiltäckningen medan
   * felet sitter i appen. En felhanterare får aldrig ljuga om vad som gick fel.
   */
  function crashScreen(err) {
    try {
      el.live.className = 'live off';
      el.liveText.textContent = 'Fel i appen';
      el.icon.innerHTML = ICONS.warn; el.icon.style.display = '';
      el.title.textContent = 'Något gick fel i appen';
      el.lead.textContent = 'Sidan kunde inte ritas upp. Ladda om sidan. Pågår en laddning fortsätter den — den styrs inte härifrån.';
      el.slot.innerHTML = '<p style="text-align:center;font-size:13px;color:#93A39B;margin:0;word-break:break-word">'
        + esc(String(err && err.message ? err.message : err)) + '</p>';
      el.foot.innerHTML = '';
    } catch (_) { /* då är det illa nog ändå */ }
  }

  /** Ritar, och låter ett ritfel bli ett ritfel — inte ett nätverksfel. */
  function safeRender() {
    try {
      render();
    } catch (err) {
      if (window.console && console.error) console.error('Fel vid ritning av gästsidan:', err);
      reportClientError(err);
      crashScreen(err);
    }
  }

  /**
   * Skickar felet till tillägget så att det hamnar i din logg.
   *
   * Du kommer aldrig att öppna webbläsarens konsol på en gästs telefon. Utan
   * det här är ett fel i sidan osynligt för dig — appen "fungerar bara inte".
   */
  var lastReport = 0;
  function reportClientError(err) {
    if (Date.now() - lastReport < 60000) return;   // högst ett per minut
    lastReport = Date.now();
    try {
      fetch('api/clienterror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: String(err && err.message ? err.message : err).slice(0, 300),
          stack: String((err && err.stack) || '').slice(0, 600)
        })
      }).catch(function () { /* det får inte bli fel av att rapportera fel */ });
    } catch (_) { /* likaså */ }
  }

  function render() {
    // Att telefonen inte nar servern ar inte samma sak som att servern inte nar
    // laddboxen, och ska inte se ut som samma sak heller.
    if (netFail) { lastKey = 'netfail'; return netFailScreen(); }
    if (!state) return;
    var s = state;
    // Energin ingår medvetet INTE i nyckeln. Talen uppdateras av tickSmooth()
    // fyra gånger i sekunden; ritas hela vyn om i samma takt blinkar den och
    // hopfällbara avsnitt slår igen medan man läser dem.
    var key = [s.view, s.session && s.session.number, s.price && s.price.totalSek,
               notice && notice.text, busyAction, s.starting,
               s.contact, s.contact === 'ok' ? 0 : Math.round((s.ageSeconds || 0) / 15),
               receipt && receipt.number].join('|');

    // Rör inte DOM:en om inget ändrats — annars tappar man markören i textfältet
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (key === lastKey && typing) return;
    lastKey = key;

    var liveClass = 'live', liveText = 'Ledig';
    if (s.view === 'charging') { liveText = 'Laddar'; }
    else if (s.view === 'busy') { liveClass = 'live busy'; liveText = 'Upptagen'; }
    else if (s.view === 'ready') { liveText = 'Kabel ansluten'; }
    else if (s.view === 'readonly') { liveClass = 'live busy'; liveText = 'Avläsningsläge'; }
    else if (s.view === 'done') { liveClass = 'live busy'; liveText = 'Klar'; }
    else if (s.view === 'offline') { liveClass = 'live off'; liveText = 'Ingen kontakt'; }
    if (s.contact === 'stale' && s.view !== 'offline') { liveClass = 'live busy'; }
    el.live.className = liveClass;
    el.liveText.textContent = liveText;

    if (s.view === 'idle') {
      el.icon.innerHTML = ICONS.plug; el.icon.style.display = '';
      el.title.textContent = 'Sätt i laddkabeln';
      el.lead.textContent = 'Anslut kabeln till bilen och stolpen, så fortsätter det här av sig självt.';
      el.slot.innerHTML = noticeBlock() + staleBlock(s) + receiptBanner() + priceBlock(s.price, false);

    } else if (s.view === 'ready' && verifyToken) {
      el.icon.innerHTML = ICONS.mail; el.icon.style.display = '';
      el.title.textContent = 'Skriv koden från SMS:et';
      el.lead.innerHTML = 'Vi skickade en kod till<span class="tel">' + escTel(verifyPhone) + '</span>'
        + '<button class="linkish" id="changeTel">Fel nummer? Ändra</button>';
      el.slot.innerHTML = noticeBlock() +
        '<div class="field"><label for="code">Fyrsiffrig kod</label>' +
        '<input id="code" class="code" type="text" inputmode="numeric" maxlength="4" ' +
        'autocomplete="one-time-code" placeholder="0000"></div>' +
        '<button class="btn" id="codeBtn"' + (busyAction ? ' disabled' : '') + '>' +
        (busyAction === 'start' ? 'Startar…' : 'Starta laddning') + '</button>' +
        '<p style="text-align:center;font-size:14.5px;color:#A9BFB1;margin:16px 0 0;line-height:1.5">' +
        'Enklast är att trycka på länken i SMS:et — då startar laddningen direkt.</p>' +
        '<p style="text-align:center;font-size:14.5px;margin:14px 0 0">' +
        '<button class="linkish" id="resendBtn" style="color:#BFD2C6">Skicka koden igen</button></p>';

      var cb = document.getElementById('codeBtn');
      if (cb) cb.addEventListener('click', doCheckCode);
      var ct = document.getElementById('changeTel');
      if (ct) ct.addEventListener('click', function () {
        verifyToken = null; verifyPhone = null; lastKey = ''; setNotice(null, null);
      });
      var rb = document.getElementById('resendBtn');
      if (rb) rb.addEventListener('click', function () {
        var p = verifyPhone; verifyToken = null; doSendCode(p);
      });
      var ci = document.getElementById('code');
      if (ci) ci.focus();

    } else if (s.view === 'ready') {
      el.icon.innerHTML = ICONS.check; el.icon.style.display = '';
      el.title.textContent = 'Redo att ladda';
      el.lead.textContent = s.requireVerification
        ? 'Skriv ditt mobilnummer. Du får en kod via SMS, och kvittot skickas dit efteråt.'
        : 'Skriv ditt mobilnummer, så får du kvittot dit när du är klar.';
      el.slot.innerHTML = noticeBlock() + staleBlock(s) + receiptBanner() +
        '<div class="field"><label for="tel">Ditt mobilnummer</label>' +
        '<input id="tel" type="tel" inputmode="numeric" autocomplete="tel" placeholder="070 123 45 67"></div>' +
        '<button class="btn" id="startBtn"' + (busyAction ? ' disabled' : '') + '>' +
        (busyAction ? 'Skickar…' : (s.requireVerification ? 'Skicka kod' : 'Starta laddning')) + '</button>' +
        priceBlock(s.price, true);

      var btn = document.getElementById('startBtn');
      if (btn) btn.addEventListener('click', function () {
        var input = document.getElementById('tel');
        var phone = input ? input.value.trim() : '';
        if (!phone) { setNotice('err', 'Skriv ditt mobilnummer först.'); return; }
        if (s.requireVerification) doSendCode(phone); else doStart(phone);
      });

    } else if (s.view === 'charging') {
      var ses = s.session || {};
      var starting = s.starting || busyAction === 'start';
      el.icon.style.display = 'none';
      el.title.textContent = starting ? 'Startar laddningen' : 'Laddar';
      el.lead.textContent = starting
        ? 'Laddstolpen svarar. Det kan ta en halv minut innan bilen börjar dra ström.'
        : 'Du kan låsa mobilen och gå. Laddningen mäts vidare.';
      el.slot.innerHTML = noticeBlock() + staleBlock(s) +
        '<div class="runline">' + ICONS.bolt + 'Pågått i <span id="vDur">' + duration(ses.startedAt) + '</span></div>' +
        '<div class="stats">' +
          '<div class="stat wide"><div class="l">Att betala hittills</div><div><span class="v" id="vKr">' + kr(ses.costSek) + '</span><span class="u">kr</span></div></div>' +
          '<div class="stat"><div class="l">Laddat</div><div><span class="v" id="vKwh">' + num(ses.energyKwh, 2) + '</span><span class="u">kWh</span></div></div>' +
          '<div class="stat"><div class="l">Effekt</div><div><span class="v" id="vKw">' + num(ses.powerKw) + '</span><span class="u">kW</span></div></div>' +
        '</div>' +
        (s.price ? '<details><summary>Vad kostar det just nu?</summary><div class="dbody">' +
          '<div class="drow"><span>Priset denna kvart</span><span>' + kr(s.price.totalSek) + ' kr/kWh</span></div>' +
          '<div class="drow"><span>Varav elbörsen</span><span>' + kr(s.price.spotSek) + ' kr</span></div>' +
          '</div></details>' : '') +
        '<button class="btn stop" id="stopBtn" style="margin-top:14px"' + (busyAction || starting ? ' disabled' : '') + '>' +
        (busyAction === 'stop' ? 'Avslutar…' : (starting ? 'Väntar på laddboxen…' : 'Avsluta laddning')) + '</button>';

      var sb = document.getElementById('stopBtn');
      if (sb) sb.addEventListener('click', doStop);

    } else if (s.view === 'readonly') {
      el.icon.innerHTML = ICONS.check; el.icon.style.display = '';
      el.title.textContent = 'Kabeln är ansluten';
      el.lead.textContent = 'Appen läser av laddboxen men skickar inga kommandon än. Starta laddningen i Easee-appen så länge.';
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
        (d.unpricedKwh > 0 ? '<div class="msg info">' + num(d.unpricedKwh, 2) + ' kWh är ännu inte prissatta — appen saknar elpris för den perioden. Energin är mätt och står kvar.</div>' : '') +
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

      // Sag vad vi faktiskt vet: nar vi senast fick svar, och nar vi forsoker
      // igen. "Vi forsoker igen automatiskt" utan siffror ar ett lofte som inte
      // gar att kontrollera, och gasten star kvar och undrar hur lange.
      var lead = s.ageSeconds
        ? 'Appen fick senast svar från stolpen ' + agoText(s.ageSeconds) + '.'
        : 'Appen har inte fått något svar från stolpen.';
      if (s.retryInSeconds > 0) {
        lead += ' Nästa försök om ' + (s.retryInSeconds < 60
          ? s.retryInSeconds + ' sekunder'
          : Math.round(s.retryInSeconds / 60) + ' minuter') + '.';
      } else {
        lead += ' Vi försöker igen var trettionde sekund.';
      }
      lead += ' Ingen laddning kan startas förrän kontakten är tillbaka.';
      el.lead.textContent = lead;
      el.slot.innerHTML = noticeBlock() + receiptBanner();
    }

    if (s.mode === 'simulering') {
      el.foot.innerHTML = '<span class="simbadge">Simuleringsläge</span><br>Ingen riktig laddbox är inkopplad.';
    } else if (s.mode === 'avlasning') {
      el.foot.innerHTML = '<span class="simbadge">Avläsningsläge</span><br>Appen läser av laddboxen men styr den inte.';
    } else {
      el.foot.innerHTML = '';
    }
  }

  function setNotice(kind, text) {
    notice = text ? { kind: kind, text: text } : null;
    lastKey = '';
    safeRender();
  }

  /**
   * Tre fel som är tre olika saker, och hålls isär:
   *
   *   hämtningen  -> telefonen når inte appen
   *   avläsningen -> appen når inte laddboxen  (kommer via contact i svaret)
   *   ritningen   -> fel i appen
   *
   * Rejektionshanteraren ligger som ANDRA argument till .then, inte som ett
   * .catch efteråt. Skillnaden är hela poängen: ett .catch sist i kedjan
   * fångar även det som kastas i framgångsgrenen, och då blir varje programfel
   * rapporterat som ett nätverksfel.
   */
  function poll() {
    fetch('api/status', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('Servern svarade ' + r.status);
        return r.json();
      })
      .then(onStatus, onFetchFail);
  }

  function onFetchFail() {
    netFail = true;
    safeRender();
  }

  function onStatus(data) {
    try {
      netFail = false;
      state = data;
      if (data.startError) notice = { kind: 'err', text: data.startError };
      receivedAt = Date.now();
      // Hur gammal var avläsningen redan när servern svarade?
      lagMs = (data.readAt && data.serverTime)
        ? Math.max(0, Date.parse(data.serverTime) - Date.parse(data.readAt))
        : 0;

      if (data.session) { receipt = null; safeRender(); tickSmooth(); return; }

      // Kvittouppslaget har egen felhantering. Förut låg det i samma kedja, så
      // en miss där visade "ingen kontakt med laddstolpen" trots att
      // statusanropet gått bra.
      checkReceipt().then(safeRender, function () { receipt = null; safeRender(); });
    } catch (err) {
      if (window.console && console.error) console.error('Fel vid hantering av status:', err);
      reportClientError(err);
      crashScreen(err);
    }
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

    // Accept-huvudet ar inte valfritt har. Adressen svarar med JSON bara om man
    // ber om det, annars med kvittosidan i HTML — och da kastar r.json().
    // Utan det har visades kvittot aldrig av sig sjalvt, och i 0.5.0 hamnade
    // felet dessutom i natverkets felhantering: "Ingen kontakt med laddstolpen".
    return fetch('k/' + encodeURIComponent(saved.key), {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
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

  /**
   * Raknar vidare mellan avlasningarna sa siffrorna tickar jamnt.
   *
   * Laddboxen läses av var tionde sekund när någon tittar. Utan detta skulle
   * beloppet stå stilla och sedan hoppa — vilket både ser trasigt ut och får
   * folk att undra om mätningen fungerar. Vi vet effekten, så energin däremellan
   * går att räkna fram.
   *
   * Det här är enbart för ögat. Det som debiteras är alltid de riktiga
   * mätvärdena från laddboxen; den här uppskattningen når aldrig kvittot.
   */
  function tickSmooth() {
    if (!state || state.view !== 'charging' || !state.session) return;
    var ses = state.session;
    var kwEl = document.getElementById('vKw');
    if (!kwEl) return;

    var sinceMeasureMs = lagMs + (Date.now() - receivedAt);
    var extraKwh = (Number(ses.powerKw) || 0) * (sinceMeasureMs / 3600000);
    var estKwh = Number(ses.energyKwh) + extraKwh;
    var estKr = Number(ses.costSek) + (state.price ? extraKwh * state.price.totalSek : 0);

    var krEl = document.getElementById('vKr');
    var kwhEl = document.getElementById('vKwh');
    var durEl = document.getElementById('vDur');
    if (krEl) krEl.textContent = kr(estKr);
    if (kwhEl) kwhEl.textContent = num(estKwh, 2);
    kwEl.textContent = num(ses.powerKw);
    if (durEl) durEl.textContent = duration(ses.startedAt);
  }

  function receiptBanner() {
    if (!receipt || receipt.status !== 'COMPLETED') return '';
    return '<div class="msg info" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
      '<span>Du har en obetald laddning på ' + kr(receipt.costSek) + ' kr.</span>' +
      '<a href="#" id="openReceipt" style="color:#F3D082;white-space:nowrap;font-weight:600">Visa kvitto</a></div>';
  }

  function escTel(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** Steg 1: be servern skicka en kod. */
  function doSendCode(phone) {
    busyAction = 'code'; setNotice(null, null); lastKey = ''; safeRender();
    fetch('api/verify/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        busyAction = null;
        if (!res.ok) { setNotice('err', res.body.error || 'Koden kunde inte skickas.'); return; }
        verifyToken = res.body.token;
        verifyPhone = res.body.phone;
        lastKey = '';
        setNotice(res.body.simulated ? 'info' : null,
          res.body.simulated ? 'Simuleringsläge: koden står i adminfliken under SMS.' : null);
      })
      .catch(function () { busyAction = null; setNotice('err', 'Ingen kontakt med servern.'); });
  }

  /** Steg 2: skicka in koden och starta. */
  function doCheckCode() {
    var input = document.getElementById('code');
    var code = input ? input.value.trim() : '';
    if (code.length !== 4) { setNotice('err', 'Skriv de fyra siffrorna från SMS:et.'); return; }

    busyAction = 'start'; setNotice(null, null); lastKey = ''; safeRender();
    fetch('api/verify/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verifyToken, code: code })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) { busyAction = null; setNotice('err', res.body.error || 'Fel kod.'); return; }
        // Koden stämde. Nyckeln är förbrukad, så starten sker med en ny token
        // som servern redan bundit till numret.
        return doStart(null, verifyToken);
      })
      .catch(function () { busyAction = null; setNotice('err', 'Ingen kontakt med servern.'); });
  }

  function doStart(phone, token) {
    busyAction = 'start'; setNotice(null, null);
    fetch('api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token ? { token: token } : { phone: phone })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        busyAction = null;
        verifyToken = null; verifyPhone = null;
        if (!res.ok) { setNotice('err', res.body.error || 'Laddningen kunde inte startas.'); return; }
        if (res.body.session && res.body.session.receiptKey) {
          remember({ key: res.body.session.receiptKey, dismissed: false });
        }
        poll();
      })
      .catch(function () { busyAction = null; setNotice('err', 'Ingen kontakt med servern.'); });
  }

  function doStop() {
    busyAction = 'stop'; setNotice(null, null);
    fetch('api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        busyAction = null;
        if (!res.ok) { setNotice('err', res.body.error || 'Laddningen kunde inte avslutas.'); return; }
        poll();
      })
      .catch(function () { busyAction = null; setNotice('err', 'Ingen kontakt med servern.'); });
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
  setInterval(tickSmooth, 250);
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
    <button class="tab" role="tab" aria-selected="false" data-t="sms">SMS</button>
    <button class="tab" role="tab" aria-selected="false" data-t="charger">Laddbox</button>
    <button class="tab" role="tab" aria-selected="false" data-t="diag">Diagnostik</button>
  </div>

  <div class="panel on" data-p="overview" id="p-overview"></div>
  <div class="panel"    data-p="sessions" id="p-sessions"></div>
  <div class="panel"    data-p="prices"   id="p-prices"></div>
  <div class="panel"    data-p="sms"      id="p-sms"></div>
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
    var modeLabel = { simulering:'Simulerad box', avlasning:'Easee, avläsning', skarp:'Easee, skarpt' }[D.mode] || D.mode;
    h += hc(chargerOk?'ok':'bad','Laddbox', chargerOk
        ? esc(modeLabel) + ' &middot; läge ' + s.opMode + ' &middot; ' + esc(D.opModeText)
        : esc(modeLabel) + ' &middot; ' + esc(s.error || 'Ingen kontakt'));
    if (D.cadence) {
      h += hc('ok', 'Avläsningstakt', 'Var ' + (D.cadence.ms/1000) + ':e sekund &middot; ' + esc(D.cadence.label));
    }
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
        + (ses.unpricedKwh > 0 ? row('Väntar på pris','<span class="pill p-warn">' + n1(ses.unpricedKwh) + ' kWh</span>') : '')
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

  /* ---------------- SMS ---------------- */
  function smsPanel() {
    var x = D.sms, st = D.settings;
    var modes = [
      ['simulerat','Simulerat','Inget skickas. Kod och länk finns i loggen nedan.','0 kr'],
      ['dryrun','Torrkörning','Anropar 46elks med dryrun. Kontrollerar uppgifter och antal delar.','0 kr'],
      ['whitelist','Bara mina nummer','Skarpt till vitlistan. Allt annat simuleras.','Bara dina'],
      ['live','Skarpt','Normal drift. Alla mottagare får riktiga SMS.','Kostar']
    ];

    var h = msgHtml() + '<div class="h">Läge</div>';
    modes.forEach(function(m){
      var sel = x.mode === m[0];
      h += '<div class="card" style="cursor:pointer;' + (sel ? 'border-color:var(--gold)' : '') + '" data-act="smsmode" data-mode="' + m[0] + '">'
        + '<div class="row" style="border:0;padding:0"><span><span class="lab">'
        + (sel ? '● ' : '○ ') + esc(m[1]) + '</span><div class="hint">' + esc(m[2]) + '</div></span>'
        + '<span class="pill ' + (m[3]==='Kostar'?'p-bad':(m[3]==='Bara dina'?'p-warn':'p-ok')) + '">' + esc(m[3]) + '</span></div></div>';
    });

    h += '<div class="h">Tak och förbrukning</div><div class="grid g3">'
      + kpi('I dag', String(x.sentToday), '/ ' + x.maxPerDay)
      + kpi('Denna månad', String(x.sentMonth), 'st')
      + kpi('Delar totalt', String(x.partsTotal), 'st', true)
      + '</div>'
      + '<div class="card">'
      + inp('smsMaxPerDay','Tak per dygn','Nås det slutar appen skicka och larmar',st.smsMaxPerDay,'st')
      + inp('smsMaxPerHourPerNumber','Per nummer och timme','Hindrar att någon spammas',st.smsMaxPerHourPerNumber,'st')
      + inp('smsMaxPerHourPerIp','Per plats och timme','Kostnadsskydd nu när gästsidan är publik',st.smsMaxPerHourPerIp,'st')
      + '</div><div class="btns"><button class="b gold" data-act="savesettings">Spara</button></div>';

    h += '<div class="h">Vitlista</div><div class="card">'
      + '<div class="row"><span><span class="lab">Nummer som får skarpa SMS</span>'
      + '<div class="hint">Ett per rad. Gäller bara i läget "Bara mina nummer".</div></span></div>'
      + '<textarea class="ta" id="wl" style="width:100%;min-height:70px;font-family:ui-monospace,Menlo,monospace;'
      + 'font-size:13px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:8px">'
      + esc((x.whitelist||[]).join('\\n')) + '</textarea>'
      + '<div class="btns" style="margin-top:10px"><button class="b" data-act="savewl">Spara vitlista</button></div></div>';

    h += '<div class="h">Verifiering</div><div class="card">'
      + '<div class="row"><span><span class="lab">Kräv verifiering av mobilnummer</span>'
      + '<div class="hint">Utan detta är numret bara ett textfält. Stäng bara av vid felsökning.</div></span>'
      + '<span><button class="b" data-act="toggleverify">' + (st.requireVerification ? 'På' : 'Av') + '</button></span></div>'
      + row('Väntande koder', String(D.verify.pending))
      + '</div>';

    h += '<div class="h">Logg</div>';
    if (!D.smsLog.length) {
      h += '<div class="card"><div class="note" style="margin:0">Inga SMS ännu.</div></div>';
    } else {
      h += '<div class="tw"><table><thead><tr><th>Tid</th><th>Till</th><th>Typ</th><th>Läge</th><th>Delar</th><th></th></tr></thead><tbody>';
      D.smsLog.forEach(function(m, i){
        var pill = m.blocked ? '<span class="pill p-bad">stoppat</span>'
          : m.error ? '<span class="pill p-bad">fel</span>'
          : m.mode === 'simulerat' ? '<span class="pill p-ok">simulerat</span>'
          : m.mode === 'dryrun' ? '<span class="pill p-warn">torrkörning</span>'
          : '<span class="pill p-ok">skickat</span>';
        h += '<tr><td class="mono">' + hhmm(m.t) + '</td><td class="mono">' + esc(m.to) + '</td>'
          + '<td>' + esc(m.kind) + '</td><td>' + pill + '</td>'
          + '<td class="mono">' + (m.parts || '') + '</td>'
          + '<td>' + (m.text ? '<button class="b" style="padding:3px 8px;font-size:11.5px" data-act="showsms" data-i="' + i + '">Visa</button>' : esc(m.blocked || m.error || '')) + '</td></tr>';
        h += '<tr id="sms' + i + '" style="display:none"><td colspan="6" class="mono" style="white-space:pre-wrap;background:var(--surf2)">'
          + esc(m.text || '') + (m.extra && m.extra.link ? '\\n\\nLänk: ' + esc(m.extra.link) : '') + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '<p class="note">Loggen visar även de SMS bakgrundsloopen skickar när du inte tittar — den kedjan gick inte att testa i den gamla appen.</p>';

    h += '<div class="h">Uppgifter</div><div class="card">'
      + row('46elks inlagt', x.configured ? 'ja' : '<strong>nej — fyll i i tilläggets konfiguration</strong>')
      + row('Swish-nummer', D.swishConfigured ? 'inlagt' : '<strong>saknas</strong>')
      + row('Publik adress', esc(D.publicHost || '— sätt public_host, annars saknas kvittolänk i SMS'))
      + '</div>';
    return h;
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
        + '<button class="b" data-act="sim" data-cmd="disable">Stäng av stolpen</button>'
        + '<button class="b danger" data-act="sim" data-cmd="stuck">Boxen vägrar stanna</button>'
        + '<button class="b" data-act="sim" data-cmd="unstuck">Boxen lyder igen</button>'
        + '</div>'
        + '<p class="note">Med de här knapparna testar du hela kedjan utan bil: sätt i kabeln, starta från gästsidan, spola fram tiden och se kostnaden räknas upp mot rätt kvartspris. "Strypa till 0 kW" härmar Equalizern — energin ska då sluta öka utan att sessionen avslutas.</p>'
        + '<p class="note"><strong>"Boxen vägrar stanna"</strong> härmar det otäckaste felet: stoppkommandot kvitteras men strömmen fortsätter gå. Appen ska då <em>vägra</em> avsluta sessionen och fortsätta räkna, i stället för att skriva ett kvitto medan elen rinner. Tryck "Boxen lyder igen" för att släppa loss den.</p>';
    } else if (D.easee) {
      var e = D.easee;

      h += '<div class="h">Låset på stolpen</div><div class="card">'
        + '<div class="row"><span><span class="lab">Stäng av laddaren när ingen laddar</span>'
        + '<div class="hint">Stolpen står avstängd mellan laddningarna, så ingen kan koppla in sig '
        + 'utan att gå via appen. Appen slår på den automatiskt när någon startar.</div></span>'
        + '<span><button class="b" data-act="toggleidle">' + (D.settings.disableWhenIdle ? 'På' : 'Av') + '</button></span></div>'
        + '</div>';

      h += '<div class="h">Kabellås</div><div class="card">'
        + '<div class="row"><span><span class="lab">Lås kabeln under laddning</span>'
        + '<div class="hint">' + (D.snapshot.lockedPermanently
            ? 'Din box håller kabeln permanent låst av sig själv. Appen rör den inte.'
            : 'Av som standard. Boxar som låser själva mår bäst av att slippa våra kommandon.') + '</div></span>'
        + '<span><button class="b" data-act="togglelock">' + (D.settings.lockCableDuringSession ? 'På' : 'Av') + '</button></span></div>'
        + '</div>';

      if (D.mode === 'skarp') {
        h += '<div class="h">Manuell styrning</div>'
          + '<div class="btns">'
          + '<button class="b" data-act="cmd" data-cmd="disable">Lås stolpen</button>'
          + '<button class="b" data-act="cmd" data-cmd="enable">Lås upp stolpen</button>'
          + '<button class="b" data-act="cmd" data-cmd="lock">Lås kabel</button>'
          + '<button class="b" data-act="cmd" data-cmd="unlock">Lås upp kabel</button>'
          + '<button class="b" data-act="cmd" data-cmd="current">Skicka maxström</button>'
          + '<button class="b" data-act="cmd" data-cmd="stop">Stoppa laddning</button>'
          + '<button class="b gold" data-act="cmd" data-cmd="start">Starta laddning</button>'
          + '</div>'
          + '<p class="note">Varje kommando kontrolleras mot laddboxens faktiska tillstånd innan det räknas som lyckat. '
          + 'Pågår en gästladdning är start och stopp avstängda här — använd <em>Avsluta sessionen</em> på Översikt, annars blir kvittot fel.</p>';
      } else {
        h += '<div class="h">Manuell styrning</div><div class="card"><div class="note" style="margin:0">'
          + 'Avstängd i avläsningsläge. Byt <code>mode</code> till <code>skarp</code> i tilläggets konfiguration.'
          + '</div></div>';
      }

      h += '<div class="h">Easee</div><div class="card">'
        + row('Läge', D.mode === 'avlasning' ? 'Avläsning — inga kommandon skickas' : 'Skarpt')
        + row('Laddbox-id', esc(e.chargerId || 'saknas'))
        + row('Equalizer-id', esc(e.equalizerId || '—'))
        + row('Token', e.hasToken ? e.tokenMinutesLeft + ' min kvar' : 'ingen')
        + row('Inloggningar', String(e.logins))
        + row('Tokenförnyelser', String(e.refreshes))
        + row('Anrop senaste timmen', String(e.callsLastHour))
        + (e.backoffUntil ? row('Väntar till', ts(e.backoffUntil)) : '')
        + (e.lastError ? row('Senaste fel', esc(e.lastError)) : '')
        + '</div>'
        + (e.commandLog && e.commandLog.length
            ? '<div class="h">Skickade kommandon</div><div class="tw"><table><thead><tr><th>Tid</th><th>Kommando</th><th>Utfall</th></tr></thead><tbody>'
              + e.commandLog.map(function(c){
                  var pill = !c.ok ? '<span class="pill p-bad">gick inte fram</span>'
                    : c.verified === true ? '<span class="pill p-ok">bekräftat' + (c.seconds ? ' efter ' + c.seconds + ' s' : '') + '</span>'
                    : c.verified === false ? '<span class="pill p-warn">ej bekräftat</span>'
                    : '<span class="pill p-ok">skickat</span>';
                  return '<tr><td class="mono">' + hhmm(c.t) + '</td><td>' + esc(c.name) + '</td><td>' + pill
                    + (c.error ? ' <span style="color:var(--mut)">' + esc(c.error) + '</span>' : '') + '</td></tr>';
                }).join('')
              + '</tbody></table></div>'
            : '')
        + '<p class="note">Inloggningar ska vara ett litet tal och tokenförnyelser växa långsamt. Stiger inloggningarna i takt med tiden är något fel — det var precis det mönster som fick den gamla appen att riskera IP-spärr hos Easee.</p>';
    }
    return h;
  }

  /* ---------------- Diagnostik ---------------- */
  function diagPanel() {
    var s = D.snapshot;
    function v(x, unit, dec) {
      if (x === null || x === undefined) return '<span style="color:var(--mut)">—</span>';
      return (dec === 0 ? String(x) : Number(x).toFixed(dec === undefined ? 1 : dec).replace('.', ',')) + (unit ? ' ' + unit : '');
    }
    var pc = s.phaseCurrents || {}, eq = s.eqAvailable || {};

    // Adminfliken och gästsidan läser samma bedömning. Förut tittade gästen på
    // "lyckades senaste anropet" och diagnostiken rakt på värdena, så de kunde
    // säga olika saker om exakt samma ögonblicksbild.
    var c = D.contact || { state: 'ok', ageSeconds: null };
    var cText = c.state === 'ok'
      ? '<span style="color:#6FD39B">aktuell</span>'
      : (c.state === 'stale'
          ? '<strong style="color:#D8B978">inaktuell</strong> — senaste lyckade avläsning för ' + (c.ageSeconds || 0) + ' s sedan'
          : '<strong style="color:#E08B7A">ingen kontakt</strong>'
            + (c.ageSeconds === null ? '' : ' — senaste lyckade avläsning för ' + c.ageSeconds + ' s sedan'));
    if (c.reason) cText += '<br><span style="color:var(--mut)">' + esc(c.reason) + '</span>';

    var h = msgHtml() + '<div class="h">Laddning just nu</div><div class="tw"><table><tbody>'
      + dr('Avläsningen', cText)
      + dr('Driftläge', s.opMode + ' &middot; ' + esc(D.opModeText))
      + dr('Kabel ansluten', s.cableConnected ? 'ja' : 'nej')
      + dr('Stolpen', s.reasonForNoCurrent === 53 || s.enabled === false
            ? '<strong>avstängd — ingen kan ladda</strong>'
            : 'påslagen')
      + dr('Kabellås', s.locked ? (s.lockedPermanently ? 'låst, permanent låst i boxen' : 'låst') : 'olåst')
      + dr('Effekt', v(s.powerKw, 'kW', 2))
      + dr('Sessionsenergi', v(s.sessionEnergyKwh, 'kWh', 2))
      + dr('Livstidsenergi', v(s.lifetimeEnergyKwh, 'kWh', 2))
      + dr('Spänning', v(s.voltage, 'V', 1))
      + dr('Kabelns löpnummer', '#' + (D.cable.episode||0))
      + dr('Värdena avlästa', ts(s.readAt))
      + dr('Senaste försök', ts(D.lastTick))
      + dr('Takt just nu', esc((D.cadence.ms/1000) + ' s — ' + D.cadence.label))
      + '</tbody></table></div>';

    h += '<div class="h">Lastbalansering</div><div class="tw"><table><tbody>'
      + dr('Boxen får dra', v(s.maxCurrent, 'A', 0))
      + dr('Tilldelat just nu', v(s.allocatedCurrent, 'A', 0))
      + dr('Ström L1 / L2 / L3', v(pc.l1,'',2) + ' / ' + v(pc.l2,'',2) + ' / ' + v(pc.l3,'',2) + ' A')
      + dr('Ström nolledare', v(pc.n, 'A', 2))
      + dr('Equalizern tillåter', v(eq.l1,'',0) + ' / ' + v(eq.l2,'',0) + ' / ' + v(eq.l3,'',0) + ' A')
      + dr('Nedreglering aktiv', s.deratingActive ? 'ja' : 'nej')
      + dr('Strömbegränsning', s.reasonForNoCurrent === null || s.reasonForNoCurrent === undefined
            ? '<span style="color:var(--mut)">—</span>'
            : esc(D.noCurrentText) + ' <span style="color:var(--mut)">(kod ' + s.reasonForNoCurrent + ')</span>')
      + '</tbody></table></div>'
      + '<p class="note">Skillnaden mellan <em>får dra</em> och <em>tilldelat just nu</em> är lastbalanseringen i en enda siffra. '
      + 'Är en fasström nära noll laddar bilen på två faser, och då bär nolledaren returströmmen — därför kan den ligga högt även när en fas är tyst.</p>';

    h += '<div class="h">Boxens hälsa</div><div class="tw"><table><tbody>'
      + dr('Online', s.online === null || s.online === undefined ? '<span style="color:var(--mut)">—</span>' : (s.online ? 'ja' : 'nej'))
      + dr('Ansluten till molnet', s.cloud === null || s.cloud === undefined ? '<span style="color:var(--mut)">—</span>' : (s.cloud ? 'ja' : 'nej'))
      + dr('Wi-Fi', v(s.wifiRssi, 'dBm', 0))
      + dr('Firmware', v(s.firmware, '', 0))
      + dr('Felkod', s.errorCode === null || s.errorCode === undefined ? '<span style="color:var(--mut)">—</span>' : String(s.errorCode))
      + dr('Senaste pulsslag', ts(s.latestPulse))
      + '</tbody></table></div>'
      + '<p class="note">Alla rader kommer från ett faktiskt svar. Fanns inget värde står det streck. '
      + 'Den gamla appen visade 28,4 grader som boxtemperatur — en hårdkodad siffra. Easee rapporterar ingen temperatur alls, så raden finns inte längre.</p>';

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
      D.locationName + ' \u00b7 ' + ({ simulering:'simuleringsläge', avlasning:'avläsningsläge', skarp:'skarpt läge' }[D.mode] || D.mode) + ' \u00b7 fas 3';
    document.getElementById('p-overview').innerHTML = current==='overview' ? overview() : '';
    document.getElementById('p-sessions').innerHTML = current==='sessions' ? sessionsPanel() : '';
    document.getElementById('p-prices').innerHTML   = current==='prices'   ? pricesPanel()   : '';
    document.getElementById('p-sms').innerHTML      = current==='sms'      ? smsPanel()      : '';
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
    } else if (act === 'smsmode') {
      api('api/admin/settings', { smsMode: b.dataset.mode }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Läget ändrat.':(r.body.error||'Kunde inte spara.')); load();
      });
    } else if (act === 'savewl') {
      var t = document.getElementById('wl');
      var list = t.value.split('\\n').map(function(x){ return x.trim(); }).filter(Boolean);
      api('api/admin/settings', { smsWhitelist: list }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Vitlistan sparad.':(r.body.error||'Kunde inte spara.')); load();
      });
    } else if (act === 'toggleverify') {
      api('api/admin/settings', { requireVerification: !D.settings.requireVerification }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Sparat.':(r.body.error||'Kunde inte spara.')); load();
      });
    } else if (act === 'showsms') {
      var row = document.getElementById('sms' + b.dataset.i);
      if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
    } else if (act === 'toggleidle') {
      api('api/admin/settings', { disableWhenIdle: !D.settings.disableWhenIdle }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Sparat.':(r.body.error||'Kunde inte spara.')); load();
      });
    } else if (act === 'togglelock') {
      api('api/admin/settings', { lockCableDuringSession: !D.settings.lockCableDuringSession }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Sparat.':(r.body.error||'Kunde inte spara.')); load();
      });
    } else if (act === 'cmd') {
      var what = b.dataset.cmd;
      var texts = { start:'Starta laddningen nu?', stop:'Stoppa laddningen nu?',
                    enable:'Låsa upp stolpen? Då kan vem som helst ladda utan att gå via appen.',
                    disable:'Låsa stolpen? Ingen kan ladda förrän den låses upp.',
                    lock:'Låsa kabeln?', unlock:'Låsa upp kabeln?',
                    current:'Skicka maxströmmen till laddboxen?' };
      if (!window.confirm(texts[what] + '\\n\\nKommandot går till din riktiga laddbox.')) return;
      b.disabled = true; b.textContent = 'Skickar…';
      api('api/admin/command', { cmd: what }).then(function(r){
        if (!r.ok) return flash('bad', r.body.error || 'Kommandot gick inte fram.');
        flash('ok', r.body.verified === false
          ? 'Kommandot togs emot, men boxen har inte ändrat tillstånd än.'
          : 'Klart.');
        load();
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
/* 13  SMS                                                                    */
/* ========================================================================== */

const sms = (function () {

/**
 * SMS via 46elks, med fyra lägen och tak som gäller i alla.
 *
 * Den gamla appen läste läget ur webbläsarens förfrågan. Det betydde att en
 * klient kunde skicka `virtualSmsMode: false` och tvinga fram skarpa utskick
 * även när simulering var påslaget i admin. Här läses läget ENBART ur serverns
 * egen konfiguration.
 *
 *   simulerat   inget skickas, allt hamnar i loggen
 *   dryrun      anropar 46elks med dryrun, validerar utan att skicka
 *   whitelist   skarpt till dina egna nummer, simulerat till alla andra
 *   live        normal drift
 */

const ENDPOINT = 'https://api.46elks.com/a1/sms';
const LOG_MAX = 200;

let log_ = [];
let counters = { day: '', sentToday: 0, month: '', sentMonth: 0, parts: 0 };
const perNumber = new httpModule.RateLimiter();
const perIp = new httpModule.RateLimiter();

/* ---------------- teckenräkning ---------------- */

// GSM 03.38, grundtabellen. Svenska å ä ö ingår och kostar ingenting extra.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Tecken som ryms men kostar två platser
const GSM_EXTENDED = '^{}\\[~]|€';

/**
 * Hur många SMS blir texten?
 *
 * Ett enda tecken utanför GSM-tabellen gör om HELA meddelandet till UCS-2, och
 * då sjunker gränsen från 160 tecken till 70. Ett typografiskt apostrof eller
 * ett tankstreck som smugit in i en mall kan alltså tredubbla kostnaden för
 * varje utskick — vilket är den troligaste förklaringen till att testningen
 * blev dyr.
 */
function measure(text) {
  const t = String(text || '');
  let units = 0;
  let gsm = true;

  for (const ch of t) {
    if (GSM_BASIC.includes(ch)) { units += 1; continue; }
    if (GSM_EXTENDED.includes(ch)) { units += 2; continue; }
    gsm = false;
    break;
  }

  if (!gsm) {
    // UCS-2: räkna kodenheter, inte tecken (emoji tar två)
    units = 0;
    for (let i = 0; i < t.length; i++) units += 1;
    const parts = units <= 70 ? 1 : Math.ceil(units / 67);
    return { encoding: 'UCS-2', units, parts, limit: units <= 70 ? 70 : 67, offenders: nonGsmChars(t) };
  }

  const parts = units <= 160 ? 1 : Math.ceil(units / 153);
  return { encoding: 'GSM-7', units, parts, limit: units <= 160 ? 160 : 153, offenders: [] };
}

function nonGsmChars(t) {
  const bad = new Set();
  for (const ch of t) {
    if (!GSM_BASIC.includes(ch) && !GSM_EXTENDED.includes(ch)) bad.add(ch);
  }
  return Array.from(bad).slice(0, 10);
}

/* ---------------- räknare ---------------- */

function today() { return prices.localDateKey(Date.now()); }
function thisMonth() { return today().slice(0, 7); }

function loadCounters() {
  const raw = store.readJson('sms.json', null);
  if (raw && typeof raw === 'object') counters = { ...counters, ...raw };
  rollover();
}

function rollover() {
  if (counters.day !== today()) { counters.day = today(); counters.sentToday = 0; }
  if (counters.month !== thisMonth()) { counters.month = thisMonth(); counters.sentMonth = 0; }
}

function saveCounters() { store.writeJsonNow('sms.json', counters); }

/* ---------------- logg ---------------- */

function note(entry) {
  log_.push({ t: new Date().toISOString(), ...entry });
  if (log_.length > LOG_MAX) log_.shift();
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length > 5 ? `${s.slice(0, 6)}…${s.slice(-2)}` : '…';
}

/* ---------------- utskick ---------------- */

/**
 * @param {object} opts
 *   to      mottagare i E.164
 *   text    meddelandet
 *   kind    'verifiering' | 'kvitto' | 'påminnelse' | 'test'
 *   ip      gästens IP, för takräkningen. Utelämnas för serverns egna utskick.
 *   extra   sparas i loggen, till exempel kod och länk
 */
async function send({ to, text, kind = 'övrigt', ip = null, extra = null }) {
  rollover();

  const cfg = config.settings();
  const mode = cfg.smsMode;
  const m = measure(text);

  /* --- taken gäller i ALLA lägen, även simulerat ---------------------------
     Skälet är att taken ska vara testade när de behövs. Ett tak som bara
     finns i skarpt läge är ett tak ingen provat.                          */

  if (counters.sentToday >= cfg.smsMaxPerDay) {
    const err = `Dygnstaket för SMS är nått (${cfg.smsMaxPerDay}).`;
    log.error(`[SMS] ${err} Skickar inget mer i dag.`);
    note({ kind, to: maskPhone(to), mode, blocked: err, parts: m.parts });
    return { ok: false, error: err, blocked: true };
  }

  const byNumber = perNumber.hit(`sms:${to}`, cfg.smsMaxPerHourPerNumber, 3600 * 1000);
  if (!byNumber.allowed) {
    const err = 'För många SMS till det numret den senaste timmen.';
    note({ kind, to: maskPhone(to), mode, blocked: err, parts: m.parts });
    return { ok: false, error: err, blocked: true };
  }

  if (ip) {
    const byIp = perIp.hit(`smsip:${ip}`, cfg.smsMaxPerHourPerIp, 3600 * 1000);
    if (!byIp.allowed) {
      const err = 'För många försök från samma plats. Vänta en stund.';
      note({ kind, to: maskPhone(to), mode, blocked: err, parts: m.parts });
      return { ok: false, error: err, blocked: true };
    }
  }

  /* --- vilket läge gäller för just det här numret? ----------------------- */

  const whitelisted = (cfg.smsWhitelist || []).some((w) => normalize(w) === to);
  let effective = mode;
  if (mode === 'whitelist') effective = whitelisted ? 'live' : 'simulerat';

  if (effective === 'simulerat') {
    counters.sentToday += 1; counters.sentMonth += 1; counters.parts += m.parts;
    saveCounters();
    note({ kind, to: maskPhone(to), mode: 'simulerat', text, parts: m.parts, encoding: m.encoding, extra, ok: true });
    log.info(`[SMS] Simulerat ${kind} till ${maskPhone(to)} (${m.parts} del${m.parts > 1 ? 'ar' : ''}).`);
    return { ok: true, simulated: true, parts: m.parts };
  }

  /* --- skarpt eller torrkörning ----------------------------------------- */

  const user = (config.ha().sms_username || '').trim();
  const pass = (config.ha().sms_password || '').trim();
  const from = (config.ha().sms_sender || 'KPsLadd').trim().slice(0, 11);

  if (!user || !pass) {
    const err = '46elks-uppgifter saknas i tilläggets konfiguration.';
    note({ kind, to: maskPhone(to), mode: effective, blocked: err, parts: m.parts });
    return { ok: false, error: err };
  }

  const body = new URLSearchParams({ from, to, message: text });
  if (effective === 'dryrun') body.set('dryrun', 'yes');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (_) { /* 46elks svarar text vid fel */ }

    if (!res.ok) {
      const err = `46elks svarade ${res.status}: ${raw.slice(0, 200)}`;
      log.error(`[SMS] ${err}`);
      note({ kind, to: maskPhone(to), mode: effective, text, parts: m.parts, encoding: m.encoding, error: err });
      return { ok: false, error: 'SMS:et kunde inte skickas.' };
    }

    counters.sentToday += 1; counters.sentMonth += 1; counters.parts += m.parts;
    saveCounters();

    note({
      kind, to: maskPhone(to), mode: effective, text,
      parts: (data && data.parts) || m.parts,
      encoding: m.encoding,
      cost: data && (data.cost !== undefined ? data.cost : data.estimated_cost),
      status: data && data.status,
      id: data && data.id,
      extra, ok: true,
    });

    log.info(`[SMS] ${effective === 'dryrun' ? 'Torrkörning' : 'Skickat'} ${kind} till ${maskPhone(to)} (${m.parts} del${m.parts > 1 ? 'ar' : ''}).`);
    return { ok: true, dryrun: effective === 'dryrun', parts: m.parts, data };
  } catch (err) {
    log.error(`[SMS] Nätverksfel: ${err.message}`);
    note({ kind, to: maskPhone(to), mode: effective, error: err.message, parts: m.parts });
    return { ok: false, error: 'Ingen kontakt med SMS-tjänsten.' };
  } finally {
    clearTimeout(timer);
  }
}

function normalize(raw) {
  const clean = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^0[1-9]\d{7,10}$/.test(clean)) return '+46' + clean.slice(1);
  if (/^\+46[1-9]\d{7,10}$/.test(clean)) return clean;
  if (/^46[1-9]\d{7,10}$/.test(clean)) return '+' + clean;
  return null;
}

function status() {
  rollover();
  const cfg = config.settings();
  return {
    mode: cfg.smsMode,
    whitelist: cfg.smsWhitelist || [],
    sentToday: counters.sentToday,
    maxPerDay: cfg.smsMaxPerDay,
    sentMonth: counters.sentMonth,
    partsTotal: counters.parts,
    perNumberPerHour: cfg.smsMaxPerHourPerNumber,
    perIpPerHour: cfg.smsMaxPerHourPerIp,
    configured: Boolean((config.ha().sms_username || '').trim()),
  };
}

return { send, measure, normalize, status, loadCounters, recent: (n = 40) => log_.slice(-n).reverse(), maskPhone };

})();

/* ========================================================================== */
/* 14  Verifiering av mobilnummer                                             */
/* ========================================================================== */

const verify = (function () {

/**
 * Mobilnumret ska vara ett bevis, inte ett textfält.
 *
 * Två vägar in, samma sak bakom: en fyrsiffrig kod att skriva, och en länk som
 * startar laddningen direkt. Länken är den enkla vägen; koden finns för mobiler
 * som inte gör länkar klickbara, vilket fortfarande händer.
 *
 * Länken är bunden till KABELNS LÖPNUMMER, inte bara till tiden. Tänk dig att
 * Anna begär sin kod vid stolpen, blir avbruten och åker hem. Inom tio minuter
 * drar hon ur kabeln och Bertil sätter i sin bil. Trycker Anna då på länken
 * hemma i soffan skulle laddningen starta — på Bertils bil, på Annas räkning.
 * Stämmer inte löpnumret händer ingenting.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const pending = new Map();   // nyckel -> { phone, code, expiresAt, attempts, cableEpisode, used }

function code4() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function key() {
  return crypto.randomBytes(6).toString('base64url');
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}

/** Skapar en väntande verifiering och skickar SMS:et. */
async function begin({ phone, ip, baseUrl }) {
  sweep();

  const to = sms.normalize(phone);
  if (!to) return { ok: false, error: 'Kontrollera mobilnumret. Skriv det som 070 123 45 67.' };

  const k = key();
  const c = code4();
  const episode = loop.getCableState().episode;

  const link = `${baseUrl}/s/${k}`;
  const text = `Din kod for ${config.ha().location_name}: ${c}\n\nEller starta direkt:\n${link}`;

  const sent = await sms.send({ to, text, kind: 'verifiering', ip, extra: { code: c, link } });
  if (!sent.ok) return { ok: false, error: sent.error };

  pending.set(k, {
    phone: to, code: c, cableEpisode: episode,
    expiresAt: Date.now() + TTL_MS, attempts: 0, used: false,
  });

  log.info(`Verifiering skapad för ${sms.maskPhone(to)}, kabelns löpnummer #${episode}.`);
  return { ok: true, token: k, phone: to, simulated: Boolean(sent.simulated) };
}

/** Kontrollerar en inskriven kod. */
function check(token, input) {
  sweep();
  const v = pending.get(token);
  if (!v) return { ok: false, error: 'Koden har gått ut. Begär en ny.' };
  if (v.used) return { ok: false, error: 'Koden är redan använd.' };

  v.attempts += 1;
  if (v.attempts > MAX_ATTEMPTS) {
    pending.delete(token);
    return { ok: false, error: 'För många försök. Begär en ny kod.' };
  }

  if (String(input || '').trim() !== v.code) {
    return { ok: false, error: `Fel kod. ${MAX_ATTEMPTS - v.attempts} försök kvar.` };
  }

  // Koden stämde — men nyckeln bränns inte här. Den ska lösas in när laddningen
  // faktiskt startar, annars har vi inget kvar att starta med.
  v.verified = true;
  return { ok: true, phone: v.phone };
}

/** Löser in en verifiering — via kod eller via länken. */
/**
 * @param {boolean} needVerified
 *   true  för startknappen: koden måste ha skrivits in rätt först
 *   false för den magiska länken: att känna till nyckeln ÄR beviset
 */
function consume(token, needVerified = false) {
  sweep();
  const v = pending.get(token);
  if (!v) return { ok: false, error: 'Länken har gått ut. Begär en ny kod.' };
  if (v.used) return { ok: false, error: 'Länken är redan använd.' };
  if (needVerified && !v.verified) return { ok: false, error: 'Koden är inte verifierad.' };

  const nowEpisode = loop.getCableState().episode;
  if (v.cableEpisode !== nowEpisode) {
    pending.delete(token);
    return {
      ok: false,
      error: 'Kabeln har kopplats ur sedan du begärde koden. Kontrollera att det är din bil som sitter i och begär en ny kod.',
    };
  }

  v.used = true;
  pending.delete(token);
  return { ok: true, phone: v.phone };
}

function stats() {
  sweep();
  return { pending: pending.size };
}

return { begin, check, consume, stats, TTL_MS };

})();

/* ========================================================================== */
/* 15  QR-koder                                                               */
/* ========================================================================== */

const qr = (function () {

/**
 * QR-kodare, byte-läge, felrättningsnivå M.
 *
 * Den gamla appen lät quickchart.io rita koden. Det innebar att ditt
 * Swish-nummer och exakta belopp skickades till en främmande webbtjänst varje
 * gång en gäst öppnade sitt kvitto — och att koden uteblev helt om tjänsten låg
 * nere. Ingetdera är rimligt för något som ska fungera vid en stolpe i ett
 * stugområde.
 *
 * Det här är tillräckligt av standarden för vårt behov: Swish-nyttolaster är
 * korta, och version 1 till 10 räcker med god marginal.
 */

/* ---------------- Galois-fält för Reed-Solomon ---------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* ---------------- versionstabeller, nivå M ---------------- */

// [totala databytes, ecc-bytes per block, antal block grupp1, antal block grupp2]
const VERSIONS_M = {
  1:  [16,  10, 1, 0],
  2:  [28,  16, 1, 0],
  3:  [44,  26, 1, 0],
  4:  [64,  18, 2, 0],
  5:  [86,  24, 2, 0],
  6:  [108, 16, 4, 0],
  7:  [124, 18, 4, 0],
  8:  [154, 22, 2, 2],
  9:  [182, 22, 3, 2],
  10: [216, 26, 4, 1],
};

const ALIGN_POS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const [cap] = VERSIONS_M[v];
    const countBits = v < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits + byteLen * 8) / 8);
    if (needed <= cap) return v;
  }
  return null;
}

/* ---------------- bitström ---------------- */

function buildData(bytes, version) {
  const [capacity] = VERSIONS_M[version];
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  push(0b0100, 4);                                  // byte-läge
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capBits = capacity * 8;
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  const PAD = [0xec, 0x11];
  let p = 0;
  while (data.length < capacity) data.push(PAD[p++ % 2]);
  return data;
}

function interleave(data, version) {
  const [capacity, ecLen, g1, g2] = VERSIONS_M[version];
  const blocks = g1 + g2;
  const shortLen = Math.floor(capacity / blocks);

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < blocks; i++) {
    const len = i < g1 ? shortLen : shortLen + 1;
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecLen));
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

/* ---------------- matris ---------------- */

function makeMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setF = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

  // sökmönster i tre hörn
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r; const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 ||
                     (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setF(rr, cc, dark ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // tidmönster
  for (let i = 8; i < size - 8; i++) {
    setF(6, i, i % 2 === 0 ? 1 : 0);
    setF(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // riktmönster
  const pos = ALIGN_POS[version];
  for (const r of pos) {
    for (const c of pos) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setF(r + dr, c + dc, dark ? 1 : 0);
        }
      }
    }
  }

  setF(size - 8, 8, 1);   // alltid mörk

  // plats för formatinformation
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) { m[8][i] = 0; reserved[8][i] = true; }
    if (m[i][8] === null) { m[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
    if (m[size - 1 - i][8] === null) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
  }

  return { m, reserved, size };
}

function placeData(m, reserved, size, bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  let idx = 0; let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;              // hoppa över tidmönstrets kolumn
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        m[row][c] = idx < bits.length ? bits[idx] : 0;
        idx++;
      }
    }
    up = !up;
  }
}

function maskFn(n) {
  return [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ][n];
}

function penalty(m, size) {
  let score = 0;

  // regel 1: fem eller fler i rad
  const run = (get) => {
    for (let a = 0; a < size; a++) {
      let last = -1; let len = 0;
      for (let b = 0; b < size; b++) {
        const v = get(a, b);
        if (v === last) { len++; } else { if (len >= 5) score += len - 2; last = v; len = 1; }
      }
      if (len >= 5) score += len - 2;
    }
  };
  run((r, c) => m[r][c]);
  run((c, r) => m[r][c]);

  // regel 2: 2x2-block
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // regel 3: mönster som liknar sökmönster
  const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (arr, pat) => pat.every((v, i) => arr[i] === v);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      const row = []; const col = [];
      for (let i = 0; i < 11; i++) { row.push(m[r][c + i]); col.push(m[c + i][r]); }
      if (match(row, PAT1) || match(row, PAT2)) score += 40;
      if (match(col, PAT1) || match(col, PAT2)) score += 40;
    }
  }

  // regel 4: obalans mellan mörkt och ljust
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

const FORMAT_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

function placeFormat(m, size, mask) {
  const bits = FORMAT_M[mask];
  const get = (i) => (bits >> i) & 1;

  for (let i = 0; i <= 5; i++) m[8][i] = get(14 - i);
  m[8][7] = get(8); m[8][8] = get(7); m[7][8] = get(6);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = get(14 - i);

  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = get(i);
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = get(i);

  m[size - 8][8] = 1;
}

/* ---------------- publikt ---------------- */

/** @returns {{matrix:number[][], size:number, version:number}} */
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  if (!version) throw new Error('Texten är för lång för en QR-kod av den här storleken.');

  const data = buildData(bytes, version);
  const full = interleave(data, version);

  const { m, reserved, size } = makeMatrix(version);
  placeData(m, reserved, size, full);

  // välj den mask som ger lägst straffpoäng
  let best = null; let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const cand = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && maskFn(mask)(r, c)) cand[r][c] ^= 1;
      }
    }
    placeFormat(cand, size, mask);
    const sc = penalty(cand, size);
    if (sc < bestScore) { bestScore = sc; best = cand; }
  }

  return { matrix: best, size, version };
}

/** QR-koden som fristående SVG, redo att bäddas in i en sida. */
function svg(text, { scale = 8, margin = 4, dark = '#0a140f', light = '#ffffff' } = {}) {
  const { matrix, size } = encode(text);
  const dim = (size + margin * 2) * scale;

  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img" aria-label="QR-kod för Swish-betalning">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}

return { encode, svg };

})();
/* ========================================================================== */
/* 16  Swish                                                                  */
/* ========================================================================== */

const swish = (function () {

/**
 * Swish-länk och QR-kod.
 *
 * Inga pengar passerar appen — den visar bara ett belopp och en väg att betala.
 * Formatet är hämtat rakt från din nuvarande app, som bevisligen fungerar i
 * skarp drift. Det finns ingen anledning att experimentera här.
 *
 * Djuplänken öppnar Swish-appen på samma telefon. QR-koden finns för när kvittot
 * öppnas på något annat än telefonen som ska betala — eller när knappen av någon
 * anledning inte biter, vilket den inte gör om Swish saknas på enheten.
 */

function payee(number) {
  let clean = String(number || '').replace(/[\s-]/g, '');
  if (clean.startsWith('+46')) clean = '0' + clean.slice(3);
  return clean;
}

function deepLink({ number, amountSek, message }) {
  const payload = {
    version: 1,
    payee: { value: payee(number), editable: false },
    amount: { value: Number(Number(amountSek).toFixed(2)), editable: false },
    message: { value: String(message).slice(0, 50), editable: false },
  };
  return `swish://payment?data=${encodeURIComponent(JSON.stringify(payload))}`;
}

/** Strängformatet Swish-appens egen skanner förstår. */
function qrPayload({ number, amountSek, message }) {
  const amount = Number(amountSek).toFixed(2);
  const msg = String(message).slice(0, 50).replace(/[;\n]/g, ' ');
  return `C${payee(number)};${amount};${msg};0`;
}

function qrSvg(data, opts) {
  return qr.svg(qrPayload(data), opts);
}

return { payee, deepLink, qrPayload, qrSvg };

})();

/* ========================================================================== */
/* 17  Kvittosidan                                                            */
/* ========================================================================== */

const receiptPage = (function () {

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function kr(n) { return Number(n || 0).toFixed(2).replace('.', ','); }
function kwh(n) { return Number(n || 0).toFixed(2).replace('.', ','); }

function when(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('sv-SE', {
    timeZone: 'Europe/Stockholm',
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

function duration(a, b) {
  if (!a || !b) return '';
  const min = Math.round((Date.parse(b) - Date.parse(a)) / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} tim ${min % 60} min` : `${min} min`;
}

/**
 * Kvittot som en egen sida.
 *
 * Den här öppnas ofta timmar efter laddningen, från ett SMS, av någon som
 * kanske inte minns exakt vad den gäller. Därför står tid och plats överst och
 * beloppet stort — och därför finns Swish-koden kvar även om knappen inte
 * fungerar. En `swish://`-länk gör ingenting alls på en dator eller i en mobil
 * utan Swish, och misslyckas dessutom tyst.
 */
function render(session, swishData, place) {
  const paid = session.payment === 'CONFIRMED';
  const claimed = session.payment === 'GUEST_CLAIMS_PAID';

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0a140f">
<title>Kvitto — ${esc(place)}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{min-height:100dvh;background:#0a140f;
 background-image:radial-gradient(130% 60% at 50% 0%,#12241b 0%,#0a140f 66%);
 color:#EDF3EF;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 display:flex;align-items:flex-start;justify-content:center;padding:22px 16px 40px}
.wrap{width:100%;max-width:420px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.place{font-size:15px;font-weight:600;color:#F3D082}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;
 padding:4px 11px;border-radius:100px;border:1px solid}
.p-paid{color:#8FE0B4;border-color:rgba(143,224,180,.45);background:rgba(143,224,180,.1)}
.p-claim{color:#E6C069;border-color:rgba(230,192,105,.45);background:rgba(230,192,105,.1)}
.p-open{color:#F0A79E;border-color:rgba(240,167,158,.45);background:rgba(240,167,158,.1)}
.card{background:rgba(18,36,27,.72);border:1px solid rgba(226,177,68,.22);
 border-radius:18px;padding:26px 22px 24px;backdrop-filter:blur(10px);
 box-shadow:0 20px 50px rgba(0,0,0,.4)}
h1{font-size:24px;font-weight:600;margin:0 0 6px;color:#fff;letter-spacing:-.02em}
.sub{font-size:15px;color:#BFD2C6;margin:0 0 22px;line-height:1.45}
.r{display:flex;justify-content:space-between;gap:12px;padding:9px 0;font-size:16px;
 color:#C4D6C9;font-variant-numeric:tabular-nums;border-bottom:1px solid rgba(226,177,68,.1)}
.r.total{border-bottom:0;border-top:1px solid rgba(226,177,68,.28);margin-top:8px;
 padding-top:15px;font-size:23px;font-weight:700;color:#F3D082}
.qrbox{margin:22px 0 6px;text-align:center}
.qr{width:190px;height:190px;margin:0 auto;background:#fff;border-radius:12px;padding:9px}
.qr svg{width:100%;height:100%;display:block}
.qrcap{font-size:13px;color:#95AC9E;margin-top:10px;line-height:1.5}
.btn{display:block;width:100%;text-align:center;font:inherit;font-size:19px;font-weight:600;
 padding:18px 16px;border-radius:14px;border:0;background:#E2B144;color:#14231A;
 cursor:pointer;text-decoration:none;margin-top:16px}
.btn.ghost{background:transparent;color:#E6EFE9;border:1.5px solid rgba(230,239,233,.35)}
.btn[disabled]{opacity:.5}
.manual{margin-top:20px;padding-top:18px;border-top:1px solid rgba(226,177,68,.14);
 font-size:14.5px;color:#AFC5B6;line-height:1.6}
.manual b{color:#EDF3EF;font-variant-numeric:tabular-nums}
.note{margin-top:18px;font-size:13px;color:rgba(232,240,234,.45);line-height:1.6;text-align:center}
.msg{margin-top:14px;padding:12px 14px;border-radius:11px;font-size:14.5px;line-height:1.5;
 background:rgba(226,177,68,.1);border:1px solid rgba(226,177,68,.35);color:#EBCE93}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <span class="place">${esc(place)}</span>
    <span class="pill ${paid ? 'p-paid' : claimed ? 'p-claim' : 'p-open'}">
      ${paid ? 'Betald' : claimed ? 'Du har markerat betald' : 'Obetald'}
    </span>
  </div>

  <div class="card">
    <h1>Kvitto</h1>
    <p class="sub">Laddning ${esc(when(session.startedAt))}${
      session.endedAt ? `,<br>pågick i ${esc(duration(session.startedAt, session.endedAt))}` : ''
    }.</p>

    <div class="r"><span>Laddat</span><span>${kwh(session.energyKwh)} kWh</span></div>
    <div class="r"><span>Elkostnad</span><span>${kr(session.costEnergySek)} kr</span></div>
    <div class="r"><span>Avgift laddstolpe</span><span>${kr(session.costServiceSek)} kr</span></div>
    <div class="r total"><span>Att betala</span><span>${kr(session.costSek)} kr</span></div>

    ${session.usedEstimatedPrice
      ? '<div class="msg">Delar av laddningen prissattes mot senast kända elpris eftersom elbörsen inte svarade.</div>'
      : ''}

    ${session.unpricedKwh > 0
      ? `<div class="msg">${kwh(session.unpricedKwh)} kWh av det som laddats är inte prissatt — appen saknar elpris för den perioden helt. Energin står med ovan, men kostnaden för den ingår inte i summan.</div>`
      : ''}

    ${paid ? '' : swishData ? `
    <div class="qrbox">
      <div class="qr">${swishData.svg}</div>
      <p class="qrcap">Skanna med Swish-appen,<br>eller tryck på knappen nedan.</p>
    </div>

    <a class="btn" href="${esc(swishData.link)}">Öppna Swish och betala</a>
    <button class="btn ghost" id="paidBtn">Jag har betalat</button>

    <div class="manual">
      Fungerar inget av ovanstående — swisha för hand:<br>
      Nummer <b>${esc(swishData.number)}</b><br>
      Belopp <b>${kr(swishData.amountSek)} kr</b><br>
      Meddelande <b>${esc(swishData.message)}</b>
    </div>` : `
    <div class="msg">Inget Swish-nummer är inlagt i appen än.</div>`}

    ${paid ? '<p class="note">Tack, betalningen är bekräftad.</p>' : ''}
  </div>

  <p class="note">Sidan finns kvar — spara SMS:et så hittar du hit igen.</p>
</div>

<script>
(function () {
  var b = document.getElementById('paidBtn');
  if (!b) return;
  b.addEventListener('click', function () {
    b.disabled = true; b.textContent = 'Tack!';
    fetch(location.pathname + '/betald', { method: 'POST' })
      .then(function () { setTimeout(function () { location.reload(); }, 900); })
      .catch(function () { b.disabled = false; b.textContent = 'Jag har betalat'; });
  });
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

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');

const chargerFactory = chargerModule;
const { OP_MODE, NO_CURRENT_REASON } = chargerModule;
const { Router, RateLimiter, makeHandler, sendJson, sendHtml, readJsonBody } = httpModule;

const VERSION = '0.5.2';
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

/**
 * Startsekvensen kan ta uppemot en minut. Din box behövde 17 sekunder bara på
 * återupptagningen, och tre kommandon med verifiering däremellan blir lätt
 * längre än så.
 *
 * Att hålla gästens förfrågan öppen så länge är fel på två sätt: mobilen kan ge
 * upp av sig själv, och under tiden vet appen inte vad den ska visa. Därför
 * svarar servern direkt när sessionen är skapad och kör sekvensen vidare i
 * bakgrunden. Gästsidan frågar ändå var femte sekund.
 */
let startState = { running: false, error: null, since: 0 };

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
/* Kommandon mot laddboxen                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Skickar ett kommando och kontrollerar sedan att det faktiskt hände.
 *
 * Easee svarar 200 så snart kommandot tagits emot av molnet — inte när
 * laddboxen har gjort något. Den gamla appen tolkade det som att laddningen
 * startat och gick vidare. Ibland stämde det. Ibland stod bilen still medan
 * appen räknade en session.
 *
 * Här väntar vi in det observerbara tillståndet i stället. Verifieringen
 * kostar några extra avläsningar, men kommandon är sällsynta och ett felaktigt
 * antagande här blir ett felaktigt kvitto.
 */
async function sendCommand(name, run, verify, { timeoutMs = 25000, pollMs = 4000 } = {}) {
  const started = Date.now();
  const res = await run();

  if (!res.ok) {
    if (charger.noteCommand) charger.noteCommand({ name, ok: false, verified: false, error: res.error });
    log.warn(`Kommando "${name}" gick inte fram: ${res.error}`);
    return { ok: false, verified: false, error: res.error };
  }

  if (!verify) {
    if (charger.noteCommand) charger.noteCommand({ name, ok: true, verified: null });
    log.info(`Kommando "${name}" skickat.`);
    return { ok: true, verified: null };
  }

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const st = await charger.readState();
    if (st.ok && verify(st)) {
      const secs = Math.round((Date.now() - started) / 1000);
      if (charger.noteCommand) charger.noteCommand({ name, ok: true, verified: true, seconds: secs });
      log.info(`Kommando "${name}" bekräftat av laddboxen efter ${secs} s.`);
      return { ok: true, verified: true, state: st };
    }
  }

  if (charger.noteCommand) charger.noteCommand({ name, ok: true, verified: false, error: 'ingen bekräftelse i tid' });
  log.warn(`Kommando "${name}" togs emot men laddboxen ändrade inte tillstånd inom ${timeoutMs / 1000} s.`);
  return { ok: true, verified: false, error: 'Laddboxen bekräftade inte kommandot i tid.' };
}

/**
 * Startsekvensen.
 *
 * Att starta en laddning är inte ett kommando utan en ordning. Stolpen står
 * avstängd när den inte används — det är låset som hindrar någon från att bara
 * koppla in sig och ladda gratis. Skickar man `start_charging` mot en avstängd
 * laddare kvitterar Easee kommandot och ingenting händer. Easee svarar då med
 * orsakskod 53, "Laddaren är avstängd".
 *
 * Så: slå på först, starta sedan. Och har boxen fastnat i väntläge behövs
 * dessutom `resume_charging` — en laddning som pausats startar inte om av ett
 * startkommando.
 *
 * Originalappen gjorde rätt sak men skickade alla fyra kommandona på en gång
 * och räknade det som lyckat om något av dem svarade ok. Här görs stegen i
 * ordning, och bara de som behövs.
 */
async function startChargingSequence() {
  const isCharging = (st) => st.opMode === 3 || st.powerKw > 0.1;

  // 1. Lås upp stolpen. Alltid — vi vet inte säkert i vilket läge den står,
  //    och att slå på en redan påslagen laddare är ofarligt.
  if (charger.setEnabled) {
    const on = await sendCommand('slå på laddaren', () => charger.setEnabled(true), null);
    if (!on.ok) return { ok: false, error: `Laddaren kunde inte slås på: ${on.error}` };
  }

  // 2. Starta.
  let started = await sendCommand('starta laddning', () => charger.start(), isCharging,
    { timeoutMs: 20000, pollMs: 4000 });
  if (!started.ok) return started;
  if (started.verified) return started;

  // 3. Ingen ström än. Står boxen och väntar behövs ett återupptagningskommando.
  const st = loop.getSnapshot();
  if (charger.resume && (st.opMode === 2 || st.opMode === 4 || st.opMode === 6 || st.opMode === 7)) {
    log.info(`Laddboxen står i läge ${st.opMode}. Skickar återupptagning.`);
    const resumed = await sendCommand('återuppta laddning', () => charger.resume(), isCharging,
      { timeoutMs: 20000, pollMs: 4000 });
    if (resumed.ok && resumed.verified) return resumed;
  }

  return { ok: true, verified: false, error: 'Laddboxen började inte ladda.' };
}

/**
 * Stopp och lås.
 *
 * Efter avslutad laddning stängs laddaren av igen, så att nästa person måste
 * gå via appen. Det är samma lås som originalappen satte, och utan det står
 * stolpen öppen för vem som helst mellan laddningarna.
 */
async function stopChargingSequence() {
  let stopped = await sendCommand('stoppa laddning', () => charger.stop(), (st) => st.opMode !== 3);

  if (stopped.ok && stopped.verified === false) {
    log.warn('Laddboxen laddar fortfarande. Försöker stoppa en gång till.');
    stopped = await sendCommand('stoppa laddning, andra försöket', () => charger.stop(), (st) => st.opMode !== 3);
  }
  return stopped;
}

/** Låser stolpen genom att stänga av laddaren. */
async function lockPole() {
  if (!config.settings().disableWhenIdle) return { ok: true, skipped: 'avstängt i inställningarna' };
  if (!charger.setEnabled) return { ok: true, skipped: 'stöds inte' };
  return sendCommand('stäng av laddaren', () => charger.setEnabled(false), null);
}

/** Swish-uppgifterna för en session, eller null om inget nummer är satt. */
function swishFor(session) {
  const number = (config.ha().swish_number || '').trim();
  if (!number || !session || !session.costSek) return null;
  const data = {
    number,
    amountSek: Number(session.costSek),
    message: `Laddning ${config.ha().location_name} ${session.number}`,
  };
  return {
    number: swish.payee(number),
    name: (config.ha().swish_name || '').trim() || null,
    amountSek: data.amountSek,
    message: data.message,
    link: swish.deepLink(data),
    svg: swish.qrSvg(data, { scale: 6, margin: 3 }),
  };
}

/** Liten besked-sida för länkar som öppnas direkt ur ett SMS. */
function magicPage(title, body, ok) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${ok ? '<meta http-equiv="refresh" content="1; url=/">' : ''}
<title>${esc(title)}</title>
<style>
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
 background:#0a140f;background-image:radial-gradient(130% 60% at 50% 0%,#12241b 0%,#0a140f 66%);
 color:#EDF3EF;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
.c{max-width:400px;text-align:center;background:rgba(18,36,27,.72);
 border:1px solid rgba(226,177,68,.22);border-radius:18px;padding:32px 24px}
h1{font-size:23px;font-weight:600;margin:0 0 12px;color:${ok ? '#F3D082' : '#F0A79E'}}
p{font-size:16px;line-height:1.5;color:#BFD2C6;margin:0 0 20px}
a{display:block;padding:16px;border-radius:14px;background:#E2B144;color:#14231A;
 font-size:18px;font-weight:600;text-decoration:none}
</style></head><body><div class="c">
<h1>${esc(title)}</h1><p>${esc(body)}</p>
<a href="/">Till laddstolpen</a>
</div></body></html>`;
}

/** Bygger den publika adressen gästen kan nå kvittot på. */
function publicBaseUrl() {
  const host = (config.ha().public_host || '').trim();
  if (!host) return null;
  return host.replace(/\/+$/, '');
}

/**
 * Kvitto-SMS.
 *
 * Kort med flit. Ett SMS kostar per del, inte per meddelande, och kvittot är
 * den mall som skickas oftast — varje avslutad laddning. Ligger den strax under
 * 160 tecken blir det en del i stället för två, och kostnaden halveras.
 */
async function sendReceiptSms(session) {
  const base = publicBaseUrl();
  const plats = config.ha().location_name;
  const belopp = Number(session.costSek).toFixed(2).replace('.', ',');
  const kwh = Number(session.energyKwh).toFixed(2).replace('.', ',');

  let text = `${plats}: ${kwh} kWh, ${belopp} kr.`;
  if (base) text += `\nKvitto och betalning:\n${base}/k/${session.receiptKey}`;

  return sms.send({ to: session.phone, text, kind: 'kvitto' });
}

/**
 * Kabellåset.
 *
 * Din box har `lockCablePermanently` påslaget, vilket betyder att den håller
 * kabeln låst hela tiden av sig själv. Att då skicka lås- och
 * upplåsningskommandon är i bästa fall bortkastat och i värsta fall något som
 * bråkar med boxens egen inställning. Vi rör den alltså inte — om du inte
 * uttryckligen slår på det, och boxen inte redan sköter det själv.
 */
async function applyCableLock(locked) {
  if (!config.settings().lockCableDuringSession) return { ok: true, skipped: 'avstängt i inställningarna' };
  const snap = loop.getSnapshot();
  if (snap.lockedPermanently) return { ok: true, skipped: 'boxen håller kabeln permanent låst' };
  return sendCommand(locked ? 'lås kabel' : 'lås upp kabel', () => charger.setLocked(locked), null);
}

/**
 * Servern läser laddboxen på nytt innan den startar något — vi litar aldrig på
 * vad webbläsaren visade, den kan ha stått öppen i en timme.
 *
 * Men går den avläsningen inte fram fick gästen förut ett blankt nej, och
 * kunde inte starta alls förrän Easee svarade igen. Är den senaste lyckade
 * avläsningen färskare än en och en halv minut duger den: den säger om kabeln
 * sitter i, och startsekvensen verifierar ändå efteråt att laddningen kom igång.
 */
async function readStateForStart() {
  const live = await charger.readState();
  if (live.ok) return live;

  const snap = loop.getSnapshot();
  const c = loop.contact();
  if (c.state !== 'lost' && snap.readAt) {
    log.info(`Använder senaste avläsningen (${c.ageSeconds} s gammal) eftersom Easee inte svarade: ${live.error}`);
    return { ...snap, ok: true, fromSnapshot: true };
  }
  return live;
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

/**
 * Gästsidan rapporterar sina egna programfel hit.
 *
 * Utan detta är ett fel i sidan osynligt för dig: gästen ser något konstigt,
 * du ser en logg där allt ser bra ut. Ingen kommer att öppna webbläsarens
 * konsol på en annans telefon.
 *
 * Endpointen tar emot text från internet, så: hårt tak per avsändare, hårt
 * längdtak, och den skriver bara till loggen. Ingenting sparas på disk.
 */
guest.post('/api/clienterror', async (req, res, ctx) => {
  const rl = limiter.hit(`clienterr:${ctx.ip}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) return sendJson(res, 429, { ok: false });

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { ok: false });

  const clean = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, max);
  const msg = clean(parsed.body.message, 300);
  const stack = clean(parsed.body.stack, 600);
  if (!msg) return sendJson(res, 400, { ok: false });

  log.warn(`[Gästsidan] Fel i webbläsaren hos ${ctx.ip}: ${msg}`);
  if (stack) log.debug(`[Gästsidan] ${stack}`);
  return sendJson(res, 200, { ok: true });
});

guest.get('/api/status', (req, res) => {
  loop.noteGuestPoll();
  const snap = loop.getSnapshot();
  const active = sessions.getActive();
  const price = prices.currentPrice();

  // 'ok' | 'stale' | 'lost'. Ett enda misslyckat anrop släcker inte längre
  // sidan: vi visar det vi senast visste och skriver ut hur gammalt det är.
  const contact = loop.contact();

  let view = 'idle';
  let session = null;
  let busySince = null;

  if (contact.state === 'lost') {
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
    // Underlag för att räkna vidare mellan avläsningarna, så siffrorna tickar
    // jämnt i stället för att hoppa var tionde sekund. Det som visas mellan två
    // avläsningar är en uppskattning; det som debiteras är alltid de riktiga
    // mätvärdena.
    requireVerification: config.settings().requireVerification,
    starting: startState.running,
    startError: !active && startState.error ? startState.error : null,
    readAt: snap.readAt,
    contact: contact.state,
    ageSeconds: contact.ageSeconds,
    retryInSeconds: contact.retryInSeconds,
    serverTime: new Date().toISOString(),
    simulated: Boolean(snap.simulated),
    locationName: config.ha().location_name,
  });
});

/**
 * Steg 1: gästen skriver sitt nummer och får en kod.
 *
 * Här bränns pengar om något går fel, så taken i SMS-modulen är det som
 * skyddar. De gäller i alla lägen, även simulerat — ett tak som bara finns i
 * skarpt läge är ett tak ingen provat.
 */
guest.post('/api/verify/send', async (req, res, ctx) => {
  loop.noteGuestPoll();

  if (sessions.getActive()) {
    return sendJson(res, 409, { error: 'Stolpen används just nu.' });
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

  const state = await readStateForStart();
  if (!state.ok) return sendJson(res, 503, { error: 'Ingen kontakt med laddstolpen just nu. Försök igen om en stund.' });
  if (!state.cableConnected) return sendJson(res, 409, { error: 'Ingen kabel är ansluten till stolpen.' });

  const base = publicBaseUrl() || `https://${req.headers.host || 'localhost'}`;
  const out = await verify.begin({ phone: parsed.body.phone, ip: ctx.ip, baseUrl: base });
  if (!out.ok) return sendJson(res, 429, { error: out.error });

  return sendJson(res, 200, {
    ok: true,
    token: out.token,
    phone: out.phone,
    simulated: out.simulated,
    ttlSeconds: Math.round(verify.TTL_MS / 1000),
  });
});

/** Steg 2: gästen skriver koden. */
guest.post('/api/verify/check', async (req, res, ctx) => {
  loop.noteGuestPoll();

  const rl = limiter.hit(`verify:${ctx.ip}`, 20, 60 * 60 * 1000);
  if (!rl.allowed) return sendJson(res, 429, { error: 'För många försök. Vänta en stund.' });

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

  const out = verify.check(parsed.body.token, parsed.body.code);
  if (!out.ok) return sendJson(res, 400, { error: out.error });

  return sendJson(res, 200, { ok: true, phone: out.phone });
});

guest.post('/api/start', async (req, res, ctx) => {
  loop.noteGuestPoll();
  // Spärren sätts först av allt, före varje await
  if (startInFlight || startState.running) {
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

    // Numret måste vara verifierat. Utan det är det bara ett textfält, och då
    // är spårbarheten — ett av två skäl att bygga appen — borta.
    let phone;
    if (parsed.body.token) {
      const v = verify.consume(parsed.body.token, true);
      if (!v.ok) return sendJson(res, 400, { error: v.error });
      phone = v.phone;
    } else if (!config.settings().requireVerification) {
      phone = normalizePhone(parsed.body.phone);
      if (!phone) return sendJson(res, 400, { error: 'Kontrollera mobilnumret. Skriv det som 070 123 45 67.' });
    } else {
      return sendJson(res, 400, { error: 'Mobilnumret måste verifieras först.' });
    }

    const state = await readStateForStart();
    if (!state.ok) return sendJson(res, 503, { error: 'Ingen kontakt med laddstolpen just nu. Försök igen om en stund.' });
    if (!state.cableConnected) return sendJson(res, 409, { error: 'Ingen kabel är ansluten till stolpen.' });
    if (sessions.getActive()) return sendJson(res, 409, { error: 'Stolpen används just nu.' });

    const started = sessions.start({
      phone,
      cableEpisode: loop.getCableState().episode,
      startEnergyKwh: state.sessionEnergyKwh,
      simulated: Boolean(state.simulated),
    });
    if (!started.ok) return sendJson(res, 409, { error: started.error });

    log.info(`Gäst startade session #${started.session.number} från ${ctx.ip}.`);
    startState = { running: true, error: null, since: Date.now() };

    // Körs vidare utan att gästen får vänta. Medvetet inget await.
    (async () => {
      try {
        const cmd = await startChargingSequence();

        if (!cmd.ok) {
          // Kommandot gick inte fram alls. Låtsas aldrig att en laddning startat.
          log.error(`Session #${started.session.number} kunde inte startas: ${cmd.error}`);
          startState.error = cmd.error || 'Laddningen kunde inte startas.';
          sessions.finish('start misslyckades');
          return;
        }

        // Kommandot togs emot men bilen har inte börjat dra ström än. Det är
        // normalt — vissa bilar tar en stund. Sessionen behålls: energin räknas
        // från faktiska mätvärden, så uteblir laddningen blir kostnaden noll och
        // sessionen avslutas av sig själv efter tjugo minuter utan effekt.
        if (cmd.verified === false) {
          log.info(`Session #${started.session.number}: bilen har inte börjat ladda än.`);
        }

        await applyCableLock(true);
        await loop.tick();
      } catch (err) {
        log.error(`Fel i startsekvensen: ${err.stack || err.message}`);
        startState.error = 'Något gick fel när laddningen skulle startas.';
        sessions.finish('start misslyckades');
      } finally {
        startState.running = false;
      }
    })();

    return sendJson(res, 200, {
      ok: true,
      starting: true,
      session: sessions.publicView(sessions.getActive()),
    });
  } finally {
    startInFlight = false;
  }
});

guest.post('/api/stop', async (req, res, ctx) => {
  loop.noteGuestPoll();
  const active = sessions.getActive();
  if (!active) return sendJson(res, 409, { error: 'Ingen laddning pågår.' });

  const rl = limiter.hit(`stop:${ctx.ip}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) return sendJson(res, 429, { error: 'För många försök. Vänta en stund.' });

  await loop.tick();                    // sista avläsningen innan vi summerar
  const done = await loop.endSession('avslutad av gästen');

  if (done && done.stopFailed) {
    return sendJson(res, 502, {
      error: 'Laddningen kunde inte stoppas. Dra ur kabeln, så avslutas den automatiskt.',
    });
  }
  return sendJson(res, 200, { ok: true, session: sessions.publicView(done) });
});

/**
 * Den magiska länken från SMS:et. Ett tryck och laddningen är igång.
 *
 * Den svarar med en liten sida i stället för JSON, eftersom den öppnas direkt i
 * mobilens webbläsare. Sidan skickar vidare till startsidan, som då redan har
 * en laddning på gång.
 */
guest.get('/s/:key', async (req, res, ctx) => {
  loop.noteGuestPoll();

  const say = (title, body, ok) => sendHtml(res, ok ? 200 : 409, magicPage(title, body, ok));

  if (sessions.getActive()) {
    return say('Stolpen används just nu', 'Någon annan har hunnit före. Försök igen när den blir ledig.', false);
  }

  const v = verify.consume(ctx.params.key);
  if (!v.ok) return say('Länken fungerar inte', v.error, false);

  const state = await readStateForStart();
  if (!state.ok) return say('Ingen kontakt med laddstolpen', 'Försök igen om en stund.', false);
  if (!state.cableConnected) return say('Ingen kabel ansluten', 'Sätt i kabeln och begär en ny kod.', false);

  const started = sessions.start({
    phone: v.phone,
    cableEpisode: loop.getCableState().episode,
    startEnergyKwh: state.sessionEnergyKwh,
    simulated: Boolean(state.simulated),
  });
  if (!started.ok) return say('Kunde inte starta', started.error, false);

  log.info(`Session #${started.session.number} startad via länk från ${ctx.ip}.`);
  startState = { running: true, error: null, since: Date.now() };
  (async () => {
    try {
      const cmd = await startChargingSequence();
      if (!cmd.ok) {
        startState.error = cmd.error || 'Laddningen kunde inte startas.';
        sessions.finish('start misslyckades');
        return;
      }
      await applyCableLock(true);
      await loop.tick();
    } catch (err) {
      startState.error = 'Något gick fel när laddningen skulle startas.';
      sessions.finish('start misslyckades');
    } finally {
      startState.running = false;
    }
  })();

  return say('Laddningen startar', 'Du skickas vidare…', true);
});

/**
 * Kvittosidan.
 *
 * Egen adress, ingen utgångstid, helt frikopplad från stolpens nuvarande
 * tillstånd — grannen som öppnar sitt kvitto på eftermiddagen ska se sin egen
 * laddning, inte "upptagen" för att någon annan laddar just då.
 *
 * Svarar med JSON om webbläsaren ber om det (gästsidan hämtar kvittot så), och
 * annars med en sida man kan öppna direkt från SMS:et.
 */
guest.get('/k/:key', (req, res, ctx) => {
  const s = sessions.byReceiptKey(ctx.params.key);
  const wantsJson = String(req.headers.accept || '').includes('application/json');

  if (!s) {
    if (wantsJson) return sendJson(res, 404, { error: 'Kvittot hittades inte.' });
    return sendHtml(res, 404, magicPage('Kvittot hittades inte',
      'Kontrollera länken i SMS:et.', false));
  }

  if (wantsJson) {
    return sendJson(res, 200, { session: sessions.publicView(s), swish: swishFor(s) });
  }
  return sendHtml(res, 200, receiptPage.render(sessions.publicView(s), swishFor(s), config.ha().location_name));
});

guest.post('/k/:key/betald', async (req, res, ctx) => {
  const s = sessions.byReceiptKey(ctx.params.key);
  if (!s) return sendJson(res, 404, { error: 'Kvittot hittades inte.' });

  const rl = limiter.hit(`paid:${ctx.ip}`, 20, 3600 * 1000);
  if (!rl.allowed) return sendJson(res, 429, { error: 'För många försök.' });

  // Gästen SÄGER att den betalat. Det är ett eget tillstånd, skilt från att du
  // bekräftat det i Swish — appen ska inte låtsas veta något den inte vet.
  sessions.setPayment(s.id, 'GUEST_CLAIMS_PAID');
  return sendJson(res, 200, { ok: true });
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
    cadence: loop.cadence(),
    contact: loop.contact(),
    lastTick: loop.getLastTickAt(),
    sms: sms.status(),
    smsLog: sms.recent(30),
    verify: verify.stats(),
    swishConfigured: Boolean((config.ha().swish_number || '').trim()),
    publicHost: publicBaseUrl(),
    easee: charger.stats ? charger.stats() : null,
    opModeText: OP_MODE[snap.opMode] || 'okänt',
    noCurrentText: (snap.reasonForNoCurrent === null || snap.reasonForNoCurrent === undefined)
      ? null
      : (NO_CURRENT_REASON[snap.reasonForNoCurrent] || 'okänd kod'),
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
  const done = await loop.endSession('avslutad från admin', { force: req.headers['x-force'] === 'ja' });
  if (done && done.stopFailed) {
    return sendJson(res, 502, {
      error: 'Laddboxen svarar men slutar inte ladda. Sessionen hålls öppen och räknas vidare.',
    });
  }
  return sendJson(res, 200, { ok: true, session: sessions.publicView(done) });
});

admin.post('/api/admin/session/payment', async (req, res) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const result = sessions.setPayment(parsed.body.id, parsed.body.state);
  if (!result.ok) return sendJson(res, 400, { error: result.error });
  return sendJson(res, 200, { ok: true });
});

admin.post('/api/admin/command', async (req, res) => {
  const mode = config.ha().mode;
  if (mode === 'avlasning') {
    return sendJson(res, 403, { error: 'Läget är avläsning. Byt till skarpt läge för att skicka kommandon.' });
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const cmd = String(parsed.body.cmd || '');

  // Manuella kommandon får inte krocka med en pågående gästladdning
  if (sessions.getActive() && (cmd === 'start' || cmd === 'stop')) {
    return sendJson(res, 409, {
      error: 'En laddning pågår. Använd "Avsluta sessionen" på Översikt i stället, så räknas kvittot rätt.',
    });
  }

  let out;
  switch (cmd) {
    case 'start':
      out = await startChargingSequence();
      break;
    case 'stop':
      out = await stopChargingSequence();
      break;
    case 'enable':
      out = await sendCommand('lås upp stolpen', () => charger.setEnabled(true), null);
      break;
    case 'disable':
      out = await sendCommand('lås stolpen', () => charger.setEnabled(false), null);
      break;
    case 'lock':
      out = await sendCommand('lås kabel (manuellt)', () => charger.setLocked(true), null);
      break;
    case 'unlock':
      out = await sendCommand('lås upp kabel (manuellt)', () => charger.setLocked(false), null);
      break;
    case 'current':
      out = await sendCommand(
        `maxström ${config.settings().maxChargerCurrent} A`,
        () => charger.setMaxCurrent(config.settings().maxChargerCurrent),
        null,
      );
      break;
    default:
      return sendJson(res, 400, { error: `Okänt kommando: ${cmd}` });
  }

  await loop.tick();
  if (!out.ok) return sendJson(res, 502, { error: out.error });
  return sendJson(res, 200, { ok: true, verified: out.verified });
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
    case 'disable': out = await charger.setEnabled(false); break;
    case 'stuck': out = charger.setStuck(true); break;
    case 'unstuck': out = charger.setStuck(false); break;
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
  sms.loadCounters();

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
