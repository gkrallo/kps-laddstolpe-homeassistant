'use strict';

/* ============================================================================
 *
 *  KPs Laddstolpe — Home Assistant-tillägg
 *
 *  Hela tillägget ligger i den här enda filen. Det är ett medvetet val: du
 *  uppdaterar den genom att öppna filen på GitHub, markera allt, klistra in den
 *  nya versionen och spara. En fil att få rätt i stället för nitton.
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
 *    7  Sessioner               kvartsvis kostnad, kvittonycklar, ägarskap
 *    8  Bakgrundsloopen         kabelns löpnummer, auto-avslut, tempo
 *    9  Webbservern             egen liten router, hastighetsbegränsare
 *   10  Gästsidan               HTML: ladda, priskurva, betala
 *   11  Adminfliken             HTML: bara innanför Home Assistant
 *   12  SMS                     46elks, lägen från simulerat till skarpt
 *   13  Ihågkomna telefoner     enhetsnycklar, hashade på disk
 *   14  Verifiering av mobilnummer
 *   15  QR-koder                ritade för hand, inga beroenden
 *   16  Swish                   betalsträngen och länken
 *   17  Kvittosidan             permanent länk per laddning
 *   18  Rutter och uppstart     två lyssnare med skilda rutt-tabeller
 *   19  Ikoner och manifest     appen på hemskärmen
 *
 * ==========================================================================*/


/* ========================================================================== */
/*  1  Loggen                                                                */
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
/*  2  Lagring på disk                                                       */
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
/*  3  Inställningar                                                         */
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

  /* Tak för antal startförsök per timme och avsändare.
     Skyddet finns för att någon utifrån inte ska kunna hamra på stolpen. Men
     hela familjen sitter bakom samma hemma-IP, och även ett nekat försök
     räknas — fem i timmen tog slut fortare än man tror. */
  maxStartsPerHourPerIp: 15,

  /* Nummer som laddar utan att betala — familjen.
     Sessionen registreras ändå, med den verkliga elkostnaden, så att du kan se
     vad hushållets egen laddning kostar. Det som uteblir är avgiften för
     stolpen och kravet på betalning. */
  freeNumbers: [],

  /* Kom ihåg telefoner som en gång bekräftat sitt nummer, så att de slipper
     SMS nästa gång. Varje telefon syns och kan spärras i Laddbox-fliken. */
  rememberDevices: true,

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
  'maxStartsPerHourPerIp',
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

  if ('freeNumbers' in patch) {
    if (!Array.isArray(patch.freeNumbers)) {
      return { ok: false, error: 'Fria nummer måste vara en lista.' };
    }
    next.freeNumbers = patch.freeNumbers.map((v) => String(v).trim()).filter(Boolean);
  }

  if ('rememberDevices' in patch) {
    next.rememberDevices = patch.rememberDevices === true || patch.rememberDevices === 'true';
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

/**
 * Laddar det här numret gratis?
 *
 * Jämförelsen sker på normaliserad form, så att 070-123 45 67, 0701234567 och
 * +46701234567 är samma nummer. Annars vore listan en fälla: man skriver numret
 * som man brukar och undrar varför det ändå kommer en räkning.
 */
function isFreeNumber(phone) {
  const norm = (v) => {
    const c = String(v || '').replace(/[\s\-()]/g, '');
    if (/^0[1-9]\d{7,10}$/.test(c)) return '+46' + c.slice(1);
    if (/^\+46[1-9]\d{7,10}$/.test(c)) return c;
    if (/^46[1-9]\d{7,10}$/.test(c)) return '+' + c;
    return c || null;
  };
  const mal = norm(phone);
  if (!mal) return false;
  return (settings.freeNumbers || []).some((v) => norm(v) === mal);
}

return {
  loadHaOptions,
  loadSettings,
  updateSettings,
  isFreeNumber,
  ha: () => ha,
  settings: () => settings,
  SMS_MODES,
};
})();

/* ========================================================================== */
/*  4  Certifikat                                                            */
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
/*  5  Elpriser                                                              */
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
/*  6  Laddboxen                                                             */
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
    this.carFull = false;   // bilen tar inte emot mer strom (driftlage 4)
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
    this.carFull = Boolean(s.carFull);
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
      carFull: this.carFull,
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

    this.powerKw = this.charging && !this.throttled && !this.carFull ? this.targetKw : 0;

    if (hours > 0 && this.powerKw > 0) {
      const added = this.powerKw * hours;
      this.sessionEnergyKwh += added;
      this.lifetimeEnergyKwh += added;
    }
  }

  /**
   * Driftlägena, så trogna Easees egen betydelse som simulatorn kan vara.
   *
   * Den gamla varianten lät strypning bli läge 4. Det är fel och farligt fel:
   * 4 betyder "bilen har pausat eller slutat ladda", medan en strypning är vi
   * som håller igen. Blandar man ihop dem ser en bil i lastbalanseringskö ut
   * som en färdigladdad bil — och då skriver appen kvitto mitt i kön.
   */
  _opMode() {
    if (!this.cableConnected) return 1;
    if (this.carFull) return 4;                    // bilen tar inte emot mer
    if (this.charging) return this.throttled ? 2 : 3;
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
      // Samma koder en riktig box skickar: 53 avstängd laddare,
      // 28 begränsad av Equalizern, 79 bilen laddar inte.
      reasonForNoCurrent: !this.enabled ? 53 : (this.carFull ? 79 : (this.throttled ? 28 : null)),
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

  /** Bilen slutar ta emot ström — full, eller så avvisar den laddningen. */
  setCarFull(on) {
    this._advance();
    this.carFull = Boolean(on);
    this._persist();
    log.info(`[Simulator] Bilen ${this.carFull ? 'tar inte emot mer ström (driftläge 4)' : 'börjar dra ström igen'}.`);
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
/*  7  Sessioner                                                             */
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

function start({ phone, cableEpisode, startEnergyKwh, simulated, startToken, free }) {
  if (active) return { ok: false, error: 'En laddning pågår redan.' };

  active = {
    id: newId(),
    number: nextNumber(),
    receiptKey: newReceiptKey(),
    phone: phone || null,

    /* Fri laddning — familjen. Sessionen registreras ändå, med den verkliga
       elkostnaden, så att du kan se vad hushållets egen laddning kostar. Det
       som uteblir är avgiften för stolpen och kravet på betalning.
       Statusen låses vid start: ändrar du listan mitt under en laddning ska
       inte räkningen ändra sig under gästens fötter. */
    free: Boolean(free),

    // CHARGING -> FINISHED (klar, kabeln kvar) -> COMPLETED (kabeln urdragen)
    status: 'CHARGING',
    simulated: Boolean(simulated),
    cableEpisode: cableEpisode || null,

    // Nyckeln ur start-SMS:ets länk. Sparas så att länken kan leda till det här
    // kvittot för alltid i stället för att bli en återvändsgränd när den
    // engångsanvänts.
    startToken: startToken || null,

    startedAt: new Date().toISOString(),
    chargingEndedAt: null,   // när bilen slutade ta emot ström
    endedAt: null,           // när kabeln drogs ur

    startEnergyKwh: Number(startEnergyKwh) || 0,
    energyKwh: 0,
    costEnergySek: 0,
    costServiceSek: 0,
    costSek: 0,

    usedEstimatedPrice: false,
    payment: free ? 'FREE' : 'UNPAID',   // FREE | UNPAID | GUEST_CLAIMS_PAID | CONFIRMED
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
  // Elkostnaden räknas alltid — det är vad strömmen faktiskt kostade dig.
  // Avgiften för stolpen är din ersättning för slitage, och den är meningslös
  // internt, så den uteblir för fria laddningar.
  const avgift = active.free ? 0 : price.serviceSek;
  active.costEnergySek = round(active.costEnergySek + kwh * price.energySek, 4);
  active.costServiceSek = round(active.costServiceSek + kwh * avgift, 4);
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

/**
 * Laddningen är klar men bilen står kvar.
 *
 * Sessionen avslutas INTE här. Den lever tills kabeln dras ur, av två skäl:
 * kvittot ska komma när gästen faktiskt åker, och skulle bilen börja dra ström
 * igen — vissa gör det, för batterivård eller förvärmning — ska den strömmen
 * hamna på rätt räkning i stället för att bli gratis.
 */
function markFinished(reason) {
  if (!active || active.status !== 'CHARGING') return null;
  active.status = 'FINISHED';
  active.chargingEndedAt = new Date().toISOString();
  active.finishReason = reason || null;
  activeWriter.save(active, { immediate: true });
  log.info(`Session ${active.number}: laddningen klar (${reason}). ${active.energyKwh} kWh, ${active.costSek} kr. Väntar på att kabeln dras ur.`);
  return active;
}

/** Bilen vaknade och drar ström igen. */
function resumeCharging() {
  if (!active || active.status !== 'FINISHED') return null;
  active.status = 'CHARGING';
  active.chargingEndedAt = null;
  active.finishReason = null;
  activeWriter.save(active, { immediate: true });
  log.info(`Session ${active.number}: bilen drar ström igen. Laddningen fortsätter räknas.`);
  return active;
}

function getActive() { return active; }
function getHistory(limit = 100) { return history.slice(-limit).reverse(); }
function byReceiptKey(key) {
  if (!key) return null;
  if (active && active.receiptKey === key) return active;
  return history.find((s) => s.receiptKey === key) || null;
}

/** Nyckeln ur en start-SMS-länk. Låter länken leda till kvittot för alltid. */
function byStartToken(key) {
  if (!key) return null;
  if (active && active.startToken === key) return active;
  return history.find((s) => s.startToken === key) || null;
}

/** Alla laddningar från ett nummer, nyast först. Aldrig numret självt utåt. */
function forPhone(phone, limit = 20) {
  if (!phone) return [];
  const all = active && active.phone === phone ? [active, ...history] : history.slice();
  return all
    .filter((s) => s.phone === phone)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}
function unpaid() { return history.filter((s) => s.payment !== 'CONFIRMED' && s.payment !== 'FREE'); }

function setPayment(id, state) {
  const valid = ['UNPAID', 'GUEST_CLAIMS_PAID', 'CONFIRMED', 'FREE'];
  if (!valid.includes(state)) return { ok: false, error: 'Okänd betalningsstatus.' };
  const s = history.find((x) => x.id === id);
  if (!s) return { ok: false, error: 'Sessionen hittades inte.' };
  s.payment = state;
  store.writeJsonNow(HISTORY_FILE, history);
  return { ok: true, session: s };
}

/**
 * Publik vy — allt som gästsidan får se. Aldrig telefonnummer.
 *
 * Och sedan 0.6.1 inte heller kvittonyckeln, om den inte uttryckligen begärs.
 * Nyckeln är en bärarnyckel: den som har den kommer åt betalsidan, kan markera
 * laddningen som betald, och ser numrets övriga laddningar. Att skicka med den
 * i statussvaret innebar att vem som helst som öppnade gästsidan under en
 * pågående laddning fick den — utan att göra något alls.
 */
function publicView(s, { includeKey = false } = {}) {
  if (!s) return null;
  return {
    number: s.number,
    ...(includeKey ? { receiptKey: s.receiptKey } : {}),
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    energyKwh: round(s.energyKwh, 2),
    powerKw: s.powerKw || 0,
    costEnergySek: round(s.costEnergySek, 2),
    costServiceSek: round(s.costServiceSek, 2),
    costSek: round(s.costSek, 2),
    usedEstimatedPrice: Boolean(s.usedEstimatedPrice),
    free: Boolean(s.free),
    // Energi som är uppmätt men ännu inte prissatt. Noll i normalfallet.
    unpricedKwh: round(s.unpricedKwh || 0, 2),
    chargingEndedAt: s.chargingEndedAt || null,
    finishReason: s.finishReason || null,
    cableEpisode: s.cableEpisode || null,
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
  markFinished, resumeCharging, byStartToken, forPhone,
  getActive, getHistory, byReceiptKey, unpaid, setPayment,
  publicView, maskPhone,
};
})();

/* ========================================================================== */
/*  8  Bakgrundsloopen                                                       */
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

    await handleChargingDone(state, active);
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

/**
 * Är laddningen klar?
 *
 * Easees egen dokumentation är tydligare än man först tror: driftläge 4
 * heter "Completed" men betyder *"Car has paused/stopped charging"*. Bilen kan
 * alltså ha pausat — för kall batteri, för egen schemaläggning — och tänka
 * fortsätta. Läge 2 är "Car connected, charger is waiting for EV or load
 * balancing", vilket är ännu vagare: där ryms både en färdig bil och en bil
 * som står i kö bakom lastbalanseringen.
 *
 * Därför två olika väntetider, och en spärr.
 *
 * SPÄRREN: stryper lastbalanseringen är laddningen inte klar, den är pausad av
 * oss. Att kalla det färdigt vore att skriva ett kvitto mitt i kön.
 *
 * Och eftersom "klar" numera inte avslutar något — sessionen lever tills
 * kabeln dras ur, och börjar bilen dra ström igen går den tillbaka till
 * laddar — kostar en förhastad slutsats bara en rad på skärmen som rättar sig
 * själv. Då kan vi vara betydligt snabbare än de tjugo minuter det tog förut.
 */
const DONE_CONFIRM_MS = 90 * 1000;   // driftläge 4: bilen säger själv att den är klar
const VAGUE_CONFIRM_MS = IDLE_FINISH_MS;  // driftläge 2 och 6: vagare, vänta ut det

// Orsakskoder som betyder "vi stryper", inte "bilen är klar".
const THROTTLE_REASONS = new Set([1, 2, 3, 4, 5, 6, 10, 25, 26, 27, 28, 29, 30, 50, 51, 52, 75, 76, 77, 78]);

async function handleChargingDone(state, session) {
  const flowing = state.opMode === 3 || state.powerKw > 0.1;

  // Bilen vaknade. Utan det här skulle strömmen efter en paus bli gratis.
  if (session.status === 'FINISHED') {
    if (flowing) { sessions.resumeCharging(); zeroPowerSince = null; }
    return;
  }

  if (flowing) { zeroPowerSince = null; return; }

  const throttled = THROTTLE_REASONS.has(Number(state.reasonForNoCurrent));
  if (throttled) { zeroPowerSince = null; return; }

  let wait;
  if (state.opMode === 4) wait = DONE_CONFIRM_MS;
  else if (state.opMode === 2 || state.opMode === 6) wait = VAGUE_CONFIRM_MS;
  else { zeroPowerSince = null; return; }

  if (!zeroPowerSince) { zeroPowerSince = Date.now(); return; }
  if (Date.now() - zeroPowerSince < wait) return;

  const varfor = state.opMode === 4
    ? 'bilen tar inte emot mer ström'
    : 'ingen ström på tjugo minuter';
  sessions.markFinished(varfor);
  zeroPowerSince = null;
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
  //
  // Det här är den ENDA platsen som skickar kvitto, och hit kommer vi bara när
  // kabeln dragits ur. Förut gick kvittot när laddningen tog slut, vilket
  // innebar att gästen fick sin räkning mitt i natten medan bilen stod kvar.
  // Fri laddning får inget kvitto-SMS. Det finns ingen räkning att skicka, och
  // ett SMS som säger "0 kr" är bara en kostnad för dig och en pling för dem.
  if (done && done.phone && !done.free) {
    sendReceiptSms(done).catch((err) => log.error(`Kvitto-SMS misslyckades: ${err.message}`));
  } else if (done && done.free) {
    log.info(`Session ${done.number} var fri laddning. Inget kvitto-SMS. Elkostnad ${done.costEnergySek} kr.`);
  }

  return done;
}

/**
 * Gästen eller du trycker "avsluta" medan kabeln sitter i.
 *
 * Skiljer sig från att bilen blir full: här har någon sagt att det är slut, så
 * laddaren stängs av och bilen får inte börja om. Men sessionen lever kvar och
 * kvittot väntar — allt avslutas när kabeln dras ur.
 */
async function stopChargingNow(reason, { force = false } = {}) {
  const active = sessions.getActive();
  if (!active) return null;

  const stopped = await stopChargingSequence();
  if (!force && stopped.ok && stopped.verified === false) {
    log.error('Laddningen gick inte att stoppa. Sessionen hålls öppen och fortsätter räknas.');
    return { stopFailed: true };
  }

  await applyCableLock(false);
  await loop.tick();          // sista avläsningen så energin är räknad
  await lockPole();           // ingen gratis omstart på samma kabel
  const s = sessions.markFinished(reason);
  await loop.tick();
  return s;
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
  STALE_MS, stopChargingNow,
  getSnapshot: () => snapshot,
  getCableState: () => cableState,
  getLastTickAt: () => lastTickAt,
  endSession,
};
})();

/* ========================================================================== */
/*  9  Webbservern                                                           */
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


function sendBinary(res, status, buf, type, cache) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': cache || 'public, max-age=86400',
  });
  res.end(buf);
}

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
  sendJson, sendHtml, sendText, sendBinary, readJsonBody, clientIp,
};
})();

/* ========================================================================== */
/* 10  Gästsidan                                                             */
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
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Laddstolpe">
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

/* Prisdiagrammet. Två serier, en enda y-axel — bägge är kr/kWh, och att ge dem
   var sin skala hade uppfunnit ett samband som inte finns. Färgerna är prövade
   mot den här bakgrunden för färgblindhet: guld och blått ligger 27 steg isär
   även vid protanopi, och guldet är nedstämt så det håller sig i det spann som
   är läsbart mot mörkt. */
.curve{margin-top:6px}
.curve svg{width:100%;height:auto;display:block;touch-action:pan-y}
.legend{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;
  font-size:14.5px;color:#BFD2C6;margin:2px 0 10px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.legend i{width:16px;height:3px;border-radius:2px;display:block}
.readout{text-align:center;font-size:15px;color:#E6EFE9;min-height:22px;
  margin:8px 0 2px;font-variant-numeric:tabular-nums}
.readout b{color:#F3D082}
.curvenote{font-size:13.5px;color:#93A39B;line-height:1.5;margin:10px 0 0;text-align:center}

.field{margin-bottom:14px}
.field label{display:block;font-size:14.5px;color:#BFD2C6;margin-bottom:7px}
.field input{width:100%;font:inherit;font-size:21px;font-weight:500;letter-spacing:.02em;
  padding:15px 16px;border-radius:12px;border:1.5px solid rgba(226,177,68,.35);
  background:rgba(10,20,15,.7);color:#fff}
.field input::placeholder{color:#6F8578;font-weight:400}

/* Knappstilen gällde bara <button>, aldrig <a>. En länk med class="btn" fick
   därför ingen knappstil alls — den blev en rad lila text, eftersom
   webbläsarens egen regel för besökta länkar (a:visited) väger tyngre än en
   klass. Därför står färgen utskriven för a.btn i alla lägen. */
button.btn,a.btn{display:block;width:100%;font:inherit;font-size:19px;font-weight:600;
  padding:18px 16px;border-radius:14px;border:0;background:#E2B144;color:#14231A;cursor:pointer;
  letter-spacing:-.01em;text-align:center;text-decoration:none;box-sizing:border-box}
a.btn,a.btn:link,a.btn:visited,a.btn:hover,a.btn:active{color:#14231A}
a.btn.ghost,a.btn.ghost:link,a.btn.ghost:visited{color:#E6EFE9}
button.btn[disabled]{opacity:.55;cursor:default}
button.btn:focus-visible,a.btn:focus-visible{outline:3px solid #F3D082;outline-offset:3px}
button.btn.ghost,a.btn.ghost{background:transparent;color:#E6EFE9;border:1.5px solid rgba(230,239,233,.35)}
button.btn.stop{background:transparent;color:#F0A79E;border:1.5px solid rgba(240,167,158,.5)}
button.btn + button.btn,a.btn + button.btn,button.btn + a.btn,a.btn + a.btn{margin-top:10px}

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
  // "Inte du?" — gäller bara det här besöket, nyckeln slängs inte.
  var glomKand = false;

  // Telefonen minns vilken laddning som är dess egen, så att kvittot kan visas
  // när sessionen tagit slut — och hittas igen senare om den är obetald.
  // Sparat lokalt i webblasaren; ingenting skickas nagonstans.
  var STORE = 'kps.receipt';
  function remember(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) {} }
  function recall() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function forget() { try { localStorage.removeItem(STORE); } catch (e) {} }

  /* Telefonens egen nyckel. Den bevisar vilket nummer telefonen tillhor, sa
     att man slipper vanta pa ett SMS varje gang.
     Pa en iPhone raderas det har efter sju dagar utan besok — om inte appen
     lagts till pa hemskarmen, som ar undantagen. Darfor manifestet i 0.7.1. */
  var DEV = 'kps.device';
  function devSave(t) { try { localStorage.setItem(DEV, t); } catch (e) {} }
  function devGet() { try { return localStorage.getItem(DEV) || null; } catch (e) { return null; } }
  function devForget() { try { localStorage.removeItem(DEV); } catch (e) {} }

  function kr(n) { return Number(n).toFixed(2).replace('.', ','); }
  function num(n, d) { return Number(n).toFixed(d === undefined ? 1 : d).replace('.', ','); }

  function duration(fromIso, tillIso) {
    if (!fromIso) return '';
    var slut = tillIso ? Date.parse(tillIso) : Date.now();
    var ms = slut - Date.parse(fromIso);
    if (!isFinite(ms) || ms < 0) ms = 0;
    var min = Math.floor(ms / 60000);
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (h > 0) return h + ' tim ' + m + ' min';
    return m + ' min';
  }

  /* ------------------------------------------------------------------ */
  /* Elpriset framåt                                                     */
  /* ------------------------------------------------------------------ */

  var SERIE_TOTAL = '#c98500';   // vårt pris — det gästen faktiskt betalar
  var SERIE_SPOT  = '#3987e5';   // elbörsen
  var curveOpen = false;         // överlever en ombyggnad av vyn
  var curveData = null;          // hämtas en gång, inte vid varje ritning

  function curveBlock() {
    return '<details class="curve-d"' + (curveOpen ? ' open' : '') + '>' +
      '<summary>Elpriset närmaste timmarna</summary>' +
      '<div class="dbody" id="curveBody">' +
      (curveData ? '' : '<p class="curvenote">Hämtar priserna…</p>') +
      '</div></details>';
  }

  function hookCurve() {
    var d = document.querySelector('.curve-d');
    if (!d) return;
    d.addEventListener('toggle', function () {
      curveOpen = d.open;
      if (d.open) laddaKurva();
    });
    if (d.open) laddaKurva();
  }

  function laddaKurva() {
    if (curveData) return ritaKurva();
    var dk = devGet();
    fetch('api/prices' + (dk ? '?d=' + encodeURIComponent(dk) : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) { curveData = data; ritaKurva(); },
            function () { kurvText('Priserna gick inte att hämta just nu.'); });
  }

  function kurvText(t) {
    var b = document.getElementById('curveBody');
    if (b) b.innerHTML = '<p class="curvenote">' + esc(t) + '</p>';
  }

  /**
   * En trappa, inte en lutande linje.
   *
   * Elbörsens pris är konstant inom varje kvart och byter tvärt vid kvartsskiftet.
   * En linje som lutar mellan punkterna påstår att priset glider däremellan, och
   * det gör det inte — man skulle läsa av fel pris för nästan varje tidpunkt.
   */
  function ritaKurva() {
    var b = document.getElementById('curveBody');
    if (!b || !curveData) return;
    var pts = curveData.points || [];
    if (pts.length < 2) {
      return kurvText('Elbörsen har inte lämnat några priser för de kommande timmarna än. '
        + 'Morgondagens priser brukar komma vid ettiden på eftermiddagen.');
    }

    var W = 320, H = 150, L = 40, R = 8, T = 12, B = 26;   // ritytans marginaler
    var t0 = Date.parse(pts[0].t);
    var t1 = Date.parse(pts[pts.length - 1].t) + 15 * 60000;   // sista kvarten räknas hel

    var hi = 0, lo = 0, i;
    for (i = 0; i < pts.length; i++) {
      if (pts[i].total > hi) hi = pts[i].total;
      if (pts[i].spot < lo) lo = pts[i].spot;      // spotpriset kan vara negativt
    }
    hi = Math.ceil(hi * 10) / 10 || 1;
    lo = Math.floor(lo * 10) / 10;
    if (hi - lo < 0.5) hi = lo + 0.5;

    var x = function (ms) { return L + (ms - t0) / (t1 - t0) * (W - L - R); };
    var y = function (v) { return T + (hi - v) / (hi - lo) * (H - T - B); };

    // Trappan: vågrätt genom kvarten, lodrätt vid skiftet.
    var trappa = function (falt) {
      var d = '';
      for (var i = 0; i < pts.length; i++) {
        var ms = Date.parse(pts[i].t);
        var yv = y(pts[i][falt]);
        d += (i === 0 ? 'M' : 'L') + x(ms).toFixed(1) + ' ' + yv.toFixed(1);
        d += 'L' + x(ms + 15 * 60000).toFixed(1) + ' ' + yv.toFixed(1);
      }
      return d;
    };

    // Hårfina stödlinjer, en nyans från bakgrunden. Aldrig streckade.
    var grid = '', etiketter = '';
    var steg = [lo, lo + (hi - lo) / 2, hi];
    for (i = 0; i < steg.length; i++) {
      var gy = y(steg[i]).toFixed(1);
      grid += '<line x1="' + L + '" y1="' + gy + '" x2="' + (W - R) + '" y2="' + gy + '" stroke="rgba(226,177,68,.14)" stroke-width="1"/>';
      etiketter += '<text x="' + (L - 6) + '" y="' + (Number(gy) + 4) + '" text-anchor="end" font-size="11" fill="#8FA398">' + kr(steg[i]) + '</text>';
    }
    // Nollinjen får synas när elbörsen går under noll. Att spotpriset kan vara
    // negativt medan ditt pris ändå är över en krona är hela poängen med att
    // visa båda kurvorna.
    if (lo < 0) {
      grid += '<line x1="' + L + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(0).toFixed(1) + '" stroke="rgba(230,239,233,.34)" stroke-width="1"/>';
      // Nollan får bara sitt namn utskrivet om den inte trängs med etiketten
      // under. Två tal ovanpå varandra är svårare att läsa än inget tal alls.
      if (Math.abs(y(0) - y(lo)) > 13) {
        grid += '<text x="' + (L - 6) + '" y="' + (y(0) + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#8FA398">0</text>';
      }
    }

    /* Timmarna längs botten, var tredje timme så de inte krockar.
       Vänsterkanten heter "nu" i stället för sitt klockslag. Kurvan börjar per
       definition i den kvart vi står i, så en lodrät nu-linje hade alltid legat
       längst till vänster och bara upprepat vad ramen redan säger — dessutom
       krockade dess etikett med det översta värdet på y-axeln. */
    var timmar = '<text x="' + L + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#BFD2C6">nu</text>';
    for (i = 0; i < pts.length; i++) {
      var d0 = new Date(pts[i].t);
      if (d0.getMinutes() !== 0 || d0.getHours() % 3 !== 0) continue;
      var tx = x(Date.parse(pts[i].t));
      if (tx > W - R - 12 || tx < L + 26) continue;
      timmar += '<text x="' + tx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#8FA398">'
        + tvasiffrig(d0.getHours()) + '</text>';
    }
    var nuLinje = '';

    // Billigaste kvarten — den enda punkt som är värd en egen etikett.
    var billigast = 0;
    for (i = 1; i < pts.length; i++) if (pts[i].total < pts[billigast].total) billigast = i;
    var bx = x(Date.parse(pts[billigast].t) + 7.5 * 60000), by = y(pts[billigast].total);
    var billigMark = '<circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="4" fill="' + SERIE_TOTAL + '" stroke="#12241b" stroke-width="2"/>';

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Elpriset de närmaste timmarna">'
      + grid + etiketter + timmar + nuLinje
      + '<path d="' + trappa('spot') + '" fill="none" stroke="' + SERIE_SPOT + '" stroke-width="2" stroke-linejoin="round"/>'
      + '<path d="' + trappa('total') + '" fill="none" stroke="' + SERIE_TOTAL + '" stroke-width="2" stroke-linejoin="round"/>'
      + billigMark
      + '<line id="cross" x1="0" y1="' + T + '" x2="0" y2="' + (H - B) + '" stroke="#E6EFE9" stroke-width="1" opacity="0"/>'
      + '<rect id="hit" x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '" fill="transparent"/>'
      + '</svg>';

    var d1 = new Date(pts[billigast].t);
    b.innerHTML =
      '<div class="legend">'
      + '<span><i style="background:' + SERIE_TOTAL + '"></i>Vårt pris</span>'
      + '<span><i style="background:' + SERIE_SPOT + '"></i>Elbörsen</span>'
      + '</div>'
      + '<div class="curve">' + svg + '</div>'
      + '<div class="readout" id="readout">Billigast ' + tvasiffrig(d1.getHours()) + ':' + tvasiffrig(d1.getMinutes())
      + ' — <b>' + kr(pts[billigast].total) + ' kr/kWh</b></div>'
      + '<p class="curvenote">Dra fingret över kurvan för att se priset en viss tid. '
      + 'Priset gäller kvarten ut och byter tvärt vid kvartsskiftet — därför trappstegen.</p>';

    kopplaKrysshar(b, pts, x, t0, t1, L, W, R);
  }

  function tvasiffrig(n) { return (n < 10 ? '0' : '') + n; }

  /** Dra fingret, läs priset. Träffytan är hela diagrammets höjd. */
  function kopplaKrysshar(b, pts, x, t0, t1, L, W, R) {
    var svg = b.querySelector('svg');
    var cross = b.querySelector('#cross');
    var hit = b.querySelector('#hit');
    var ut = b.querySelector('#readout');
    if (!svg || !cross || !hit || !ut) return;
    var original = ut.innerHTML;

    function las(ev) {
      var box = svg.getBoundingClientRect();
      var px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left) / box.width * W;
      var andel = (px - L) / (W - L - R);
      if (andel < 0) andel = 0; if (andel > 1) andel = 1;
      var ms = t0 + andel * (t1 - t0);
      var narmast = 0, bast = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.abs(Date.parse(pts[i].t) + 7.5 * 60000 - ms);
        if (d < bast) { bast = d; narmast = i; }
      }
      var p = pts[narmast], dt = new Date(p.t);
      cross.setAttribute('x1', x(Date.parse(p.t) + 7.5 * 60000).toFixed(1));
      cross.setAttribute('x2', x(Date.parse(p.t) + 7.5 * 60000).toFixed(1));
      cross.setAttribute('opacity', '1');
      ut.innerHTML = tvasiffrig(dt.getHours()) + ':' + tvasiffrig(dt.getMinutes())
        + ' — <b>' + kr(p.total) + ' kr/kWh</b>, varav elbörsen ' + kr(p.spot) + ' kr';
    }
    function slapp() { cross.setAttribute('opacity', '0'); ut.innerHTML = original; }

    hit.addEventListener('pointerdown', las);
    hit.addEventListener('pointermove', function (e) { if (e.buttons || e.pointerType === 'touch') las(e); });
    hit.addEventListener('pointerup', slapp);
    hit.addEventListener('pointerleave', slapp);
    hit.addEventListener('pointercancel', slapp);
  }

  function priceBlock(p, compact) {
    if (!p) {
      // Panelen följer med även utan prisuppgift. Den som undrar varför priset
      // saknas får svaret där — i stället för en tom rad utan förklaring.
      return '<div class="pricebox"><div class="lbl">Priset just nu</div>' +
             '<div class="sub" style="margin-top:0">Prisuppgift saknas just nu.<br>Laddningen mäts ändå och räknas rätt.</div></div>' +
             curveBlock();
    }
    if (compact) {
      return '<div class="pricebox" style="padding:13px 14px"><div class="sub" style="margin-top:0">' +
             'Priset just nu <strong style="color:#F3D082">' + kr(p.totalSek) + ' kr/kWh</strong><br>' +
             'Varav elbörsen ' + kr(p.spotSek) + ' kr.</div></div>' +
             curveBlock();
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
      '</div></details>' +
      curveBlock();
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
               s.mine, s.known && s.known.phone, s.free, glomKand,
               receipt && receipt.number].join('|');

    /* Rör inte DOM:en om ingenting ändrats.
       Villkoret var "key === lastKey && typing", alltså hoppade den bara över
       ombyggnaden medan någon skrev i ett fält. Resten av tiden byggdes hela
       vyn om vid varje avläsning — var femte sekund — och skrev då tillbaka
       serverns råa energivärde i rutan. Mellan gångerna räknade tickSmooth()
       upp den fyra gånger i sekunden. Resultatet var sågtanden: 29,45 · 29,46 ·
       29,47 · 29,45 · 29,46 … i all oändlighet, eftersom serverns värde inte
       hann ändra sig mellan pollningarna. */
    if (key === lastKey) return;
    lastKey = key;

    var liveClass = 'live', liveText = 'Ledig';
    if (s.view === 'charging') { liveText = 'Laddar'; }
    else if (s.view === 'busy') { liveClass = 'live busy'; liveText = 'Upptagen'; }
    else if (s.view === 'ready') { liveText = 'Kabel ansluten'; }
    else if (s.view === 'finished') { liveClass = 'live busy'; liveText = 'Klar, kabeln kvar'; }
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

    } else if (s.view === 'ready' && s.known && !glomKand) {
      /* Telefonen känns igen. Numret bevisades en gång och nyckeln har burit
         det sedan dess — alltså inget textfält, ingen väntan på SMS, ett tryck.
         Det här är hela poängen med steg tre: de som laddar ofta ska inte
         behöva göra om verifieringen varje gång. */
      el.icon.innerHTML = ICONS.check; el.icon.style.display = '';
      el.title.textContent = 'Redo att ladda';
      el.lead.innerHTML = 'Vi känner igen den här telefonen.<span class="tel">'
        + escTel(s.known.phone) + '</span>';
      el.slot.innerHTML = noticeBlock() + staleBlock(s) + receiptBanner() +
        '<button class="btn" id="oneTapBtn"' + (busyAction ? ' disabled' : '') + '>'
        + (busyAction ? 'Startar…' : 'Starta laddning') + '</button>' +
        (s.known.free
          ? '<div class="msg info">Din laddning är fri. Priset nedan är vad elen kostar — avgiften för stolpen tillkommer inte.</div>'
          : '') +
        '<p style="text-align:center;font-size:14.5px;margin:16px 0 0">' +
        '<button class="linkish" id="otherPhone" style="color:#BFD2C6">Inte du? Använd ett annat nummer</button></p>' +
        priceBlock(s.price, true);

      var ot = document.getElementById('oneTapBtn');
      if (ot) ot.addEventListener('click', function () { doStart(null, null, devGet()); });
      var op = document.getElementById('otherPhone');
      if (op) op.addEventListener('click', function () {
        // Bara den här gången — nyckeln slängs inte, för telefonen kan mycket
        // väl vara rätt nästa gång även om någon annan lånar den nu.
        glomKand = true; lastKey = ''; safeRender();
      });

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
      var min = !!s.mine;
      el.icon.style.display = 'none';
      // Rubriken beror på VEM som tittar, inte bara på vad boxen gör. För den
      // som inte äger laddningen är "Startar laddningen" missvisande — det
      // låter som något hen själv satt igång.
      el.title.textContent = min
        ? (starting ? 'Startar laddningen' : 'Laddar')
        : 'Stolpen används';
      el.lead.textContent = min
        ? (starting
            ? 'Laddstolpen svarar. Det kan ta en halv minut innan bilen börjar dra ström.'
            : 'Du kan låsa mobilen och gå. Laddningen mäts vidare.')
        : (starting
            ? 'Någon annan har just startat en laddning här.'
            : 'Någon annan laddar just nu. Stolpen blir ledig när den bilen är klar och kabeln dras ur.');
      el.slot.innerHTML = noticeBlock() + staleBlock(s) +
        (ses.free && min ? '<div class="msg info">Fri laddning — ingen betalning. Siffran visar vad elen kostar.</div>' : '') +
        '<div class="runline">' + ICONS.bolt + 'Pågått i <span id="vDur">' + duration(ses.startedAt) + '</span></div>' +
        '<div class="stats">' +
          '<div class="stat wide"><div class="l">' + (ses.free ? 'Elkostnad hittills' : (min ? 'Att betala hittills' : 'Laddat för hittills')) + '</div><div><span class="v" id="vKr">' + kr(ses.costSek) + '</span><span class="u">kr</span></div></div>' +
          '<div class="stat"><div class="l">Laddat</div><div><span class="v" id="vKwh">' + num(ses.energyKwh, 2) + '</span><span class="u">kWh</span></div></div>' +
          '<div class="stat"><div class="l">Effekt</div><div><span class="v" id="vKw">' + num(ses.powerKw) + '</span><span class="u">kW</span></div></div>' +
        '</div>' +
        (s.price ? '<details><summary>Vad kostar det just nu?</summary><div class="dbody">' +
          '<div class="drow"><span>Priset denna kvart</span><span>' + kr(s.price.totalSek) + ' kr/kWh</span></div>' +
          '<div class="drow"><span>Varav elbörsen</span><span>' + kr(s.price.spotSek) + ' kr</span></div>' +
          '</div></details>' : '') +
        // Bara den som startade laddningen får avsluta den. Knappen fanns för
        // alla förut, och /api/stop frågade inte heller — vem som helst som
        // öppnade adressen kunde alltså avbryta grannens laddning.
        (min
          ? '<button class="btn stop" id="stopBtn" style="margin-top:14px"' + (busyAction || starting ? ' disabled' : '') + '>' +
            (busyAction === 'stop' ? 'Avslutar…' : (starting ? 'Väntar på laddboxen…' : 'Avsluta laddning')) + '</button>'
          : '<p class="note" style="text-align:center;margin-top:16px;font-size:14px;color:#93A39B">Bara den som startade laddningen kan avsluta den.</p>');

      var sb = document.getElementById('stopBtn');
      if (sb) sb.addEventListener('click', doStop);

    } else if (s.view === 'finished') {
      /* Bilen är klar men kabeln sitter kvar. Skärmen ska svara på två frågor
         samtidigt: gästen som laddat vill veta att det är klart och vad det
         kostade, och den som kommer gående vill veta om stolpen blir ledig. */
      var f = s.session || {};
      var mitt = !!s.mine;
      el.icon.innerHTML = ICONS.check; el.icon.style.display = '';
      el.title.textContent = mitt ? 'Din bil är klar' : 'Bilen är klar';
      el.lead.textContent = mitt
        ? (f.free
            ? 'Laddningen är avslutad. Dra ur kabeln när du åker.'
            : 'Laddningen är avslutad. Dra ur kabeln när du åker, så får du kvittot via SMS.')
        : 'Laddningen är avslutad, men bilen står kvar. Stolpen blir ledig när kabeln dras ur.';

      el.slot.innerHTML = noticeBlock() + staleBlock(s) +
        '<div class="stats">' +
          '<div class="stat wide"><div class="l">' + (f.free ? 'Elkostnad' : (mitt ? 'Att betala' : 'Laddat för')) + '</div><div><span class="v">' + kr(f.costSek) + '</span><span class="u">kr</span></div></div>' +
          '<div class="stat"><div class="l">Laddat</div><div><span class="v">' + num(f.energyKwh, 2) + '</span><span class="u">kWh</span></div></div>' +
          '<div class="stat"><div class="l">Laddade i</div><div><span class="v" style="font-size:24px">' + duration(f.startedAt, f.chargingEndedAt) + '</span></div></div>' +
        '</div>' +
        (f.unpricedKwh > 0 ? '<div class="msg info">' + num(f.unpricedKwh, 2) + ' kWh är ännu inte prissatta — appen saknar elpris för den perioden.</div>' : '') +
        (f.free
          ? '<div class="msg info">Fri laddning — ingen betalning.</div>'
          : '<div class="msg info">Kvittot skickas när kabeln dras ur.</div>') +
        (mitt && f.receiptKey ? '<a class="btn ghost" href="k/' + encodeURIComponent(f.receiptKey) + '">' + (f.free ? 'Visa sammanställning' : 'Öppna kvitto och betala') + '</a>' : '');

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
        // Här stod "Swish och SMS-kvitto kopplas in i fas 5" kvar sedan fas 2.
        // Båda finns sedan länge — och det är betalningen gästen ska ledas till.
        // Har gästen redan kvitterat ska knappen inte be om betalning igen.
        (d.free
          ? '<div class="msg info">Fri laddning — ingen betalning. Siffran visar vad elen kostade.</div>'
          : !Number(d.costSek)
            ? '<div class="msg info">Summan blev noll kronor. Det finns ingenting att betala.</div>'
          : (d.payment === 'GUEST_CLAIMS_PAID'
              ? '<div class="msg info">Du har markerat laddningen som betald. Väntar på bekräftelse.</div>'
                + (d.receiptKey ? '<a class="btn ghost" href="k/' + encodeURIComponent(d.receiptKey) + '">Visa kvitto</a>' : '')
              : (d.receiptKey
                  ? '<a class="btn" href="k/' + encodeURIComponent(d.receiptKey) + '">Betala med Swish</a>'
                  : ''))) +
        (d.free || !Number(d.costSek) || d.payment === 'GUEST_CLAIMS_PAID' ? '' :
          '<p style="text-align:center;font-size:14px;color:#93A39B;margin:14px 0 0;line-height:1.5">' +
          'Kvittot har skickats till din mobil. Länken i SMS:et leder hit och fungerar tills du betalat.</p>') +
        '<button class="btn ghost" id="againBtn">' + (d.free ? 'Klar' : 'Stäng') + '</button>';
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

    // Prispanelen finns bara i några vyer; hookCurve gör ingenting i de andra.
    hookCurve();

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
    // Telefonen visar upp sin kvittonyckel. Stämmer den med den pågående
    // laddningen svarar servern att laddningen är gästens egen och skickar med
    // vägen till betalsidan. Utan nyckel: samma vy, men ingen betallänk.
    var sparad = recall();
    var d = devGet();
    var q = [];
    if (sparad && sparad.key) q.push('k=' + encodeURIComponent(sparad.key));
    if (d) q.push('d=' + encodeURIComponent(d));
    fetch('api/status' + (q.length ? '?' + q.join('&') : ''), { cache: 'no-store' })
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
          /* En fri laddning ar ingen utestaende rakning. Sammanstallningen far
             visas en gang, sedan ska den ur vagen — annars motte familjen
             gardagens kvitto i stallet for startsidan nasta gang de skulle
             ladda. Sidan finns kvar pa sin egen adress for den som vill se den. */
          /* En fri laddning ar ingen utestaende rakning och far inte mota
             familjen som "gardagens kvitto" nasta gang de ska ladda. Men den
             ska hinna lasas.
             Ratt signal ar inte klockan utan kabeln: har nagon satt i kabeln
             pa nytt sedan dess ar den laddningen over — da slapper vi fram
             startsidan. En obetald rakning ligger daremot kvar, for den ar
             fortfarande skuld. */
          if (receipt.payment === 'FREE' && receipt.cableEpisode
              && state.cableEpisode > receipt.cableEpisode) {
            forget(); receipt = null; state.view = 'idle'; state.session = null;
          }
        }
      })
      .catch(function (err) {
        // Tyst svald forr. Ett fel har ar ett fel i appen och ska synas.
        if (window.console && console.error) console.error('Fel vid kvittouppslag:', err);
        reportClientError(err);
        receipt = null;
      });
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
  /* Vad som senast visades, så siffrorna aldrig backar. Energi som gått genom
     kabeln kommer inte tillbaka; ser man talet sjunka tror man att appen räknar
     fel. Är uppskattningen före det uppmätta värdet får den stå still tills
     mätvärdet hunnit ikapp, i stället för att hoppa bakåt. */
  var visadKwh = 0, visadKr = 0, visadFor = null;

  // Hur länge vi vågar räkna vidare på egen hand. Har vi inte hört av boxen på
  // en och en halv minut vet vi inte att bilen fortfarande laddar, och då ska
  // siffran stå stilla i stället för att uppfinna energi.
  var MAX_GISSNING_MS = 90 * 1000;

  function tickSmooth() {
    if (!state || state.view !== 'charging' || !state.session) return;
    var ses = state.session;
    var kwEl = document.getElementById('vKw');
    if (!kwEl) return;

    if (visadFor !== ses.number) { visadFor = ses.number; visadKwh = 0; visadKr = 0; }

    var sinceMeasureMs = Math.min(lagMs + (Date.now() - receivedAt), MAX_GISSNING_MS);
    var extraKwh = (Number(ses.powerKw) || 0) * (sinceMeasureMs / 3600000);
    var estKwh = Number(ses.energyKwh) + extraKwh;
    var estKr = Number(ses.costSek) + (state.price ? extraKwh * state.price.totalSek : 0);

    estKwh = Math.max(estKwh, visadKwh); visadKwh = estKwh;
    estKr = Math.max(estKr, visadKr); visadKr = estKr;

    var krEl = document.getElementById('vKr');
    var kwhEl = document.getElementById('vKwh');
    var durEl = document.getElementById('vDur');
    if (krEl) krEl.textContent = kr(estKr);
    if (kwhEl) kwhEl.textContent = num(estKwh, 2);
    kwEl.textContent = num(ses.powerKw);
    if (durEl) durEl.textContent = duration(ses.startedAt);
  }

  function receiptBanner() {
    // Fri laddning har inget att betala och ska inte ligga och pasta motsatsen.
    if (!receipt || receipt.status !== 'COMPLETED' || receipt.payment === 'FREE') return '';
    if (!Number(receipt.costSek)) return '';   // noll kronor ar inget att paminna om
    /* Har gasten redan kvitterat far banderollen inte fortsatta kalla
       laddningen obetald. Det var motsagelsen: man tryckte "Jag har betalat"
       och mottes anda av "du har en obetald laddning" pa nasta skarm. */
    var kvitterad = receipt.payment === 'GUEST_CLAIMS_PAID';
    var text = kvitterad
      ? 'Din laddning på ' + kr(receipt.costSek) + ' kr väntar på bekräftelse.'
      : 'Du har en obetald laddning på ' + kr(receipt.costSek) + ' kr.';
    return '<div class="msg info" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
      '<span>' + text + '</span>' +
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
        // Koden stämde. Servern skickar med en nyckel till telefonen så att den
        // slipper göra om det här nästa gång — ett tryck räcker då.
        if (res.body.device) devSave(res.body.device);
        return doStart(null, verifyToken);
      })
      .catch(function () { busyAction = null; setNotice('err', 'Ingen kontakt med servern.'); });
  }

  function doStart(phone, token, device) {
    busyAction = 'start'; setNotice(null, null); lastKey = ''; safeRender();
    fetch('api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(device ? { device: device } : (token ? { token: token } : { phone: phone }))
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        busyAction = null;
        verifyToken = null; verifyPhone = null;
        if (!res.ok) {
          // Nyckeln duger inte längre — spärrad, okänd eller avstängd funktion.
          // Glöm den, annars fastnar telefonen i ett läge som inte går att ta
          // sig ur: knappen syns men fungerar aldrig.
          if (res.body.forgetDevice) { devForget(); lastKey = ''; }
          setNotice('err', res.body.error || 'Laddningen kunde inte startas.');
          return;
        }
        if (res.body.session && res.body.session.receiptKey) {
          remember({ key: res.body.session.receiptKey, dismissed: false });
        }
        poll();
      })
      .catch(function () { busyAction = null; setNotice('err', 'Ingen kontakt med servern.'); });
  }

  function doStop() {
    busyAction = 'stop'; setNotice(null, null);
    var sparad = recall();
    fetch('api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ k: sparad && sparad.key ? sparad.key : null })
    })
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

  /**
   * Kom vi hit via länken i SMS:et? Då bär adressen laddningens kvittonyckel,
   * och telefonen ska minnas den.
   *
   * Utan det här visste sidan bara om laddningen var "min" ifall just den här
   * webblasaren tryckt på startknappen. Startade man via SMS-länken var
   * telefonen en främling för sin egen laddning: den fick ingen betallänk, och
   * när kabeln drogs ur hände ingenting på skärmen.
   *
   * Nyckeln plockas bort ur adressraden direkt, så den inte följer med om
   * sidan delas eller hamnar i historiken.
   */
  (function fangaNyckel() {
    try {
      var m = location.search.match(/[?&]k=([A-Za-z0-9_-]+)/);
      if (!m) return;
      remember({ key: decodeURIComponent(m[1]), dismissed: false });
      if (history.replaceState) history.replaceState(null, '', location.pathname);
    } catch (e) { /* ingen nyckel, inget problem */ }
  })();

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
/* 11  Adminfliken                                                           */
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

    h += '<div class="h">Fri laddning</div><div class="card">'
      + '<div class="row"><span><span class="lab">Nummer som laddar utan att betala</span>'
      + '<div class="hint">Ett per rad. Skriv som du vill — 070-123 45 67 och +46701234567 '
      + 'raknas som samma nummer.<br>Laddningen registreras anda, med den verkliga elkostnaden, '
      + 'sa att du ser vad hushallets egen laddning kostar. Det som uteblir ar avgiften for stolpen, '
      + 'kravet pa betalning och kvitto-SMS:et.</div></span></div>'
      + '<textarea class="ta" id="fritt" style="width:100%;min-height:70px;font-family:ui-monospace,Menlo,monospace;'
      + 'font-size:13px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:8px">'
      + esc((D.settings.freeNumbers||[]).join('\\n')) + '</textarea>'
      + '<div class="btns" style="margin-top:10px"><button class="b" data-act="savefree">Spara fria nummer</button></div>'
      + '<p class="note" style="margin:12px 0 0">Statusen slas upp vid varje start. Tar du bort ett '
      + 'nummer harifran borjar det betala nasta gang, utan att nagon behover rora deras telefon. '
      + 'En pagaende laddning behaller det den startade med.</p></div>';

    h += '<div class="h">Ihågkomna telefoner</div><div class="card">'
      + '<div class="row"><span><span class="lab">Kom ihag telefoner</span>'
      + '<div class="hint">Den som en gang bekraftat sitt nummer slipper SMS nasta gang och startar '
      + 'med ett tryck. Nyckeln sparas bara som hash — aldrig i klartext.</div></span>'
      + '<span><button class="b" data-act="toggleremember">' + (D.settings.rememberDevices ? 'Pa' : 'Av') + '</button></span></div>';

    if (!(D.devices||[]).length) {
      h += '<p class="note" style="margin:12px 0 0">Ingen telefon ar ihagkommen an.</p>';
    } else {
      h += '<div class="tw"><table><tbody>';
      (D.devices||[]).forEach(function(d){
        h += '<tr><td>' + esc(d.name || d.phone)
          + (d.free ? ' <span class="pill p-ok">fri</span>' : '')
          + (d.revoked ? ' <span class="pill p-warn">sparrad</span>' : '')
          + '<div class="hint">' + esc(d.phone) + ' &middot; anvand ' + ts(d.lastUsedAt) + '</div></td>'
          + '<td style="text-align:right;white-space:nowrap">'
          + '<button class="b" data-act="namedev" data-id="' + esc(d.id) + '">Namnge</button> '
          + (d.revoked ? '' : '<button class="b danger" data-act="revokedev" data-id="' + esc(d.id) + '">Sparra</button>')
          + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '</div>';

    h += '<div class="h">Verifiering</div><div class="card">'
      + '<div class="row"><span><span class="lab">Kräv verifiering av mobilnummer</span>'
      + '<div class="hint">Utan detta är numret bara ett textfält. Stäng bara av vid felsökning.</div></span>'
      + '<span><button class="b" data-act="toggleverify">' + (st.requireVerification ? 'På' : 'Av') + '</button></span></div>'
      + inp('maxStartsPerHourPerIp','Startförsök per timme och plats',
            'Skyddar mot att nagon hamrar pa stolpen utifran. Hela hushallet delar '
            + 'IP-adress, och aven nekade forsok raknas.',st.maxStartsPerHourPerIp,'st')
      + row('Väntande koder', String(D.verify.pending))
      + '<div class="btns" style="margin-top:10px"><button class="b gold" data-act="savesettings">Spara</button></div>'
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
        + '<button class="b" data-act="sim" data-cmd="full">Bilen är full</button>'
        + '<button class="b" data-act="sim" data-cmd="wake">Bilen drar ström igen</button>'
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
      h += '<div class="h">Rå API-inspektör</div><div class="btns">'
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
    } else if (act === 'savefree') {
      var tf = document.getElementById('fritt');
      var fl = tf.value.split('\\n').map(function(x){ return x.trim(); }).filter(Boolean);
      api('api/admin/settings', { freeNumbers: fl }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Fria nummer sparade.':(r.body.error||'Kunde inte spara.')); load();
      });
    } else if (act === 'toggleremember') {
      api('api/admin/settings', { rememberDevices: !D.settings.rememberDevices }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Sparat.':(r.body.error||'Kunde inte spara.')); load();
      });
    } else if (act === 'revokedev') {
      if (!confirm('Sparra den har telefonen? Den maste bekrafta sitt nummer med SMS igen.')) return;
      api('api/admin/device/revoke', { id: b.dataset.id }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Telefonen sparrad.':(r.body.error||'Misslyckades.')); load();
      });
    } else if (act === 'namedev') {
      var namn = prompt('Vad ska telefonen heta? Till exempel "Emils telefon".');
      if (namn === null) return;
      api('api/admin/device/name', { id: b.dataset.id, name: namn }).then(function(r){
        flash(r.ok?'ok':'bad', r.ok?'Sparat.':(r.body.error||'Misslyckades.')); load();
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
/* 12  SMS                                                                   */
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

    // 46elks id och status med i loggen. Ett 200-svar betyder bara att de tagit
    // emot meddelandet, inte att det kommit fram — utan id:t går det inte att
    // spåra i deras panel när ett SMS uteblir.
    const spar = data && data.id ? ` [46elks ${data.id}${data.status ? ' ' + data.status : ''}]` : '';
    log.info(`[SMS] ${effective === 'dryrun' ? 'Torrkörning' : 'Lämnat till 46elks'} ${kind} till ${maskPhone(to)} (${m.parts} del${m.parts > 1 ? 'ar' : ''})${spar}.`);
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
/* 13  Ihågkomna telefoner                                                   */
/* ========================================================================== */

const devices = (function () {
/**
 * En telefon som en gang bekraftat sitt nummer slipper gora det igen.
 *
 * Nyckeln har oppnar ett las. Darfor tre regler:
 *
 *  1. SPARAS ALDRIG I KLARTEXT. Bara en hash av nyckeln hamnar pa disk, precis
 *     som ett losenord. Kommer nagon over filen far de inte med sig nagot som
 *     gar att anvanda mot stolpen.
 *
 *  2. NYCKELN BAR IDENTITET, INTE RATTIGHET. Den sager vilket NUMMER telefonen
 *     tillhor — inget mer. Om numret laddar gratis avgors vid varje start mot
 *     den aktuella listan. Tar du bort nagon ur den borjar de betala nasta
 *     gang, utan att nagon behover rora deras telefon.
 *
 *  3. GAR ATT SPARRA. Varje telefon syns i adminfliken med nar den senast
 *     anvandes, och en sparr galler omedelbart.
 */

const FILE = 'devices.json';
const MAX = 50;

let list = [];
const writer = store.throttledWriter(FILE, 30 * 1000);

function load() {
  const raw = store.readJson(FILE, null);
  list = Array.isArray(raw) ? raw : [];
  if (list.length) log.info(`${list.length} ihagkomna telefoner inlasta.`);
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length > 4 ? `${s.slice(0, 3)}…${s.slice(-2)}` : '…';
}

/** Ny nyckel till en telefon. Klartexten returneras EN gang och sparas aldrig. */
function issue(phone) {
  if (!config.settings().rememberDevices) return null;
  if (!phone) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const post = {
    id: crypto.randomUUID(),
    hash: hash(token),
    phone,
    name: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    revoked: false,
  };

  // Samma nummer far ha flera telefoner, men inte hur manga som helst.
  const egna = list.filter((d) => d.phone === phone && !d.revoked);
  if (egna.length >= 5) {
    const aldst = egna.sort((a, b) => String(a.lastUsedAt).localeCompare(String(b.lastUsedAt)))[0];
    aldst.revoked = true;
    aldst.revokedAt = new Date().toISOString();
    aldst.revokedReason = 'ersatt av en nyare telefon';
  }

  list.push(post);
  while (list.length > MAX) list.shift();
  writer.save(list, { immediate: true });
  log.info(`Telefon ihagkommen for ${maskPhone(phone)}.`);
  return token;
}

/** Vem ar det som knackar? Null om nyckeln ar okand eller sparrad. */
function resolve(token) {
  if (!token || !config.settings().rememberDevices) return null;
  const h = hash(token);
  const d = list.find((x) => x.hash === h);
  if (!d || d.revoked) return null;

  // Strypt skrivning: senast anvand behover inte till disk vid varje anrop.
  d.lastUsedAt = new Date().toISOString();
  writer.save(list);

  return { id: d.id, phone: d.phone, free: config.isFreeNumber(d.phone), name: d.name };
}

/** For adminfliken. Aldrig nyckeln, aldrig hela numret. */
function all() {
  return list.slice().reverse().map((d) => ({
    id: d.id,
    phone: maskPhone(d.phone),
    free: config.isFreeNumber(d.phone),
    name: d.name,
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    revoked: Boolean(d.revoked),
    revokedReason: d.revokedReason || null,
  }));
}

function revoke(id) {
  const d = list.find((x) => x.id === id);
  if (!d) return { ok: false, error: 'Telefonen hittades inte.' };
  d.revoked = true;
  d.revokedAt = new Date().toISOString();
  d.revokedReason = 'sparrad fran adminfliken';
  writer.save(list, { immediate: true });
  log.info(`Telefon sparrad: ${maskPhone(d.phone)}.`);
  return { ok: true };
}

function rename(id, name) {
  const d = list.find((x) => x.id === id);
  if (!d) return { ok: false, error: 'Telefonen hittades inte.' };
  d.name = String(name || '').trim().slice(0, 40) || null;
  writer.save(list, { immediate: true });
  return { ok: true };
}

/** Nar ett nummer plockas bort ur den fria listan ar inget att gora — fri
 *  status slas upp vid varje start. Den har finns for det otacka fallet:
 *  numret ska inte langre komma in alls. */
function revokeByPhone(phone) {
  let n = 0;
  for (const d of list) {
    if (d.phone === phone && !d.revoked) {
      d.revoked = true; d.revokedAt = new Date().toISOString();
      d.revokedReason = 'numret sparrat'; n += 1;
    }
  }
  if (n) writer.save(list, { immediate: true });
  return n;
}

function flush() { writer.flush(); }

return { load, issue, resolve, all, revoke, rename, revokeByPhone, flush, maskPhone };
})();

/* ========================================================================== */
/* 14  Verifiering av mobilnummer                                            */
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
/* 15  QR-koder                                                              */
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
/* 16  Swish                                                                 */
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
/* 17  Kvittosidan                                                           */
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
/**
 * Tidigare laddningar från samma mobilnummer.
 *
 * Gästen vill kunna se vad tidigare gånger kostade, och hitta tillbaka till en
 * räkning som inte är betald. Listan visar aldrig numret — bara datum, mängd,
 * belopp och status, med länk till respektive kvitto.
 *
 * Notera vad det innebär: den som får den här länken vidarebefordrad ser också
 * personens övriga laddningar hos dig. Det är en medveten avvägning.
 */
function historyBlock(rader, denna) {
  const andra = (rader || []).filter((s) => s.receiptKey !== denna);
  if (!andra.length) return '';

  const obetalda = andra.filter((s) => s.payment !== 'CONFIRMED' && s.payment !== 'FREE').length;
  const rows = andra.map((s) => {
    const status = s.payment === 'FREE' ? 'fri'
      : s.payment === 'CONFIRMED' ? 'betald'
      : s.payment === 'GUEST_CLAIMS_PAID' ? 'markerad betald' : 'obetald';
    const cls = (s.payment === 'CONFIRMED' || s.payment === 'FREE') ? 'p-paid'
      : s.payment === 'GUEST_CLAIMS_PAID' ? 'p-claim' : 'p-open';
    return `<a class="hrow" href="${esc(s.receiptKey)}">
      <span class="hwhen">${esc(kortDatum(s.startedAt))}<span class="hkwh">${kwh(s.energyKwh)} kWh</span></span>
      <span class="hsum">${kr(s.costSek)} kr<span class="pill ${cls}">${status}</span></span>
    </a>`;
  }).join('');

  return `<div class="card">
    <h2 class="h2">Dina tidigare laddningar</h2>
    <p class="sub">${andra.length} ${andra.length === 1 ? 'laddning' : 'laddningar'}${obetalda ? `, varav ${obetalda} obetald${obetalda === 1 ? '' : 'a'}` : ', alla betalda'}.</p>
    ${rows}
  </div>`;
}

function kortDatum(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('sv-SE', {
    timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function render(session, swishData, place, tidigare) {
  // Fri laddning: sammanställning, inte räkning. Ingen Swish, ingen knapp att
  // markera som betald — det finns ingenting att betala.
  const fri = session.free === true || session.payment === 'FREE';
  // En laddning som slutade på noll kronor har ingenting att betala. Att kalla
  // den "obetald" och inte erbjuda nagon vag att betala vore att be om nagot
  // som inte gar att gora.
  const inget = !fri && Number(session.costSek) === 0;
  const paid = session.payment === 'CONFIRMED';
  const claimed = session.payment === 'GUEST_CLAIMS_PAID';

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0a140f">
<link rel="manifest" href="../manifest.webmanifest">
<link rel="icon" href="../icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="../icon-180.png">
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
 cursor:pointer;text-decoration:none;margin-top:16px;box-sizing:border-box}
/* a:visited i webblasarens egen stilmall vager tyngre an en klass, sa fargen
   maste skrivas ut for lankarna — annars blir knappen en rad lila text. */
a.btn,a.btn:link,a.btn:visited,a.btn:hover,a.btn:active{color:#14231A}
a.btn.ghost,a.btn.ghost:link,a.btn.ghost:visited{color:#E6EFE9}
.btn.ghost{background:transparent;color:#E6EFE9;border:1.5px solid rgba(230,239,233,.35)}
.btn[disabled]{opacity:.5}
.btn:focus-visible{outline:3px solid #F3D082;outline-offset:3px}
.manual{margin-top:20px;padding-top:18px;border-top:1px solid rgba(226,177,68,.14);
 font-size:14.5px;color:#AFC5B6;line-height:1.6}
.manual b{color:#EDF3EF;font-variant-numeric:tabular-nums}
.note{margin-top:18px;font-size:13px;color:rgba(232,240,234,.45);line-height:1.6;text-align:center}
.msg{margin-top:14px;padding:12px 14px;border-radius:11px;font-size:14.5px;line-height:1.5;
 background:rgba(226,177,68,.1);border:1px solid rgba(226,177,68,.35);color:#EBCE93}
.msg.claim{background:rgba(111,211,155,.09);border-color:rgba(111,211,155,.35);color:#BFE6CF}
details{border-top:1px solid rgba(226,177,68,.18);margin-top:16px}
summary{list-style:none;cursor:pointer;padding:13px 2px;font-size:15px;color:#C4D6C9;
 display:flex;justify-content:space-between;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";font-size:19px;color:#E2B144;line-height:1}
details[open] summary::after{content:"–"}
.dbody{padding:0 2px 8px}

.h2{font-size:19px;font-weight:600;margin:0 0 4px;color:#fff}
.hrow{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;
 padding:14px 2px;border-top:1px solid rgba(226,177,68,.14);text-decoration:none;color:inherit}
.hwhen{font-size:15.5px;color:#E6EFE9;display:flex;flex-direction:column;gap:3px}
.hkwh{font-size:13.5px;color:#95AC9E;font-variant-numeric:tabular-nums}
.hsum{font-size:16.5px;font-weight:600;color:#F3D082;text-align:right;white-space:nowrap;
 display:flex;flex-direction:column;align-items:flex-end;gap:5px;font-variant-numeric:tabular-nums}
.hsum .pill{font-weight:500}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <span class="place">${esc(place)}</span>
    <span class="pill ${fri || inget || paid ? 'p-paid' : claimed ? 'p-claim' : 'p-open'}">
      ${fri ? 'Fri laddning' : inget ? 'Inget att betala' : paid ? 'Betald' : claimed ? 'Du har markerat betald' : 'Obetald'}
    </span>
  </div>

  <div class="card">
    <h1>${fri ? 'Din laddning' : 'Kvitto'}</h1>
    <p class="sub">Laddning ${esc(when(session.startedAt))}${
      session.endedAt ? `,<br>pågick i ${esc(duration(session.startedAt, session.endedAt))}` : ''
    }.</p>

    <div class="r"><span>Laddat</span><span>${kwh(session.energyKwh)} kWh</span></div>
    <div class="r"><span>Elkostnad</span><span>${kr(session.costEnergySek)} kr</span></div>
    ${fri ? '' : `<div class="r"><span>Avgift laddstolpe</span><span>${kr(session.costServiceSek)} kr</span></div>`}
    <div class="r total"><span>${fri ? 'Elen kostade' : 'Att betala'}</span><span>${kr(session.costSek)} kr</span></div>

    ${session.usedEstimatedPrice
      ? '<div class="msg">Delar av laddningen prissattes mot senast kända elpris eftersom elbörsen inte svarade.</div>'
      : ''}

    ${session.unpricedKwh > 0
      ? `<div class="msg">${kwh(session.unpricedKwh)} kWh av det som laddats är inte prissatt — appen saknar elpris för den perioden helt. Energin står med ovan, men kostnaden för den ingår inte i summan.</div>`
      : ''}

    ${fri ? '<div class="msg">Fri laddning — ingen betalning. Summan visar vad elen kostade.</div>'
      : inget ? '<div class="msg">Summan blev noll kronor. Det finns ingenting att betala.</div>'
      : paid ? '' : swishData ? `
    ${claimed ? `
    <div class="msg claim">Du har markerat den här laddningen som betald.
      ${esc(place)} bekräftar när betalningen kommit fram. Du behöver inte göra något mer.</div>
    <details><summary>Betala igen om något gick fel</summary><div class="dbody">
      <div class="qrbox">
        <div class="qr">${swishData.svg}</div>
        <p class="qrcap">Skanna med Swish-appen,<br>eller tryck på knappen nedan.</p>
      </div>
      <a class="btn" href="${esc(swishData.link)}">Öppna Swish och betala</a>
      <div class="manual">
        Eller swisha för hand:<br>
        Nummer <b>${esc(swishData.number)}</b><br>
        Belopp <b>${kr(swishData.amountSek)} kr</b><br>
        Meddelande <b>${esc(swishData.message)}</b>
      </div>
    </div></details>` : `
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
    </div>`}` : `
    <div class="msg">Inget Swish-nummer är inlagt i appen än.</div>`}

    ${paid ? '<p class="note">Tack, betalningen är bekräftad.</p>' : ''}
  </div>

  ${historyBlock(tidigare, session.receiptKey)}

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
/* 18  Rutter och uppstart                                                   */
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
const { Router, RateLimiter, makeHandler, sendJson, sendHtml, sendBinary, readJsonBody } = httpModule;

const VERSION = '0.8.2';
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

  /* Har det slutat vara meningsfullt att fortsätta?
     Drar gästen ur kabeln medan sekvensen väntar in laddboxen — eller avslutas
     sessionen av något annat skäl — finns det ingenting kvar att starta. Utan
     den här kontrollen malde sekvensen vidare i upp till fyrtio sekunder mot en
     tom stolpe, och under tiden var stolpen låst för nästa person. */
  const avbrutet = () => {
    if (!sessions.getActive()) return 'sessionen avslutades';
    if (loop.getSnapshot().cableConnected === false) return 'kabeln drogs ur';
    return null;
  };

  // 1. Lås upp stolpen. Alltid — vi vet inte säkert i vilket läge den står,
  //    och att slå på en redan påslagen laddare är ofarligt.
  if (charger.setEnabled) {
    const on = await sendCommand('slå på laddaren', () => charger.setEnabled(true), null);
    if (!on.ok) return { ok: false, error: `Laddaren kunde inte slås på: ${on.error}` };
  }

  let brutet = avbrutet();
  if (brutet) return { ok: false, error: `Starten avbröts: ${brutet}.`, aborted: true };

  // 2. Starta.
  let started = await sendCommand('starta laddning', () => charger.start(), isCharging,
    { timeoutMs: 20000, pollMs: 4000 });
  if (!started.ok) return started;
  if (started.verified) return started;

  brutet = avbrutet();
  if (brutet) {
    log.info(`Startsekvensen avbryts: ${brutet}.`);
    return { ok: false, error: `Starten avbröts: ${brutet}.`, aborted: true };
  }

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

/* ========================================================================== */
/* 19  Ikoner och manifest                                                   */
/* ========================================================================== */

/**
 * Gastsidan gar att lagga till pa hemskarmen och beter sig da som en app:
 * eget fonster utan adressfalt, eget kort i appvaxlaren, egen ikon.
 *
 * Det ar inte bara kosmetika. En iPhone raderar allt en vanlig webbsida sparat
 * efter sju dagars overksamhet — dar ligger telefonens minne av VILKEN laddning
 * som ar dess egen. Sidor som lagts till pa hemskarmen ar undantagna. Utan det
 * har tappar alltsa en iPhone kopplingen till sitt eget kvitto varje vecka.
 *
 * Ingen service worker, medvetet. Hela appen ar ETT dokument — HTML, CSS och
 * all JavaScript i samma svar — sa det finns inget "skal" att cacha skilt fran
 * logiken. En cache skulle darfor kunna servera en hel gammal app efter en
 * uppdatering, och det ar precis den sortens fel som ar svarast att hitta.
 * Priset ar att Chrome inte sjalv foreslar installation; man far valja
 * "Lagg till pa startskarmen" i menyn.
 *
 * Ikonerna ligger inbakade som base64 sa att tillagget forblir en enda fil.
 * Bakgrunden ar flat, inte tonad: en tonad yta komprimeras uselt och gjorde
 * bilderna sju ganger storre utan att synas pa en hemskarm.
 */
const ICON_FILES = {
  'icon-192.png': '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',
  'icon-512.png': 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAQAElEQVR4nOzdB3Qc1b348btVq9WuVl2yZFnuuIArLhTbmGKbEmoIARJ6CoSEP0leevJIXsp5L/8kQICQQEIJISEFktBsIBhsYzAYV1xxka1iS1bXaot2tftG+L08IBR7ZnY1O7/v53A4zjl2gNXsfGfunbnXXTK2RgEA5HErAIBIBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAc1QVuUsCbpdTtfcmmzuTChlQXewuDboHUtqHnGjpHlCAMQQAR2fScN/c8QXDij0lAVdJcPCkXxp0BXyud/22vthARzjZ2ZfSeqD9oqUr8dquyPq9UYUjMGN0/uyxBeWhwx+vu7jAWRr0+POc7/pt4dhAe+/g56x9yJ3hgebOxCs7wtua4go4Mo6SsTUK+EBet2POuIIFkwvmTwpWhDxKr85wctX2vhe39L60PRztTyu8jd/rOGliYP6kwLwJgaKA/iuzlq7+FVv7XtjS++qbfQluEvCBCADeV3HAecrkoHbS1y75871OZZ7+RGrt7ohWguVbwq3doseLKkOuU48r1M77M0f7vR4zP+RIPPXKzvCLW8Ivbu3t6ksp4F8QALyH0oDrhjPLz59V5HI5VIY9s6Hn1idaBE4bDC/13HR2+RlTQyrDBgbSj67pumtZa2eYDOAdCADeIc/tuPq00isWlP7riHPmaDcEf1zd+ctn23qjIs5QwXznZxeVfezEYo87ex+yNitz//L2B1/oiCcZfMP/IAD4Hw5H+oLZxdcvKSsv1D/Kb0RPJHnPc21/WNVp45Frj0tdPr/k2tPKgvkuNRRauxN3Pn3o72u70umM39vB+ggABp08oeDmj1SMqfKpodbU3n/7U63LNvRoB6eylfTZM0M3nlkxrHho+vp2bzbHfvZE6+odfQqyEQDpXE717Y8OO39OkbKSlVt7/+3BxlhC2YPf6/jPT9bMmxRUVvLXNV3f+9OBFANCgrnySwoVpNIGo+/+zIhTjrXWiUlTV553yuTg8jfCkXjOzwpUhly/uXHktFF+ZTEThvtmjvE/v7mnn/f2pCIActWWeu6/ceT46qEf9nlPJUG3Nmby6pt9bb05PCcwudZ33+dGDivxKkuqLvGePjX44pbe3hgPCElEAITSLv3uvaGurHDox6M/gD/Pec7xhfsO9e9p6Vc56IypwduvqS0YovneIxTyu885PrR5f+xAp11G3HDECIBE580K/f8rhvu82XsGUTe3y7lo6uAhunZ3ROWUz59V9tULhmXhRQrjfB7nOTNCLV2JHc0sIyELARDnutNKv3pBldOZS8/YHD+2oLLI/eKWsMoR/3Fp9cdPLlG5QzseFh4b7E+mWa9JFAIgy+lTgt+6eJjKQROH52sTwhv35cDp6aqFJVeeUqpy0JzxBduaovsOMRYkBQEQZNywvDs/XevOqWv/t5szrmDz/mhDu6VPT3PH+7XLf4cjVz/khZODK7eF23N54h1HLgdGgWGKsqDrrk/X5rlz+CeuDVP8+Iqa0ZUWfaJGo/27/fSq2tw9+2u0maGfX1erHS0KAhAAEfLcDu3sX27tZ36ORIHPddenRgTzrXjcFhU4f/HpEdlcQylDKkKeO64b4XWzVoT9MQQkwk+vGj5zTIGyhUC+a/oo/5Ovd1vqFVa3S91zfd2oyjxlC2WF7roK77MbexVsjQDY3/WLyy46oVjZyLBiT3WJ5/nNFnoo6PuXVp80IaBsZExVXiqdfn0PDwXZGVtC2tyEmrzPLCpXmdTSlWjpTrZ09bd2JxMD6WFFnooiT2XIXZ3J11/PmVm0bEPPyq2WWM5s4bGBs2Zmdln/5o5+7UNu7Uoc6Ep4XI6KkLsy5KksGvxLZcwNSyr+sbl398GcfAsPR4IA2NxNZ1eoDGhoi6/YGl61Pbx2V+T9Vm92OtTUkfnzJw1uc5iJdUa/+JHKVdt2D/myxg5HOkMf8q4DMe1DXrktvLE++n7jXR6XmjW24OS39pIcXmp+cf/f2RWf/3Wjgk2xGqidzRrjv+eGOmWqP7/c8fDKzqNdm6G62H3pvJJPLjD56fhv/q7pyXU9akidPzt0yyXVyjyxxMAfVnVqfx3sOrpF2sZW5V0+v/iCOSYP9119Rz1vh9kVAbCzh28eOWl4vjJDOp3Whlx+/tShpg79j+GXBV3aeJR2xjRrJyxt9OnsH+5KDt0z61634/Gvj64sMufSO5FMPbam++5lhzr69P8n1ZZ6bjyzfNG0QrOeRt3SEL381noFO2IS2LbOmBq8fJ45V9y90YEb7mn47YsdBrdsjPSntQGNVdvC8yYGAj4TnjTX/k+6I6nNQ/d68Cfml5xu0qa+2iTKNXfu/9tr3dGEocebeqKp5zb1ap/JvIkFeWbsMl8R8uxojtW3MhNgQwTAnrTx99uvqS30m3CSfbM5dvWd+948YNoyYW29A4+v7ZpUm2/KmPWxtfmPvNQxJDcBAZ/jZ1fXes24m1m7u++6XzSYuB5nQ3ti6YaeWWMKygpNmOc7psb3x9UdttujDQTApi6cW3TO8SZs8vXU691f+E2jdpWtTBVPpJ98vcvncRjfJsXndQ6k0kOyVuhnF5fPGWf00U9tbO2+59u/9fvmeMLk9xrCsdTfX+seUeYZO8zoDHxxgftgZ2J7E2uF2g0BsKfvXlJVGjT6gOC9zx360WMtA5naKcTxys6INohvfD+yMZV5D7zQobLux1fUGB9j+e4fD7z1L5+Ri2vtZ6cNB3k9jumGQ1secj/6SpeCvbAUhA1pc63jq43O/b64pfeOp9tUhj32avdvX2xXxhQH3FPrsr2v2cwx/kK/0dGVB5a3//XVbpVhtz/Z+sIWo+/0Tq7NLy/kqXG7IQA2dPoUo9fUO5ujX3mwSWXFTx9vWb3d6Du9C7K+rfGCSUYHf17eEb71yRaVDY6vPti0vTGmjJk/yVavOkMRAFtaMNnQ2fBQT+KGXzXEk1laaieddnz5gcb6VkPjywuyfm467ThDH/Lug/Ev3t+YtbfYtJ/mjffu7wgb2v3d4HEFCyIAdpPndswea2jdtx/+5WCW92GP9Ke1WVBlwJgqX01J9tY6HVnuqTH2CNNXf9sU7c/qanbaz/RHjx5UBswd5/fl/HqyeAcCYDfafbqRfWi3NESXvzEEi6y9sT/2/GZD7/QumJy9m4D5kwxdCz+zoWfXwSF4oubZjb07mvQPBHk9zrnjGQWyFQJgN/ON3adrE4ZqiPz8qdaUgSWeDZ6Uj4qR2Gj/jbcN3Yds8B+dzcoiCwiAzaQXHqv/K7p+T2TNm0PwQP1he1sTT67T/0jMrDH+gC8bx3PA55gxWv9TlX97rcvIchoGrd7R9/pu/UuonjJ4eWGlfRhgDAGwlZoSr5ElFh5eNQRP07/dn1/uVHppA19jqrKxW+TEmnwjy+z8+eUhfpr+LwYe5y8OuCtCzAPYBwGwldKg/ie10+n0yzuGeHn9jfXRnoj+J1Wys+dliYH9cnujA9osixpSK7eGtZ+10qs0wHbB9kEAbKXEwJdz075oOJapt36PmGPNm/ojVJKVc5ORyq7aFh7yFXV6Y6mtBt4JMPKfD6shALZi5Ms55Jf/h63ebiQA2Tg3GVlebfUOS2xjaeRDJgB2ws/SVsoMjE7saDb6pqgpdhpYdrSsMBt3ACUF+r81O5stsZ7azgPcAWAQP0tbKTHw5WzvNfSaqFmM/GsYX//uyP4p+jNjiw+ZOQD7YAjIVowMgreHh25jrbcxdm7KxgWN7spqU69t1ghAh+U/ZGQHAbCVMgOPwXRY49yUGFDhmM4UZecBFd3jbF2DGz1aYk8VI7EnAHZCAGylqEDnuSnWn8ry0jQfoK1HZ4pKsnJu0r0DsMG12ExkZGvPEh4DtRECYCsevasAJVMWer0zOaDzXybPnY3ra90P0aeG/CHbt+nTe5vldbMxpH1wNwcAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQjpKxNQrWNqXON2O0f1Jt/sSavNqyPAVY2P62+PbG+NbG6Lo90U37ogoWRgAsrSzo+vqFVadNKVRADnpmY89/PXawrXdAwZJc+SWcXCzqwjlFt11bO6EmXwG5aUxV3oVzizr7ktub4grWQwAs6sRjCv7riuFet1MBuUw7hk+ZHFy3J9LUkVCwGM4vVhTMd37/smoF2IV2PAd8DgWLIQBW9L2PV5cEeEAL9lER8nztwioFiyEAlqNN/C48NqgAezlnZlG+l5sAayEAljO+2qcAOzqmhmPbWgiA5Yyv5kl/2NPYKo5ta2Gg2XLGDuNLAnvi2LYaAmA5+R5uy2BPZUFOONbCzwMAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEwHJS6bTSa1N9pH9A/x8HPpTX5Zgy0q90Sac5OK2FAFiO06F/xcSvP9zc1M62G8ig4aWeJ74xVunicLAaqLUQAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBwBn3fAAAEABJREFUsJxUOq30cijAulL6D21kBAGwnFhC/7fE53EqIJPyvfqPsVh/SsFKCIDlROP6A+DP4x4AmeX36j/GIgTAYgiA5UT6B5ReRq7OgCPh9+k/xiIxAmAtBMByonH9XxJ/HgFAZvm9LqVXlDsAiyEAlmPkNpk7AGSakWMs0s8ssLUQAMuJGJgDIADINCPzTJGY/uFNZAIBsBwjt8lMAiPTjAwzMglsNQTAciJG5gC4A0CGGRsCIgDWQgAsx8gdQD6TwMiwAiN3AHHmAKyFAFhO1MBEWWnQo4BMKg3qP2kwB2A1BMBy+uL6vyS1pQQAmVVbpv8Y4zFQqyEAltPem1R61ZZ5FZBJIyvylF6t3fqPbWQCQ8aW09WXCuu9U9Zuz/PcPAiETCn0uwI+nS+CdYaTvAdgNQTAivYd6ld6jarkJgCZMsLA+E9De0LBYgiAFTW26Q8Ao0DInNpS/UfXvkNxBYthDsCK9rXpv1Yy8hUFPpiROwAjlzXIEAJgRQ1t+q+VjDykAXyw4QbuL/e3MQRkOQTAivYbuFYawRAQMsbI0dXQzh2A5RAAK2o0MgREAJAxtdwB2AuTwFbUHh6IJ3W+MlMR8oT8/FhhvrKgqySg85KxLzbQE+E1YMvhTGFRew/qv1+ePa5AAWabNVb/cbWnhUeArIgAWNR+AwOmM8f4FWC2mWPylV4NjP9YEgGwqB1NMaXX8aMJAMw3c4z+O4AdzfqPZ2QOAbCodXsiSq+xw3xMA8BchX7XKAOrAK3fG1WwHk4TFrVpXzQ5oH/pxBncBMBUc8bpP6JiiYEtDQTAigiARWkn/031+r8zMwkATGXkkmJjfWyAdaAtiQBY17q9+keBZjAPDFMZmVhab+BIRkYRAOtat0f/HcCEal8BG8TDJNoEwLhqn9Jr/R4CYFEEwLo21kdSKZ3rpzudjpMmBBRghnkT9T//o01lMQNsWQTAuvri6R0H9D88t3haoQLMsGiq/mNpW2OsP8k+MBZFACxt3W79987zJgYYBYJx2lF04jH67wC4/LcyAmBpGwx8ebwe5ymTgwow5oyphR63/hPF63v6FKyKAFjaq7sMfXkWTw8pwBgj4z9q8A6Ad4CtiwBYWnckVd+qfxWtk44pYBQIRgTznXMMrC24+2CMRUCtjABY3aptYaWXy+VYxFQwDFg8rVA7ipReK7bqP3qRBQTA6pZu6FEGGLx/h3AGnyVbut7Q0YtMIwBW98b+2MFO/Uvpzh5bUOh3KeDolQZcxxt4pbyhLb6jmW0ALI0A5IC/r+1Wemn37+cez1Qw9Dh7Zsjh0D/+84SB4xbZQQBywNL1hr5In1xQ7OLnjKOkHTOfWFCiDHhiHeM/VseJIQfsaenfZeCV4MoiL28F42gtmV5YEfIovbY2Rpva2QXM6ghAbnja2GTaVQsNXcpBoKsXlioDljH9mwsIQG54Ym2XMmB8db6RDT0gzQnH+McO07/8pzL89BqygwDkhpbugU31htbUvfIUQxd0EOWKBYaOlvV7Ii1dSQXLIwA5Y9nGXmXAiRMCI8v1D+lCjjFV3hOOMbSW+NPref4nNxCAnLF0ndEv1bWnlyvgw1x7apky5tlNjP/kBgKQM9rDA48bmwk4c3qwIuRWwPsrL3QvmmZoEdnH13Z3htkCODcQgFzy4AsdygC3y3nZvGIFvL8rTylxG3tt5N5nDynkCAKQS948EF+93dDqWpecVFIWZGUIvLfKkOvikwxdIry0vXdfG4//5wwCkGMefLFdGZDvdX7p3EoFvBft2MhzGzonPLDc0E0qsowA5JhXdkZ2NhvaY+/MGaEZo/MV8E5TR/oWTTO0bNSuA7FXdxl6WBlZRgByzwMvGL3I+uZFVUqxTzf+j9Oh/v1j1cqYe//RppBTCEDuWbq+p6WrXxkwpsr3sROZDcb/+fjJxaMr85QBrd2JZbz9m2sIQO4ZSKmHVhi9CfjcmeXBfH76GFRU4LxhidF3RO5f3p5Os/9ojuEUkJMefaUrHDO01WrI7/7CWRUKUOqmsysCPkPPhmlH419eNvSSCoYEAchJffH0n1/uVMZ89ISiY6oN3fXDBsYNyzt/dpEy5pGXOuJJZpVyDwHIVQ+v7EwOGHrf0uFwvDUbDNH+/WNVRrb90vQnUsbHJDEkCECuau1OPvKS0ZuAKSP9l57MbLBcn1xQfOwIo+uE/+GlTtZ+yFEEIIfdtfRQd8Toors3n1PBQJBM46vztNF/ZUxnOPnLZ1j7IVcRgBymzQTc9oTR757X4/zpVcN9LBQtTEGe42dXDXcb3i36Z0+0aMehQm4iALnt0TWd2xv1bxd8WE2p95ZLjL4EhNzy/ctqtJ+7MuaN/ZG/v8az/zmMAOQ6xw/+ckAZtmR66PzZhpYBQA756AlFC481tObzYd/940GFXEYAct7m/TGD+wQc9rULK0eUGb0khPWNrvR++TwTXgF5bE3nmwfiCrmMANjBTx9vifYbfQzD53H97Ooar5uXOe1Mm+y59RptysfokuDh2MBtT7Yq5DhXfkmhQo6L9acHUum54w3t46opCbhLgq4VWw1tOQAr+/bFw+aMM3qcaG5/8hALf9oAdwA28dCKjv1tJtyPXzS3+JITjb4XCmu6bF7xebNN+OE2tMUfXsmbX3bAHYBNpNJqb2v8nONN+HqfPDHQ2N7P8K7NLJkeNL7g82FfebCpsZ1tv+yAOwD7eGVnxJTRG4fD8b1Lqk88pkDBLuZNKvjBpTXKDM9v7lnzJoM/NsEdgK2s2xs5b1Yoz2O0606n47QpgbW7Iwe7jL5pjCE3tc53x3UjPG4Trva6wskb722I9vPml00QAFvpi6W0oZuzZprwRL/b5Tx9SvDFrb2dYUPrTmNoja/O+9X1dfl5Rh/7Oezz9zbsajG0GREshQDYzf62RDDfOaXO6ApfGq/bedqU4PObe3uiLPWVk2pKPfd/rq7Q71ZmeGB5+1/WsOi/rTAHYEO3PtFqfH2Iw8qCnnuurysNmHP9iGwqL3T/+vq6ooA5Z/839kduf4oH/+2GANhQYkB96YFGg1uG/dOwYs/dnxlR6KcBuSTkd2o/tapicxb5046lL93fOMB9oO0wBGRPvdFUfWt88XRzlvcpDboXTA688EYP6z7mhMoi9/031o2sMG2V76882LSlgceCbYgA2Nbe1v7ykHvS8HxlhuKAe/G0wlXberv6uA60tNGV3vturBtWbNqyTo+81PHQCqNbD8GaCICdvbKz79TjAiUmjQIX+FxnzShctzfSwrOhVjWlznfvDXXFBeb8xDW7D8Zuvr8xxY2fTREAO9MGbV/ZGblgbsj4vh+H5XmcZ80M7WiO7T/Ei6CWc8rkwO3X1fq9ps3WRPtT1965j3s+GyMANtcdGWjrSZ5ixuLvh7mdjiXTCg/1JLc1mfOgEUxx/uzQjz5RY1bpD/vG75rW740q2BcBsL/tTXGz3gw4zOFwLJgcHEil1+3h7GAJ1y8u+/J5VdrPRZnnN8+3/X4lQ/82RwBEWL2jr67cO26YT5ln9rgCbZJ5xdZerQgKQ8ThSP/gsupL55UqU/3t1a7/fKxFwe4IgBTL3+idUOMz8dFAzaTh+TPG5K/e3sfiMEOiLOi687oR8yebNr532LMbu7/5+2a6LgEBkEI7Q/9jU8/0Uf6aEjP3fdT+386dFdp5IMb6wFk2b2Lgl58dYW7RNau3h7/0QFMqzdlfBAIgSCo9eHE3d3xBRcicF0QPy/c6z54RCvicr+3q43nBLPC6HV86t/KrF1T5PCa/yf/G/sj1v2pIsvqfGARAlmRKa0DvqccFi8x7VFy9NS08daR/waTgKzv7WDkuo4aXeu69YcQCs4d91FuP/H/qrv2M5olCAMTpT6b/sbl30dTCQL7Jy/uUFbrPmxVq6Uqwm1iGnD87dOs1tZVFZt7AHdbQFr/mjv3dxFsYAiBRJJ5avqV3ybRCf57JYwhvrSBdOLoy76Xt4QQjCebxex0/uKzm2tPLPG7zR+fbe5NX/ry+rZcfmDgEQKjeaOrlHX2LpwVNH0fWjKnKO+f40KGexO6DbB5iAu3HdPu1tVNGmvYmx9t19w1ce9e+xnaW95DIUTLWnJ1CkYtGVXh+8ek6sxYN/lfr90b+408H9rCHlF7jq/O+dVFVhk79Gm287jN376tnYQ+pCIB0ZUHXr66v0wZtVGakUulHX+m8/em2nggjDEehqMB509kV580qcjoz9UTm3tb4p+7ax8iPZAwBSRfpTz/1evf00f5hmbkPcDgck2rzL5obiiXSWxtiPGLyoVxOdfm8kp9cNXzqSL+5qzu83cb6yHV37e+KMOsrGgHA4HNBT6/r0UYbTH+r6J/yPM6TJwbOmFq462D8QCcDDu9rzjj/HZ8acdaMUJ4ng7v1rdrWe+O9jTzxCQKAQQMptWxDd3mhaRvIvKfigFsb05g2yn+wK9FMBt5JO/XfcsmwzywqLyrI7O6bj63p/NpDTezvCMUcAN7ls4vLPruoXGXehr2Re55re2l7nxJv/qSC604ry9xM79vd/cyhu5e1KeAtBADvduGcom9fXJW50ee329YU/fVz7c9t6hG49JjDkT5jSuF1p5eOr87gXdc/abPx3/vTgb++2q2A/0UA8B5OOy74w09U57kzOAz9drsPxn/zfJs2DyFkKSGnQ51zfOE1p5ZlbtLlXeLJ1Bfva+R+C+9CAPDejqnO+8lVw4eXmrl06Adrau//9fPtS9d1R+w7OZnvdWgTvNeeVlpdkr0Pdn9b/MsPNO1sZn0OvBsBwPvyex23XFK9aFpWHxOIJQZWbg0/s6F3xdZwPGmTEnjdjgWTA4unFZ48scDnyewc77s8s6HnO39oijHjjvdCAPAhzpsV+tqFVfneLA0H/VNfbODFLeGlG7pf3tGXo8sKuV3qpAkFS6aFFkwOmr7s0oeKxFM/evTA42t7FPA+CAA+3MhyjzYcNKbKzB0lj1xPJPn85vCyjd1rdkZyYpJAG+KfO75Au94/9bhgMD+r1/v/tPtg7KbfNLJLDz4YAcAR0QYx/u28yotPLFZDJxwb2FgfWbcnum5PZEtDrN9KA0Ta5zOlLn/6KO0v/5SR+QHf0Jz3D3vkpY6f/L3VUp8PrIkA4CgsPDbw/UurC4b07HZYfyK1pTG2fm9k/Z7o+r194aFYYyKY75w52q+d8aeP9k+syfO4sz3I8696owPf+F3zym1hBRwBAoCjU13s/vGVwyfXZuPR9SOUTqdbupJ7W+N7W/v3tcbrD/Vrv2jtNnN9Y21UZ3ipt67CU1fmHVmu/SKvrtxr7s6axm1piH7xvoaWbhZ3w5EiANDj8vkl1y8uC1jgVuD9aFOg+9ri9S39+9v644l0YiCVSKb7k0r7hTY2ov1am1iO9g+uh6CN3njcyutyetwO7ddu1+DfPW/9vcDnHF3p08712l/KwrRpkl892/7Qig4FHA0CAJ1KA66bz604Z9Ctnh4AAAXOSURBVGaRwpB6bE3nbU+2dvWxuA+OGgGAIceO8H3n4qrsLGaAd9nRFLvlkeZtTbzhBZ0IAExw0dyiL5xdHvK7FbKiK5y8/alDj67pUoABLAcNE2xrjD22pivoc06o8WVnFTmxUqn0n1Z33XRf48Z9UQUYwx0AzDSxJu8bF1UdV5eNlY0F2lQfueWP7LEM0xAAmC597qzQTWdXlgYZETJNW2/itidaWdcB5iIAyAifR104t/gT80uyueylLTW29/9uRcdjazpZ0A2mIwDIIKdDnTE1eOXC0ozuNGlXWxqiDyxvf3ZTTzrNtAoyggAgG2aN8V+5sOTkiUGFD5NOp1du63vwhfa1uyMKyCQCgOwZXem95rRS3h37AH97tev+5W17WxnuQTYQAGRbWdB12bySj55QVMh7A/+rO5L888udD63o6AzzQi+yhwBgaHjdjvmTAoumBudPCvq8Q7+O5pCIJQZWbetbtqHn2Y29Csg6AoAh5vc6FkwOLplWeMIxBV6PiBL0J1Iv7xw87y9/ozdq3w2QYX0EAFYRzHeeemxwyfTC2WMLXC4bPvcyMJB+dVffMxsHr/fDMYZ6MPQIACynqMB5xtRC7Z5g+ii/05nzJUin0+v3RJZu6Fm6obcnwmL9sBACAOvS7gmmjcqfPnJwy61Jtb48C2y5dYTiydTWhph23t9QH1m/N9ob5XofVkQAkBu0SWOtAYP7L47yTx3ps+DKo13h5Mb66PrBM35EO/snuNaH5REA5KTKkGtUZd6oiryRFd6RFdovsrpBYyqVburo33do8K967e+tg383dxNKIAsIAGzC51GjK32jKr0jy7UqeEZX5tWWek15rKg7ktx3KFHfGq9vHTzj722N72/rT3KBj9xHAGBnQZ/zI7NCNywp17F9cWc4eefSQ0+s7WIVNtgVr2LCznpjg1vA69u8vjgw+O3g7A8bIwAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAA2F47p37vLyJ8FrI8AwOZ2NseVXkb+LGB9JuyYCljZ3tZ4IplSRy/Wn9L+rALsiwDA5tJpx47mmDp6Ow/EtT+rAPsiALC/36/qVEfvdyvaFWBrBAD29+TrPau29R7VH1n+Ru+yDUf3R4CcQwAgwnd+f6C770gf6emOJL/zh2YF2J0rv6RQAXYXTaTX7+07aUKgwOf64N/Z0pW4+b7GhraEAuyOAECKlq7kY2s6q4o846p97/d7tN/w+V83NHUkFSCAo2RsjQIkqSpyzx7nP35MwbmzirT/uWFvZNO+6Mb66Po9kY4+3vyCIAQAAITiTWAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFD/DQAA///+AugnAAAABklEQVQDAKMWu3M/KlWyAAAAAElFTkSuQmCC',
  'icon-180.png': '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',
  'icon-mask.png': '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',
};

const ICON_BUFFERS = Object.fromEntries(
  Object.entries(ICON_FILES).map(([namn, b64]) => [namn, Buffer.from(b64, 'base64')])
);

function appManifest(locationName) {
  return {
    id: '/',
    name: (locationName || 'Laddstolpen') + ' laddstolpe',
    short_name: 'Laddstolpe',
    description: 'Starta laddning, se priset och betala.',
    start_url: '.',
    scope: '.',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a140f',
    theme_color: '#0a140f',
    lang: 'sv',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-mask.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Gästroutern                                                         */
/* ------------------------------------------------------------------ */

const guest = new Router('guest');

guest.get('/manifest.webmanifest', (req, res) => {
  const body = Buffer.from(JSON.stringify(appManifest(config.ha().location_name)), 'utf8');
  return sendBinary(res, 200, body, 'application/manifest+json; charset=utf-8', 'public, max-age=3600');
});

// Routern kan bara :namn, inga mönster — så varje ikon får sin egen rad.
Object.keys(ICON_FILES).forEach((namn) => {
  guest.get('/' + namn, (req, res) =>
    sendBinary(res, 200, ICON_BUFFERS[namn], 'image/png', 'public, max-age=604800'));
});

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

/**
 * Elpriset framåt. Egen adress, inte en del av statussvaret.
 *
 * Statussvaret hämtas var femte sekund av varje öppen telefon; att lägga
 * fyrtioåtta kvartspriser i det vore att skicka samma tabell om och om igen för
 * något gästen tittar på en gång. Den här hämtas när panelen fälls ut.
 */
guest.get('/api/prices', (req, res, ctx) => {
  // Samma regel som på startsidan: den som laddar fritt ser priset utan
  // avgiften för stolpen. Kurvans FORM blir densamma — avgiften är ett fast
  // påslag per kWh — så rådet om när man bör ladda är oförändrat.
  const active = sessions.getActive();
  const enhet = devices.resolve(ctx.query.get('d'));
  const fri = active ? Boolean(active.free) : Boolean(enhet && enhet.free);

  const punkter = prices.forecast(12).map((p) => ({
    t: p.t,
    spot: round2(p.spotSek),
    total: round2(fri ? p.totalSek - p.serviceSek : p.totalSek),
  }));
  return sendJson(res, 200, {
    points: punkter,
    now: prices.currentPrice(),
    free: fri,
    zone: config.ha().price_zone || 'SE3',
    serverTime: new Date().toISOString(),
  });
});

function round2(n) { return Math.round(Number(n || 0) * 1000) / 1000; }
function round3(n) { return Math.round(Number(n || 0) * 10000) / 10000; }

guest.get('/api/status', (req, res, ctx) => {
  loop.noteGuestPoll();
  const snap = loop.getSnapshot();
  const active = sessions.getActive();
  const price = prices.currentPrice();

  // 'ok' | 'stale' | 'lost'. Ett enda misslyckat anrop släcker inte längre
  // sidan: vi visar det vi senast visste och skriver ut hur gammalt det är.
  const contact = loop.contact();

  /* Känner vi igen telefonen? Nyckeln bär bara identitet — vilket nummer den
     tillhör. Om numret laddar gratis slås upp här och nu, mot den aktuella
     listan, så att en ändring i listan gäller från nästa start. */
  const enhet = devices.resolve(ctx.query.get('d'));

  /* Är det gästens egen laddning?
     Telefonen visar upp kvittonyckeln den fick när laddningen startade. Bara
     då får den tillbaka nyckeln i svaret — och därmed vägen till betalsidan.
     En förbipasserande ser att stolpen är upptagen och hur mycket som laddats,
     men får ingen betallänk och kommer inte åt numrets övriga laddningar. */
  const mine = Boolean(active && ctx.query.get('k') && ctx.query.get('k') === active.receiptKey);

  let view = 'idle';
  let session = null;
  let busySince = null;

  if (contact.state === 'lost') {
    view = 'offline';
  } else if (active && active.status === 'FINISHED') {
    // Bilen är klar men står kvar. Stolpen är upptagen tills kabeln dras ur,
    // och det ska både gästen som laddat och en förbipasserande kunna se.
    view = 'finished';
    session = sessions.publicView(active, { includeKey: mine });
    busySince = active.startedAt;
  } else if (active) {
    view = 'charging';
    session = sessions.publicView(active, { includeKey: mine });
    busySince = active.startedAt;
  } else if (snap.cableConnected) {
    view = 'ready';
  }

  const mode = config.ha().mode;
  if (mode === 'avlasning' && view === 'ready') view = 'readonly';

  /* Priset som visas beror på vem som tittar.
     Den som laddar fritt ska inte se avgiften för stolpen — den är din
     ersättning för slitage och meningslös internt. Elkostnaden står kvar, för
     det är den man behöver för att bedöma om det är rätt tid att ladda.
     Under en pågående laddning avgör sessionens egen status, inte listan, så
     att priset inte byter skepnad mitt i. */
  const friVy = active ? Boolean(active.free) : Boolean(enhet && enhet.free);
  const visatPris = (price && friVy)
    ? { ...price, serviceSek: 0, totalSek: round3(price.totalSek - price.serviceSek) }
    : price;

  sendJson(res, 200, {
    view,
    session,
    busySince,
    price: visatPris,
    mode,
    // Underlag för att räkna vidare mellan avläsningarna, så siffrorna tickar
    // jämnt i stället för att hoppa var tionde sekund. Det som visas mellan två
    // avläsningar är en uppskattning; det som debiteras är alltid de riktiga
    // mätvärdena.
    requireVerification: config.settings().requireVerification,
    starting: startState.running,
    startError: !active && startState.error ? startState.error : null,
    mine,
    // Kabelns löpnummer just nu. Gästsidan använder det för att veta när en
    // gammal sammanställning blivit inaktuell: har någon satt i kabeln på nytt
    // är den laddningen historia.
    cableEpisode: loop.getCableState().episode,
    // Telefonen känns igen: ett tryck räcker för att starta.
    known: enhet ? { phone: devices.maskPhone(enhet.phone), free: enhet.free, name: enhet.name } : null,
    free: friVy,
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

  /* Numret är nu bevisat. Telefonen får en egen nyckel så att den slipper göra
     om det här nästa gång — ett tryck räcker då. Nyckeln lämnas ut en enda
     gång; servern sparar bara en hash av den. */
  const nyckel = devices.issue(out.phone);

  return sendJson(res, 200, {
    ok: true,
    phone: out.phone,
    device: nyckel,
    free: config.isFreeNumber(out.phone),
  });
});

guest.post('/api/start', async (req, res, ctx) => {
  loop.noteGuestPoll();
  // Spärren sätts först av allt, före varje await
  /* Tak på hur länge en start får blockera.
     Sekvensen har egna tidsgränser, men hänger den sig ändå vore alternativet
     att stolpen är låst tills tillägget startas om. Två minuter är långt mer
     än den värsta riktiga sekvensen — din box behövde 17 sekunder. */
  const startFastnat = startState.running && Date.now() - startState.since > 2 * 60 * 1000;
  if (startFastnat) {
    log.warn('En startsekvens har hängt sig i över två minuter. Släpper spärren.');
    startState.running = false;
  }
  if (startInFlight || startState.running) {
    const kvar = Math.max(1, Math.round((30 * 1000 - (Date.now() - startState.since)) / 1000));
    return sendJson(res, 409, {
      error: `En laddning håller på att startas. Försök igen om ${kvar} sekunder.`,
      startingSince: startState.since,
    });
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
    const rl = limiter.hit(`start:${ctx.ip}`, config.settings().maxStartsPerHourPerIp || 15, 60 * 60 * 1000);
    if (!rl.allowed) {
      return sendJson(res, 429, { error: `För många försök. Vänta ${rl.retryAfterSec} sekunder.` });
    }

    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

    // Numret måste vara verifierat. Utan det är det bara ett textfält, och då
    // är spårbarheten — ett av två skäl att bygga appen — borta.
    let phone;
    if (parsed.body.device) {
      // En ihågkommen telefon. Numret bevisades en gång och nyckeln har burit
      // det sedan dess. Går nyckeln inte att lösa upp — spärrad, okänd, eller
      // funktionen avstängd — faller vi tillbaka på det vanliga besked som
      // ber om verifiering, i stället för att avslöja vilket som gällde.
      const d = devices.resolve(parsed.body.device);
      if (!d) {
        return sendJson(res, 401, {
          error: 'Den här telefonen känns inte igen längre. Skriv ditt mobilnummer så får du en ny kod.',
          forgetDevice: true,
        });
      }
      phone = d.phone;
    } else if (parsed.body.token) {
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
      startToken: parsed.body.token || null,
      free: config.isFreeNumber(phone),
    });
    if (!started.ok) return sendJson(res, 409, { error: started.error });

    log.info(`Gäst startade session #${started.session.number} från ${ctx.ip}.`);
    /* Sekvensen får sitt EGET tillståndsobjekt.
       Förut skrevs `startState` över av nästa start, medan den föregående
       sekvensen fortfarande höll på — och när den till slut blev klar
       nollställde den nästa starts flagga i stället för sin egen. Två
       laddningar som startas tätt kunde alltså trassla in sig i varandra. */
    const mittStart = { running: true, error: null, since: Date.now() };
    startState = mittStart;

    // Körs vidare utan att gästen får vänta. Medvetet inget await.
    (async () => {
      try {
        const cmd = await startChargingSequence();

        if (!cmd.ok) {
          // Avbruten för att kabeln drogs ur är inget fel att visa nästa gäst —
          // sessionen är redan avslutad och stolpen står ledig.
          if (cmd.aborted) { log.info(`Session #${started.session.number}: ${cmd.error}`); return; }
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
        mittStart.running = false;
      }
    })();

    return sendJson(res, 200, {
      ok: true,
      starting: true,
      // Den som just startat laddningen ar dess agare och ska ha nyckeln.
      session: sessions.publicView(sessions.getActive(), { includeKey: true }),
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

  // Bara den som startade laddningen får avsluta den. Telefonen visar upp
  // kvittonyckeln den fick vid start. Förut räckte det att känna till adressen.
  const parsed = await readJsonBody(req);
  const nyckel = (parsed.ok && parsed.body && parsed.body.k) || ctx.query.get('k');
  if (nyckel !== active.receiptKey) {
    return sendJson(res, 403, { error: 'Bara den som startade laddningen kan avsluta den.' });
  }

  await loop.tick();                    // sista avläsningen innan vi summerar

  // Laddningen stoppas, men sessionen lever tills kabeln dras ur. Kvittot
  // kommer då. Gästen ser summan direkt på skärmen under tiden.
  const done = await loop.stopChargingNow('avslutad av gästen');

  if (done && done.stopFailed) {
    return sendJson(res, 502, {
      error: 'Laddningen kunde inte stoppas. Dra ur kabeln, så avslutas den automatiskt.',
    });
  }
  return sendJson(res, 200, { ok: true, session: sessions.publicView(done, { includeKey: true }) });
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

  /* Har den här länken redan startat en laddning? Då är den inte förbrukad —
     den är nyckeln till just den laddningen, och ska fungera för alltid.

     Vart den leder beror på om laddningen fortfarande pågår. Trycker gästen på
     länken mitt under laddningen vill hen se hur det går, inte få en räkning
     för något som inte är klart. Är kabeln urdragen är laddningen historia och
     då är kvittot rätt sida. */
  const tidigare = sessions.byStartToken(ctx.params.key);
  if (tidigare) {
    const pagar = sessions.getActive() && sessions.getActive().id === tidigare.id;
    const dit = pagar
      ? `../?k=${encodeURIComponent(tidigare.receiptKey)}`     // laddvyn, och telefonen minns nyckeln
      : `../k/${encodeURIComponent(tidigare.receiptKey)}`;     // kvitto och betalning
    res.writeHead(302, { Location: dit });
    return res.end();
  }

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
    startToken: ctx.params.key,
    free: config.isFreeNumber(v.phone),
  });
  if (!started.ok) return say('Kunde inte starta', started.error, false);

  log.info(`Session #${started.session.number} startad via länk från ${ctx.ip}.`);
  const mittStart = { running: true, error: null, since: Date.now() };
  startState = mittStart;
  (async () => {
    try {
      const cmd = await startChargingSequence();
      if (!cmd.ok) {
        if (cmd.aborted) { log.info(`Session #${started.session.number}: ${cmd.error}`); return; }
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
      mittStart.running = false;
    }
  })();

  // Vidare till laddvyn, med nyckeln i adressen så telefonen vet att det är
  // dess egen laddning. Annars vore gästen en främling för sin egen laddning
  // resten av kvällen: ingen betallänk, och ingen reaktion när kabeln dras ur.
  res.writeHead(302, { Location: `../?k=${encodeURIComponent(started.session.receiptKey)}` });
  return res.end();
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
    return sendJson(res, 200, { session: sessions.publicView(s, { includeKey: true }), swish: swishFor(s) });
  }
  // Den som natt hit har redan nyckeln. Historiklankarna behover sina egna.
  const tidigare = sessions.forPhone(s.phone).map((x) => sessions.publicView(x, { includeKey: true }));
  return sendHtml(res, 200, receiptPage.render(sessions.publicView(s, { includeKey: true }), swishFor(s), config.ha().location_name, tidigare));
});

guest.post('/k/:key/betald', async (req, res, ctx) => {
  const s = sessions.byReceiptKey(ctx.params.key);
  if (!s) return sendJson(res, 404, { error: 'Kvittot hittades inte.' });

  const rl = limiter.hit(`paid:${ctx.ip}`, 20, 3600 * 1000);
  if (!rl.allowed) return sendJson(res, 429, { error: 'För många försök.' });

  // En fri laddning har ingen betalning att markera, och skulle förlora sin
  // status om någon ändå tryckte.
  if (s.payment === 'FREE') return sendJson(res, 409, { error: 'Fri laddning — det finns inget att betala.' });

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
    devices: devices.all(),
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

    active: active ? { ...sessions.publicView(active, { includeKey: true }), startedAt: active.startedAt } : null,
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

/**
 * Avsluta från adminfliken. Här FÅR sessionen stängas helt även om kabeln
 * sitter i — det är din nödutgång när något hängt sig, och då ska kvittot ut.
 */
admin.post('/api/admin/session/end', async (req, res) => {
  if (!sessions.getActive()) return sendJson(res, 409, { error: 'Ingen laddning pågår.' });
  await loop.tick();
  const done = await loop.endSession('avslutad från admin', { force: req.headers['x-force'] === 'ja' });
  if (done && done.stopFailed) {
    return sendJson(res, 502, {
      error: 'Laddboxen svarar men slutar inte ladda. Sessionen hålls öppen och räknas vidare.',
    });
  }
  return sendJson(res, 200, { ok: true, session: sessions.publicView(done, { includeKey: true }) });
});

admin.post('/api/admin/device/revoke', async (req, res) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const out = devices.revoke(parsed.body.id);
  if (!out.ok) return sendJson(res, 404, out);
  return sendJson(res, 200, { ok: true });
});

admin.post('/api/admin/device/name', async (req, res) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const out = devices.rename(parsed.body.id, parsed.body.name);
  if (!out.ok) return sendJson(res, 404, out);
  return sendJson(res, 200, { ok: true });
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
    case 'full': out = charger.setCarFull(true); break;
    case 'wake': out = charger.setCarFull(false); break;
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
  devices.load();

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
    devices.flush();
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
