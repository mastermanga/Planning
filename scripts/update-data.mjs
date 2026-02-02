import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import * as ical from "node-ical";

const OUT_EVENTS_PATH = path.join("data", "generated.json");
const OUT_STATUS_PATH = path.join("data", "status.json");

// ===== SOURCES =====
const ANIMESAMA_PLANNING_URL = "https://anime-sama.si/planning/";
const LOLIX_PRED_URL = "https://lolix.gg/predictions";
const TWITCH_ICAL_URL = "https://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=40063341";

// FootMercato (match calendars)
const FOOTMERCATO_CLUB_CALENDARS = [
  { label: "Barcelona", url: "https://www.footmercato.net/club/fc-barcelone/calendrier" },
  { label: "Real Madrid", url: "https://www.footmercato.net/club/real-madrid/calendrier" },
  { label: "Manchester City", url: "https://www.footmercato.net/club/manchester-city/calendrier" },
  { label: "Liverpool", url: "https://www.footmercato.net/club/liverpool/calendrier" },
  { label: "Bayern Munich", url: "https://www.footmercato.net/club/bayern-munich/calendrier" },
  { label: "PSG", url: "https://www.footmercato.net/club/psg/calendrier" },
  { label: "Nice", url: "https://www.footmercato.net/club/ogc-nice/calendrier" },
  { label: "Saint-Étienne", url: "https://www.footmercato.net/club/asse/calendrier" },
];

const FOOTMERCATO_UCL_CALENDAR_URL =
  "https://www.footmercato.net/europe/ligue-des-champions-uefa/calendrier/";

// ===== RUN ONLY 06:00 & 13:00 Paris (schedule), always on manual dispatch =====
function parisHM() {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const h = parts.find(p => p.type === "hour")?.value ?? "00";
  const m = parts.find(p => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}
function shouldRunNow() {
  if (process.env.FORCE_UPDATE) return true;
  const hm = parisHM();
  return hm === "06:00" || hm === "13:00";
}
if (!shouldRunNow()) {
  console.log(`Skip: Paris time is ${parisHM()} (wanted 06:00 or 13:00)`);
  process.exit(0);
}

// ===== HELPERS =====
const MONTHS_FR = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12
};

function ymd(y, m, d) {
  const MM = String(m).padStart(2, "0");
  const DD = String(d).padStart(2, "0");
  return `${y}-${MM}-${DD}`;
}
function isoLocal(y, m, d, hh, mm) {
  return `${ymd(y, m, d)}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}
function parseMonthYear(line) {
  // "février 2026"
  const m = line.toLowerCase().match(/^([a-zéûôîàç]+)\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS_FR[m[1]];
  const year = Number(m[2]);
  if (!month || !year) return null;
  return { month, year };
}
function parseFrenchFullDate(line) {
  // "mardi 17 février 2026"
  const m = line.toLowerCase().match(
    /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(\d{1,2})\s+([a-zéûôîàç]+)\s+(\d{4})$/
  );
  if (!m) return null;
  const day = Number(m[2]);
  const month = MONTHS_FR[m[3]];
  const year = Number(m[4]);
  if (!month) return null;
  return { year, month, day };
}
function guessYear(day, month) {
  const now = new Date();
  let y = now.getFullYear();
  const candidate = new Date(Date.UTC(y, month - 1, day));
  const diffDays = (candidate - now) / 86400000;
  if (diffDays < -180) y += 1;
  if (diffDays > 180) y -= 1;
  return y;
}
function withinHorizon(startStr, daysAhead = 120) {
  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const t = new Date(startStr).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= now.getTime() - 6 * 60 * 60 * 1000 && t <= end.getTime();
}
function dedupeEvents(events) {
  const map = new Map();
  for (const e of events) {
    const key = `${e.source}::${e.title}::${e.start}`;
    if (!map.has(key)) map.set(key, e);
  }
  return [...map.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// ===== SOURCES =====

// --- Anime-sama (best effort) ---
function parseAnimeSamaTime(text) {
  const m = text.match(/(\d{1,2})h(\d{2})/);
  if (!m) return null;
  return { hh: String(m[1]).padStart(2, "0"), mm: m[2] };
}
function cleanTitle(raw) {
  return raw
    .replace(/^\s*(Anime|Scans)\s+/i, "")
    .replace(/\s+\d{1,2}h\d{2}\s*/i, " ")
    .replace(/\s+Saison\s+\d+/i, "")
    .trim();
}
async function fetchAnimeSama() {
  const res = await fetch(ANIMESAMA_PLANNING_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`Anime-sama HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const DAY_NAMES = new Set(["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"]);
  const events = [];

  $("h2").each((_, h2) => {
    const dayName = $(h2).text().trim();
    if (!DAY_NAMES.has(dayName)) return;

    const dateText = $(h2).nextAll().text().match(/(\d{2})\/(\d{2})/)?.[0];
    if (!dateText) return;

    const [dd, mm] = dateText.split("/").map(Number);
    const year = guessYear(dd, mm);

    let node = $(h2).next();
    while (node.length && node[0].tagName !== "h2") {
      if (node[0].tagName === "a") {
        const raw = node.text().replace(/\s+/g, " ").trim();
        const time = parseAnimeSamaTime(raw);
        if (time) {
          const href = node.attr("href");
          events.push({
            title: cleanTitle(raw),
            start: isoLocal(year, mm, dd, time.hh, time.mm),
            source: "Anime-sama",
            url: href ? new URL(href, ANIMESAMA_PLANNING_URL).toString() : ANIMESAMA_PLANNING_URL,
            tags: [raw.toLowerCase().startsWith("scans") ? "scans" : "anime"]
          });
        }
      }
      node = node.next();
    }
  });

  return events;
}

// --- Twitch iCalendar (Domingo) ---
async function fetchTwitchICal() {
  const res = await fetch(TWITCH_ICAL_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`Twitch iCal HTTP ${res.status}`);
  const icsText = await res.text();
  const parsed = ical.parseICS(icsText);

  const events = [];
  for (const k of Object.keys(parsed)) {
    const item = parsed[k];
    if (item?.type !== "VEVENT") continue;

    events.push({
      title: item.summary || "Stream",
      start: item.start?.toISOString?.() || item.start,
      end: item.end?.toISOString?.() || item.end || undefined,
      source: "Twitch",
      url: "https://www.twitch.tv/domingo/schedule",
      tags: ["stream"]
    });
  }
  return events;
}

async function fetchLolixPredictions() {
  const res = await fetch(LOLIX_PRED_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`Lolix HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const lines = $("body")
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const DAY_RE = /^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche)\s+(\d{1,2})\s+([a-zéûôîàç]+)(?:\s+(\d{4}))?$/i;
  const TIME_RE = /^(\d{1,2}):(\d{2})$/;

  const junk = (s) => {
    const t = s.toLowerCase();
    return (
      !s ||
      /^\d{1,3}%$/.test(s) ||
      /^bo\d$/i.test(s) ||
      /regular season|group stage|matchs passés|prédictions|tous|lec|lck/i.test(t) ||
      /^[0-9]+$/.test(s)
    );
  };

  let curDay = null; // { y, m, d }
  const out = [];

  const now = Date.now();
  const minMs = now - 7 * 24 * 60 * 60 * 1000;     // -7 jours
  const maxMs = now + 45 * 24 * 60 * 60 * 1000;    // +45 jours

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) Date header: "Samedi 31 janvier" (année optionnelle)
    const mDate = line.match(DAY_RE);
    if (mDate) {
      const d = Number(mDate[2]);
      const monthName = mDate[3].toLowerCase();
      const m = MONTHS_FR[monthName];
      if (!m) continue;
      const y = mDate[4] ? Number(mDate[4]) : guessYear(d, m);
      curDay = { y, m, d };
      continue;
    }

    // 2) Time line
    const mTime = line.match(TIME_RE);
    if (!mTime || !curDay) continue;

    const hh = String(mTime[1]).padStart(2, "0");
    const mm = mTime[2];

    // 3) Take next “clean” lines as teams (2 teams)
    const teams = [];
    let j = i + 1;

    while (j < lines.length && teams.length < 2) {
      const cand = lines[j];

      // stop if next date or next time encountered
      if (DAY_RE.test(cand) || TIME_RE.test(cand)) break;

      if (!junk(cand)) teams.push(cand);
      j++;
    }

    if (teams.length < 2) continue;

    const start = isoLocal(curDay.y, curDay.m, curDay.d, hh, mm);
    const startMs = new Date(start).getTime();
    if (!Number.isFinite(startMs)) continue;

    // filtre anti-spam : on garde ±7 jours à +45 jours
    if (startMs < minMs || startMs > maxMs) continue;

    out.push({
      title: `${teams[0]} vs ${teams[1]}`,
      start,
      source: "lolix.gg",
      url: LOLIX_PRED_URL,
      tags: ["esport", "predictions"]
    });
  }

  return out;
}


// --- FootMercato: club calendars (upcoming only, all-day) ---
async function fetchFootMercatoClubMatches({ label, url }) {
  const res = await fetch(url, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`FM club HTTP ${res.status} for ${label}`);
  const html = await res.text();
  const $ = load(html);

  const lines = $("body").text().split("\n").map(s => s.trim()).filter(Boolean);

  let inUpcoming = false;
  let currentMY = null; // {month, year}
  const out = [];

  for (const line of lines) {
    if (line === "Matchs à venir") { inUpcoming = true; continue; }
    if (inUpcoming && line === "Résultats") break;
    if (!inUpcoming) continue;

    const my = parseMonthYear(line);
    if (my) { currentMY = my; continue; }

    // ex: "... 08/02"
    const m = line.match(/^(.*?)\s(\d{2})\/(\d{2})$/);
    if (!m || !currentMY) continue;

    const matchLabel = m[1].trim();
    const dd = Number(m[2]);
    const mm = Number(m[3]);

    const start = ymd(currentMY.year, mm || currentMY.month, dd);
    if (!withinHorizon(start, 180)) continue;

    out.push({
      title: `${label}: ${matchLabel}`,
      start, // all-day
      source: "Foot Mercato (matchs)",
      url,
      tags: ["foot", "match", label]
    });
  }

  return out;
}

// --- FootMercato: UCL (tries matchday links, then parses dates/times) ---
async function fetchUclMatchdayPage(url) {
  const res = await fetch(url, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`FM UCL page HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const lines = $("body").text().split("\n").map(s => s.trim()).filter(Boolean);
  let curDate = null;
  const out = [];

  for (const line of lines) {
    const d = parseFrenchFullDate(line);
    if (d) { curDate = d; continue; }
    if (!curDate) continue;

    // ex: "PSG Inter 21:00"
    const m = line.match(/^(.*?)\s(\d{1,2}):(\d{2})$/);
    if (!m) continue;

    const label = m[1].trim();
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    const start = isoLocal(curDate.year, curDate.month, curDate.day, hh, mm);
    if (!withinHorizon(start, 180)) continue;

    out.push({
      title: `LDC: ${label}`,
      start,
      source: "Foot Mercato (LDC)",
      url,
      tags: ["foot", "match", "LDC"]
    });
  }

  return out;
}

async function fetchFootMercatoUclMatches() {
  const res = await fetch(FOOTMERCATO_UCL_CALENDAR_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`FM UCL calendar HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const links = new Set();
  $("a").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    if (!href.includes("/europe/ligue-des-champions-uefa/calendrier/")) return;
    if (!href.includes("journee-")) return;
    links.add(new URL(href, FOOTMERCATO_UCL_CALENDAR_URL).toString());
  });

  const urls = links.size ? [...links] : [FOOTMERCATO_UCL_CALENDAR_URL];

  const out = [];
  for (const u of urls.slice(0, 25)) {
    try { out.push(...await fetchUclMatchdayPage(u)); } catch (e) { console.warn(e.message); }
  }
  return out;
}

// ===== MAIN =====
async function main() {
  const all = [];
  const counts = {};

  async function add(name, fn) {
    try {
      const evts = await fn();
      const list = Array.isArray(evts) ? evts : [];
      all.push(...list);
      counts[name] = list.length;
    } catch (e) {
      counts[name] = 0;
      console.warn(`${name} error: ${e.message}`);
    }
  }

  await add("Foot Mercato (clubs)", async () => {
    const out = [];
    for (const src of FOOTMERCATO_CLUB_CALENDARS) out.push(...await fetchFootMercatoClubMatches(src));
    return out;
  });

  await add("Foot Mercato (LDC)", fetchFootMercatoUclMatches);
  await add("Anime-sama", fetchAnimeSama);
  await add("Twitch", fetchTwitchICal);
  await add("lolix.gg", fetchLolixPredictions);

  const events = dedupeEvents(all);

  await fs.mkdir(path.dirname(OUT_EVENTS_PATH), { recursive: true });
  await fs.writeFile(OUT_EVENTS_PATH, JSON.stringify(events, null, 2), "utf-8");

  const status = { generatedAt: new Date().toISOString(), total: events.length, counts };
  await fs.writeFile(OUT_STATUS_PATH, JSON.stringify(status, null, 2), "utf-8");

  console.log(`Wrote ${events.length} events to ${OUT_EVENTS_PATH}`);
  console.log(status);
}

main();
