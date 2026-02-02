// scripts/update-data.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import * as nodeIcal from "node-ical";

// ------------------ Paths (✅ fix: toujours depuis la racine du projet) ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const OUT_EVENTS = path.join(PROJECT_ROOT, "data", "generated.json");
const OUT_STATUS = path.join(PROJECT_ROOT, "data", "status.json");
const OUT_LOLIX_RAW = path.join(PROJECT_ROOT, "data", "lolix-raw.json");

// ------------------ Sources ------------------
const ANIMESAMA_PLANNING_URL = "https://anime-sama.si/planning/";
const LOLIX_PRED_URL = "https://lolix.gg/predictions";
const FOOTMERCATO_TV_URL = "https://www.footmercato.net/programme-tv/";

// Twitch channels (logins)
const TWITCH_LOGINS = ["domingo", "rivenzi", "joueur_du_grenier"];

const UA = "planning-bot/1.0";

const MONTHS_FR = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12
};

// ------------------ Node/fetch safety ------------------
if (typeof fetch !== "function") {
  throw new Error("fetch() indisponible. Utilise Node 18+ (ou ajoute un polyfill fetch).");
}

function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(t));
}

// ------------------ Run window (06:00 & 13:00 Paris unless FORCE_UPDATE=1) ------------------
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
  console.log(`Skip: Paris time is ${parisHM()} (wanted 06:00 or 13:00). Set FORCE_UPDATE=1 to run now.`);
  process.exit(0);
}

// ------------------ Utils ------------------
function guessYear(day, month) {
  const now = new Date();
  let y = now.getFullYear();
  const candidate = new Date(Date.UTC(y, month - 1, day));
  const diffDays = (candidate - now) / 86400000;
  if (diffDays < -180) y += 1;
  if (diffDays > 180) y -= 1;
  return y;
}

function isoLocal(y, m, d, hh, mm) {
  const MM = String(m).padStart(2, "0");
  const DD = String(d).padStart(2, "0");
  return `${y}-${MM}-${DD}T${hh}:${mm}:00`;
}

function normSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
  return String(tags).split(",").map(t => t.trim()).filter(Boolean);
}

function makeId(ev) {
  return `${ev.source}|${ev.start}|${ev.title}`.toLowerCase();
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const id = makeId(ev);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(ev);
  }
  return out;
}

function pruneOlderThan5h(events) {
  const now = Date.now();
  const limit = now - 5 * 60 * 60 * 1000;
  return events.filter(ev => {
    const t = Date.parse(ev.start);
    if (!Number.isFinite(t)) return true;
    return t >= limit;
  });
}

async function writeJSON(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

/* ===================== Anime-sama ===================== */
function parseAnimeSamaTime(text) {
  const m = text.match(/(\d{1,2})h(\d{2})/);
  if (!m) return null;
  return { hh: String(m[1]).padStart(2, "0"), mm: m[2] };
}

function cleanAnimeTitle(raw) {
  return raw
    .replace(/^\s*(Anime|Scans)\s+/i, "")
    .replace(/\s+\d{1,2}h\d{2}\s*/i, " ")
    .replace(/\s+Saison\s+\d+/i, "")
    .trim();
}

async function fetchAnimeSama() {
  const res = await fetchWithTimeout(ANIMESAMA_PLANNING_URL, { headers: { "user-agent": UA } }, 20000);
  if (!res.ok) throw new Error(`Anime-sama HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const DAY_NAMES = new Set(["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"]);
  const events = [];

  $("h2").each((_, h2) => {
    const dayName = normSpaces($(h2).text());
    if (!DAY_NAMES.has(dayName)) return;

    const afterText = $(h2).nextUntil("h2").text();
    const dm = afterText.match(/(\d{2})\/(\d{2})/);
    if (!dm) return;

    const dd = Number(dm[1]);
    const mm = Number(dm[2]);
    const year = guessYear(dd, mm);

    $(h2).nextUntil("h2").find("a").each((__, a) => {
      const raw = normSpaces($(a).text());
      const time = parseAnimeSamaTime(raw);
      if (!time) return;

      const href = $(a).attr("href");
      const url = href ? new URL(href, ANIMESAMA_PLANNING_URL).toString() : ANIMESAMA_PLANNING_URL;

      events.push({
        title: cleanAnimeTitle(raw),
        start: isoLocal(year, mm, dd, time.hh, time.mm),
        source: "Anime-sama",
        url,
        tags: raw.toLowerCase().startsWith("scans") ? ["anime", "scans"] : ["anime"]
      });
    });
  });

  return events;
}

/* ===================== Twitch iCalendar (✅ fix: extraction depuis /schedule) ===================== */
function parseICS(icsText) {
  // node-ical expose parseICS selon version
  if (typeof nodeIcal.parseICS === "function") return nodeIcal.parseICS(icsText);
  if (nodeIcal.default && typeof nodeIcal.default.parseICS === "function") return nodeIcal.default.parseICS(icsText);
  if (nodeIcal.sync && typeof nodeIcal.sync.parseICS === "function") return nodeIcal.sync.parseICS(icsText);
  throw new Error("node-ical: parseICS introuvable");
}

function extractTwitchIcalUrl(html) {
  // Twitch peut échapper l’URL : https:\/\/... et \u0026
  const re = /https:\\\/\\\/api\.twitch\.tv\\\/helix\\\/schedule\\\/icalendar\?[^"'\\\s<]+/i;
  let m = html.match(re);
  if (m?.[0]) {
    return m[0].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }

  // fallback: URL non échappée
  m = html.match(/https:\/\/api\.twitch\.tv\/helix\/schedule\/icalendar\?[^"' \s<]+/i);
  return m?.[0] || null;
}

async function fetchTwitchSchedule(login) {
  const scheduleUrl = `https://www.twitch.tv/${login}/schedule`;

  const page = await fetchWithTimeout(scheduleUrl, { headers: { "user-agent": UA } }, 20000);
  if (!page.ok) throw new Error(`Twitch schedule HTTP ${page.status} for ${login}`);

  const html = await page.text();
  const icalUrl = extractTwitchIcalUrl(html);
  if (!icalUrl) throw new Error(`Twitch iCal URL introuvable sur /schedule pour ${login}`);

  const res = await fetchWithTimeout(icalUrl, { headers: { "user-agent": UA } }, 20000);
  if (!res.ok) throw new Error(`Twitch iCal HTTP ${res.status} for ${login}`);

  const icsText = await res.text();
  const parsed = parseICS(icsText);

  const events = [];
  for (const k of Object.keys(parsed)) {
    const item = parsed[k];
    if (item?.type !== "VEVENT") continue;

    const startIso = item.start?.toISOString?.() || (item.start ? new Date(item.start).toISOString() : null);
    if (!startIso) continue;

    const endIso = item.end?.toISOString?.() || (item.end ? new Date(item.end).toISOString() : undefined);

    events.push({
      title: `${login} — ${item.summary || "Stream"}`,
      start: startIso,
      end: endIso,
      source: `Twitch:${login}`,
      url: scheduleUrl,
      tags: ["twitch", `twitch-${login}`]
    });
  }
  return events;
}

/* ===================== Lolix predictions ===================== */
function detectLeagueTag(title) {
  const t = title.toLowerCase();
  if (t.includes("[lec]") || t.includes(" lec ")) return "lec";
  if (t.includes("[lck]") || t.includes(" lck ")) return "lck";
  return null;
}
function addTeamTags(title, tags) {
  const t = title.toLowerCase();
  if (t.includes("gen.g") || t.includes("geng")) tags.push("geng");
  if (t.includes("fnatic") || t.includes("fnc")) tags.push("fnatic");
}

async function fetchLolixPredictions() {
  const res = await fetchWithTimeout(LOLIX_PRED_URL, { headers: { "user-agent": UA } }, 20000);
  if (!res.ok) throw new Error(`Lolix HTTP ${res.status}`);

  const html = await res.text();
  const $ = load(html);

  const rawText = $("body").text();
  const lines = rawText.split("\n").map(s => s.trim()).filter(Boolean);

  await writeJSON(OUT_LOLIX_RAW, lines.slice(0, 400));

  let curDay = null;
  let curTime = null;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const mDate = line.match(/^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche)\s+(\d{1,2})\s+([a-zéûôîàç]+)$/i);
    if (mDate) {
      const d = Number(mDate[2]);
      const monthName = mDate[3].toLowerCase();
      const m = MONTHS_FR[monthName];
      if (m) curDay = { y: guessYear(d, m), m, d };
      continue;
    }

    const mTime = line.match(/^(\d{1,2}):(\d{2})$/);
    if (mTime) {
      curTime = `${String(mTime[1]).padStart(2, "0")}:${mTime[2]}`;
      continue;
    }

    if (curDay && curTime) {
      const looksLikeMatch = line.length <= 80 && /vs/i.test(line);
      if (looksLikeMatch) {
        const [hh, mm] = curTime.split(":");
        const tags = ["predictions", "esport"];
        const league = detectLeagueTag(line);
        if (league) tags.push(league);
        addTeamTags(line, tags);

        out.push({
          title: line,
          start: isoLocal(curDay.y, curDay.m, curDay.d, hh, mm),
          source: "lolix.gg",
          url: LOLIX_PRED_URL,
          tags
        });
      }
    }
  }

  return out;
}

/* ===================== Foot Mercato - matches ===================== */
const TARGET_TEAM_KEYWORDS = [
  "barcelone", "fc barcelone", "barcelona",
  "real madrid",
  "manchester city", "man city",
  "liverpool",
  "bayern", "bayern munich", "bayern de munich",
  "psg", "paris saint-germain", "paris-saint-germain",
  "nice", "ogc nice",
  "saint-etienne", "saint étienne", "st etienne", "st-étienne"
];

function includesTargetTeam(s) {
  const t = s.toLowerCase();
  return TARGET_TEAM_KEYWORDS.some(k => t.includes(k));
}

async function enrichFootMatchFromPage(matchUrl) {
  const res = await fetchWithTimeout(matchUrl, { headers: { "user-agent": UA } }, 20000);
  if (!res.ok) throw new Error(`FM match page HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);
  const text = normSpaces($("body").text());

  const dm = text.match(/\bDate\s+(\d{1,2})\s+([a-zéûôîàç]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})\b/i);
  let startIso = null;
  if (dm) {
    const dd = Number(dm[1]);
    const monthName = dm[2].toLowerCase();
    const yyyy = Number(dm[3]);
    const hh = String(dm[4]).padStart(2, "0");
    const mm = dm[5];
    const mo = MONTHS_FR[monthName];
    if (mo) startIso = isoLocal(yyyy, mo, dd, hh, mm);
  }

  const cm = text.match(/\bCompétition\s+(.+?)\s+Saison\b/i);
  const competition = cm?.[1] ? normSpaces(cm[1]) : null;

  const tm = text.match(/\bÉquipe à domicile\s+(.+?)\s+Équipe à l'extérieur\s+(.+?)\s+(Résultats|En direct)\b/i);
  let home = tm?.[1] ? normSpaces(tm[1]) : null;
  let away = tm?.[2] ? normSpaces(tm[2]) : null;

  if (!home || !away) {
    const m2 = text.match(/\bMatch\s+(.+?)\s*-\s*(.+?)\s+en direct/i);
    if (m2) {
      home = home || normSpaces(m2[1]);
      away = away || normSpaces(m2[2]);
    }
  }

  const title = home && away ? `${home} vs ${away}` : "Match";
  const tags = ["foot", "match"];
  if (competition) {
    tags.push(competition.toLowerCase().includes("champions") ? "ldc" : "foot-other");
  }
  if (includesTargetTeam(title)) {
    if (title.toLowerCase().includes("barcel")) tags.push("barcelona");
  }

  return { title, start: startIso, competition, tags };
}

async function fetchFootMercatoMatches() {
  const res = await fetchWithTimeout(FOOTMERCATO_TV_URL, { headers: { "user-agent": UA } }, 20000);
  if (!res.ok) throw new Error(`FM programme-tv HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const linkByText = new Map();
  $("a").each((_, a) => {
    const t = normSpaces($(a).text());
    const href = $(a).attr("href");
    if (!t || !href) return;
    if (!linkByText.has(t)) linkByText.set(t, href);
  });

  const lines = $("body").text().split("\n").map(s => s.trim()).filter(Boolean);

  let curDay = null; // {y,m,d}
  const candidates = [];

  for (const line of lines) {
    const mHead = line.match(/(\d{1,2})\s+([a-zéûôîàç]+)\b/i);
    if (mHead && /lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|aujourd|demain/i.test(line.toLowerCase())) {
      const d = Number(mHead[1]);
      const mo = MONTHS_FR[mHead[2].toLowerCase()];
      if (mo) curDay = { y: guessYear(d, mo), m: mo, d };
      continue;
    }

    const mt = line.match(/^(.+?)\s+(\d{1,2}):(\d{2})$/);
    if (!mt || !curDay) continue;

    const titleText = normSpaces(mt[1]);
    const hh = String(mt[2]).padStart(2, "0");
    const mm = mt[3];

    const fullText = normSpaces(line);
    const href = linkByText.get(fullText) || linkByText.get(`${titleText} ${hh}:${mm}`);
    let url = null;
    if (href) url = new URL(href, "https://www.footmercato.net").toString();

    candidates.push({
      rawTitle: titleText,
      startGuess: isoLocal(curDay.y, curDay.m, curDay.d, hh, mm),
      url
    });
  }

  const MAX = 120;
  const sliced = candidates.slice(0, MAX);

  const out = [];
  for (const c of sliced) {
    if (!c.url || !c.url.includes("footmercato.net")) continue;

    try {
      const enriched = await enrichFootMatchFromPage(c.url);
      const comp = (enriched.competition || "").toLowerCase();
      const isLDC = comp.includes("ligue des champions") || comp.includes("champions league") || enriched.tags.includes("ldc");
      const isClub = includesTargetTeam(enriched.title);

      if (!isLDC && !isClub) continue;

      out.push({
        title: enriched.title,
        start: enriched.start || c.startGuess,
        source: "Foot Mercato (match)",
        url: c.url,
        tags: isLDC ? [...enriched.tags, "ldc"] : enriched.tags
      });
    } catch {
      // ignore individual match failures
    }
  }

  return out;
}

/* ===================== MAIN ===================== */
async function main() {
  const errors = [];
  const counts = {};
  const all = [];

  async function run(name, fn) {
    try {
      const items = await fn();
      counts[name] = items.length;
      all.push(...items);
    } catch (e) {
      counts[name] = 0;
      errors.push(`${name}: ${e?.message || String(e)}`);
    }
  }

  await run("Anime-sama", fetchAnimeSama);

  for (const login of TWITCH_LOGINS) {
    await run(`Twitch:${login}`, () => fetchTwitchSchedule(login));
  }

  await run("lolix.gg", fetchLolixPredictions);
  await run("Foot Mercato (match)", fetchFootMercatoMatches);

  let events = dedupe(all).map(ev => ({
    title: normSpaces(ev.title),
    start: ev.start,
    end: ev.end,
    source: normSpaces(ev.source || "unknown"),
    url: ev.url || "",
    tags: safeTags(ev.tags)
  }));

  events = pruneOlderThan5h(events);

  await writeJSON(OUT_EVENTS, events);

  await writeJSON(OUT_STATUS, {
    generatedAt: new Date().toISOString(),
    total: events.length,
    counts,
    errors
  });

  console.log(`Wrote ${events.length} events to ${OUT_EVENTS}`);
  if (errors.length) console.warn("Errors:", errors);
}

main().catch(async (e) => {
  console.error(e);
  await writeJSON(OUT_STATUS, {
    generatedAt: new Date().toISOString(),
    total: 0,
    counts: {},
    errors: [String(e?.message || e)]
  });
  process.exit(1);
});
