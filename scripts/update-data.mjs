// scripts/update-data.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ical from "node-ical";
import * as cheerio from "cheerio";

// ------------------ Paths (toujours depuis la racine du projet) ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const OUT_EVENTS = path.join(PROJECT_ROOT, "data", "generated.json");
const OUT_STATUS = path.join(PROJECT_ROOT, "data", "status.json");
const OUT_LOLIX_RAW = path.join(PROJECT_ROOT, "data", "lolix-raw.json");

// ------------------ Config ------------------
const UA = "planning-bot/1.0 (+github-actions)";

// Garde les événements passés pendant 7 jours
const MAX_PAST_DAYS = 7;

// Limite les événements anime à 2 semaines (~14 jours) dans le futur
const ANIME_LOOKAHEAD_DAYS = 14;

// Repeat weekly horizon (on garde 52, mais on coupe avant avec isTooFarInFuture)
const REPEAT_WEEKS = 52;

// Google sheet (pubhtml -> on force CSV)
const SHEET_PUBHTML =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT36bHnWhI-sdvq6NOmAyYU1BQZJT4WAsIYozR7fnARi_xBgU0keZw0mTF-N3s3x7V5tcaAofqO78Aq/pubhtml";
const SHEET_CSV = SHEET_PUBHTML.replace(/\/pubhtml.*$/i, "/pub?output=csv");

// Apps Script API (Feuille 2 "À rattraper")
const MISSED_API_URL =
  "https://script.google.com/macros/s/AKfycbyc3qhOWQ7u6wSer9pXlUxldIykkmls32tsgFV7gd45yIapraoVEPUHLPRhXozM7OGeMw/exec";

// Lolix API
const LOLIX_MATCHES_API = "https://lolix.gg/api/predictions/matches";

// Twitch channels (IDs fournis)
const TWITCH_CHANNELS = [
  {
    user: "domingo",
    label: "Domingo",
    broadcasterId: "40063341",
    scheduleUrl: "https://www.twitch.tv/domingo/schedule",
  },
  {
    user: "rivenzi",
    label: "Rivenzi",
    broadcasterId: "32053915",
    scheduleUrl: "https://www.twitch.tv/rivenzi/schedule",
  },
  {
    user: "joueur_du_grenier",
    label: "Joueur du Grenier",
    broadcasterId: "68078157",
    scheduleUrl: "https://www.twitch.tv/joueur_du_grenier/schedule",
  },
];

// ------------------ Football-data.org (API) ------------------
// ⚠️ Mets ta clé dans l'env: FOOTBALL_DATA_TOKEN (GitHub Actions secret)
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// Compétitions à interroger (couvre tes clubs + LDC)
const FOOT_COMPETITIONS = [
  { code: "CL", tag: "ldc" }, // UEFA Champions League
  { code: "PL", tag: "premier_league" },
  { code: "PD", tag: "liga" }, // La Liga
  { code: "BL1", tag: "bundesliga" },
  { code: "FL1", tag: "ligue1" }, // Ligue 1
];

// Équipes suivies (matching “souple” via aliases)
const FOOT_TEAMS = [
  { tag: "barcelone", aliases: ["FC Barcelona", "Futbol Club Barcelona"] },
  { tag: "real_madrid", aliases: ["Real Madrid CF", "Real Madrid"] },
  { tag: "manchester_city", aliases: ["Manchester City FC", "Manchester City"] },
  { tag: "liverpool", aliases: ["Liverpool FC", "Liverpool"] },
  {
    tag: "bayern",
    aliases: ["FC Bayern München", "Bayern München", "Bayern Munchen", "Bayern"],
  },
  { tag: "psg", aliases: ["Paris Saint-Germain FC", "Paris Saint Germain", "Paris SG", "PSG"] },
  { tag: "nice", aliases: ["OGC Nice", "Nice"] },
  {
    tag: "asse",
    aliases: ["AS Saint-Étienne", "AS Saint-Etienne", "Saint-Étienne", "Saint-Etienne", "ASSE"],
  },
];

// Horizon des matchs (en jours) qu’on récupère depuis football-data.org
const FOOT_LOOKAHEAD_DAYS = 30;

// ------------------ F1 (f1calendar HTML) ------------------
const F1_SCHEDULE_URL = "https://f1calendar.com/fr";
const F1_LOOKAHEAD_DAYS = 14;

// ------------------ Guards / Fetch utils ------------------
if (typeof fetch !== "function") {
  throw new Error("fetch() indisponible. Utilise Node 18+ (ou ajoute un polyfill fetch).");
}

function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(t));
}

async function writeJSON(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

function normSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function isTooOld(startISO) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return false;
  const cutoff = Date.now() - MAX_PAST_DAYS * 86400000;
  return t < cutoff;
}

function isTooFarInFuture(startISO, maxDays = ANIME_LOOKAHEAD_DAYS) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return false;
  const limit = Date.now() + maxDays * 86400000;
  return t > limit;
}

function isWithinFutureWindow(startISO, maxDays) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return false;
  const limit = Date.now() + maxDays * 86400000;
  return t <= limit;
}

function makeKey(ev) {
  return `${ev.source}|${ev.title}|${ev.start}`.toLowerCase();
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const key = makeKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

function lower(v) {
  return String(v ?? "").toLowerCase();
}

function uniqLowerTags(tags) {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((t) => lower(t)).filter(Boolean)));
}

function isAnimeEvent(ev) {
  const tags = uniqLowerTags(ev.tags || []);
  return tags.includes("anime");
}

function formatStartForMissedSheet(startValue) {
  const d = new Date(startValue);
  if (!Number.isFinite(d.getTime())) return String(startValue || "");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// ------------------ CSV (simple parser) ------------------
function detectDelimiter(firstLine) {
  const c = (firstLine.match(/,/g) || []).length;
  const s = (firstLine.match(/;/g) || []).length;
  return s > c ? ";" : ",";
}

function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) || "";
  const delim = detectDelimiter(firstNonEmpty);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delim) {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (ch === "\r") continue;

    field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows
    .map((r) => r.map((v) => (v ?? "").toString().trim()))
    .filter((r) => r.some((v) => v.length > 0));
}

function toIsoLocalFromSheet(s) {
  const t = normSpaces(s);
  if (!t) return null;

  let iso = t.includes("T") ? t : t.replace(" ", "T");

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(iso)) iso += ":00";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += "T00:00:00";

  return iso;
}

function addDaysIsoLocal(isoLocal, days) {
  const m = isoLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return isoLocal;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = m[4];
  const mm = m[5];
  const ss = m[6];

  const base = Date.UTC(y, mo - 1, d);
  const next = new Date(base + days * 86400000);

  const yy = next.getUTCFullYear();
  const MM = String(next.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${MM}-${DD}T${hh}:${mm}:${ss}`;
}

// ------------------ Anime from Google Sheet (CSV) ------------------
async function fetchAnimeFromSheet() {
  const res = await fetchWithTimeout(SHEET_CSV, { headers: { "user-agent": UA } }, 20000);
  if (!res.ok) throw new Error(`Google sheet CSV HTTP ${res.status}`);
  const csv = await res.text();

  const rows = parseCSV(csv);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.toLowerCase());
  const idx = (name) => headers.indexOf(name);

  const iTitle = idx("title");
  const iStart = idx("start");
  const iEnd = idx("end");
  const iTags = idx("tags");
  const iUrl = idx("url");
  const iRepeat = idx("repeat");
  const iGoogleSheet = idx("google sheet");

  if (iTitle === -1 || iStart === -1) {
    throw new Error("Google sheet: colonnes minimales 'title' et 'start' introuvables");
  }

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const title = normSpaces(row[iTitle]);
    const start0 = toIsoLocalFromSheet(row[iStart]);
    if (!title || !start0) continue;

    const end0 = iEnd !== -1 ? toIsoLocalFromSheet(row[iEnd]) : null;
    const url = iUrl !== -1 ? normSpaces(row[iUrl]) : "";
    const googleSheetUrl = iGoogleSheet !== -1 ? normSpaces(row[iGoogleSheet]) : "";
    const tagsRaw = iTags !== -1 ? normSpaces(row[iTags]) : "";
    const repeatRaw = iRepeat !== -1 ? normSpaces(row[iRepeat]) : "";

    const tags = safeTags(tagsRaw).map((t) => t.toLowerCase());
    if (tags.length === 0 && tagsRaw) tags.push(tagsRaw.toLowerCase());

    const shouldRepeat = repeatRaw.toLowerCase() === "oui";

    const base = {
      title,
      start: start0,
      end: end0 || undefined,
      source: "Anime (sheet)",
      url,
      googleSheetUrl,
      tags,
    };

    if (!shouldRepeat) {
      if (!isTooOld(base.start) && !isTooFarInFuture(base.start)) {
        out.push(base);
      }
      continue;
    }

    for (let k = 0; k < REPEAT_WEEKS; k++) {
      const startK = addDaysIsoLocal(start0, k * 7);
      const endK = end0 ? addDaysIsoLocal(end0, k * 7) : undefined;

      if (isTooOld(startK)) continue;
      if (isTooFarInFuture(startK)) break;

      out.push({
        ...base,
        start: startK,
        end: endK,
      });
    }
  }

  return out;
}

// ------------------ Twitch (direct broadcasterId -> iCal) ------------------
function twitchIcalUrl(broadcasterId) {
  return `https://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=${broadcasterId}`;
}

/**
 * Twitch renvoie souvent des TZID non standard (ex: TZID=/America/New_York).
 * node-ical peut alors interpréter l'heure comme "floating"/locale (souvent UTC sur CI),
 * ce qui cause un décalage (ex: +1h en Europe/Paris l'hiver).
 *
 * On normalise donc l'ICS avant parsing.
 */
function normalizeTwitchIcs(icsText) {
  return String(icsText || "")
    .replace(/TZID=\/([^:;]+)/g, "TZID=$1")
    .replace(/TZID="\/([^"]+)"/g, 'TZID="$1"')
    .replace(/X-WR-TIMEZONE:\/([^\r\n]+)/g, "X-WR-TIMEZONE:$1");
}

async function fetchTwitchChannel({ user, label, broadcasterId, scheduleUrl }) {
  const icalUrl = twitchIcalUrl(broadcasterId);

  const r = await fetchWithTimeout(icalUrl, { headers: { "user-agent": UA } }, 20000);
  if (!r.ok) throw new Error(`Twitch iCal HTTP ${r.status}`);

  const rawIcs = await r.text();
  const icsText = normalizeTwitchIcs(rawIcs);
  const parsed = ical.sync.parseICS(icsText);

  const out = [];
  for (const k of Object.keys(parsed)) {
    const item = parsed[k];
    if (item?.type !== "VEVENT") continue;

    const start = item.start instanceof Date ? item.start.toISOString() : String(item.start);
    const end =
      item.end instanceof Date ? item.end.toISOString() : item.end ? String(item.end) : undefined;

    if (!start || isTooOld(start)) continue;

    out.push({
      title: `${label} — ${item.summary || "Stream"}`,
      start,
      end,
      source: `Twitch:${user}`,
      url: scheduleUrl,
      tags: ["twitch", user],
    });
  }
  return out;
}

// ------------------ Lolix (API JSON) ------------------
function buildLolixTitle(match) {
  const league = match?.league?.name ? String(match.league.name).trim() : "LOL";
  const opp = Array.isArray(match?.opponents) ? match.opponents : [];

  const teamNames = opp
    .map((o) => o?.opponent?.name || o?.opponent?.acronym)
    .filter(Boolean)
    .map(String);

  if (teamNames.length >= 2) return `[${league}] ${teamNames[0]} vs ${teamNames[1]}`;
  if (teamNames.length === 1) return `[${league}] ${teamNames[0]} (TBD)`;
  return `[${league}] Match`;
}

function lolixTags(match) {
  const tags = ["lolix", "esport", "lol"];
  const league = match?.league?.name ? String(match.league.name).toLowerCase() : "";
  if (league) tags.push(league);

  const title = buildLolixTitle(match).toLowerCase();
  if (title.includes("gen.g") || title.includes("geng")) tags.push("geng");
  if (title.includes("fnatic") || title.includes("fnc")) tags.push("fnatic");
  return Array.from(new Set(tags));
}

async function fetchLolixMatches() {
  const res = await fetchWithTimeout(LOLIX_MATCHES_API, { headers: { "user-agent": UA } }, 20000);
  if (!res.ok) throw new Error(`Lolix API HTTP ${res.status}`);

  const data = await res.json();

  const summary = {
    fetchedAt: new Date().toISOString(),
    endpoint: LOLIX_MATCHES_API,
    topKeys: Object.keys(data || {}),
    counts: {
      past: Array.isArray(data?.past) ? data.past.length : 0,
      running: Array.isArray(data?.running) ? data.running.length : 0,
      upcoming: Array.isArray(data?.upcoming) ? data.upcoming.length : 0,
    },
  };

  await writeJSON(OUT_LOLIX_RAW, { summary, payload: data });

  const all = [
    ...(Array.isArray(data?.past) ? data.past : []),
    ...(Array.isArray(data?.running) ? data.running : []),
    ...(Array.isArray(data?.upcoming) ? data.upcoming : []),
  ];

  const out = [];
  for (const m of all) {
    const start = m?.begin_at ? String(m.begin_at) : null;
    if (!start) continue;
    if (isTooOld(start)) continue;

    out.push({
      title: buildLolixTitle(m),
      start,
      end: undefined,
      source: "lolix.gg",
      url: "https://lolix.gg/predictions",
      tags: lolixTags(m),
    });
  }

  return out;
}

// ------------------ Football-data.org (matchs) ------------------
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function watchedTeamTag(teamName) {
  const n = normName(teamName);
  for (const t of FOOT_TEAMS) {
    for (const alias of t.aliases) {
      const a = normName(alias);
      if (!a) continue;
      if (n === a) return t.tag;
      if (n.includes(a) || a.includes(n)) return t.tag;
    }
  }
  return null;
}

function yyyyMmDd(d) {
  return d.toISOString().slice(0, 10);
}

async function fdFetchJson(urlPath, timeoutMs = 20000) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error("FOOTBALL_DATA_TOKEN manquant (env var). Ajoute-le dans les secrets GitHub Actions.");
  }
  const url = `${FOOTBALL_DATA_BASE}${urlPath}`;
  const r = await fetchWithTimeout(
    url,
    {
      headers: {
        "user-agent": UA,
        "X-Auth-Token": FOOTBALL_DATA_TOKEN,
      },
    },
    timeoutMs
  );

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`football-data.org HTTP ${r.status}${txt ? ` — ${txt.slice(0, 200)}` : ""}`);
  }
  return r.json();
}

async function fetchFootMatchesFootballData() {
  const now = new Date();
  const dateFrom = yyyyMmDd(now);
  const dateTo = yyyyMmDd(new Date(now.getTime() + FOOT_LOOKAHEAD_DAYS * 86400000));

  const out = [];

  for (const c of FOOT_COMPETITIONS) {
    const data = await fdFetchJson(
      `/competitions/${c.code}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );
    const matches = Array.isArray(data?.matches) ? data.matches : [];

    for (const m of matches) {
      const start = m?.utcDate ? String(m.utcDate) : "";
      if (!start || isTooOld(start)) continue;

      const home = m?.homeTeam?.name || "";
      const away = m?.awayTeam?.name || "";
      const compName = m?.competition?.name || c.code;

      const tagHome = watchedTeamTag(home);
      const tagAway = watchedTeamTag(away);

      if (!tagHome && !tagAway) continue;

      out.push({
        title: `⚽ [${compName}] ${home} vs ${away}`,
        start,
        end: undefined,
        source: "football-data.org",
        url: "https://www.football-data.org/",
        tags: Array.from(new Set(["foot", c.tag, tagHome, tagAway].filter(Boolean))),
      });
    }
  }

  return dedupe(out);
}

// ------------------ F1 (f1calendar HTML) ------------------
function detectF1SessionType(summary = "", description = "") {
  const s = `${summary} ${description}`.toLowerCase();

  if (/\b(testing|winter testing|essais hivernaux)\b/.test(s)) return "testing";
  if (/\b(sprint shootout|sprint qualifying|qualifs sprint)\b/.test(s)) {
    return "sprint_qualifying";
  }
  if (/\b(fp1|free practice 1|practice 1|essais libres 1)\b/.test(s)) return "fp1";
  if (/\b(fp2|free practice 2|practice 2|essais libres 2)\b/.test(s)) return "fp2";
  if (/\b(fp3|free practice 3|practice 3|essais libres 3)\b/.test(s)) return "fp3";
  if (/\b(qualifications|qualification|qualifying)\b/.test(s)) return "qualification";
  if (/\b(sprint)\b/.test(s)) return "sprint";
  if (/\b(course|grand prix|race)\b/.test(s)) return "course";

  return "session";
}

function buildF1Tags(summary = "", description = "") {
  const type = detectF1SessionType(summary, description);
  return Array.from(new Set(["f1", "formula1", "sport_auto", type].filter(Boolean)));
}

function normalizeF1Title(summary = "") {
  const raw = normSpaces(summary || "F1 Session");
  return raw.startsWith("F1") || raw.startsWith("FORMULA 1")
    ? `🏎️ ${raw}`
    : `🏎️ F1 — ${raw}`;
}

function normalizeF1Start(startRaw) {
  const s = normSpaces(startRaw);
  if (!s) return "";

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/i.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/i.test(s)) return `${s}Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/i.test(s)) return `${s}:00Z`;

  return s;
}

function extractGrandPrixNameFromTbodyId(id = "") {
  return normSpaces(
    String(id)
      .replace(/-/g, " ")
      .replace(/\bgrand prix\b/i, "Grand Prix")
      .replace(/\b\w/g, (m) => m.toUpperCase())
  );
}

function extractSessionTextFromRow($, row) {
  const cellTexts = row
    .find("td")
    .map((_, td) => normSpaces($(td).text()))
    .get()
    .filter(Boolean);

  // Le texte de session est souvent dans la colonne de gauche.
  // On évite les colonnes purement date/heure.
  for (const text of cellTexts) {
    if (!text) continue;
    if (/^\d{1,2}\s+\w+$/i.test(text)) continue;
    if (/^\d{1,2}:\d{2}/.test(text)) continue;
    return text;
  }

  return "";
}

async function fetchF1Sessions() {
  console.log("[F1] Fetching:", F1_SCHEDULE_URL);

  const r = await fetchWithTimeout(
    F1_SCHEDULE_URL,
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
    },
    20000
  );

  if (!r.ok) {
    throw new Error(`F1 Calendar HTTP ${r.status}`);
  }

  const html = await r.text();
  console.log("[F1] html size:", html.length);

  const $ = cheerio.load(html);

  console.log("[F1] title:", $("title").text().trim());

  const main = $("main").first();
  console.log("[F1] main count:", $("main").length);

  const mainChildren = main.children("div");
  console.log("[F1] main direct div count:", mainChildren.length);

  mainChildren.each((i, el) => {
    const child = $(el);
    const childHtml = child.html() || "";
    const tables = child.find("table");
    const tbodies = child.find("tbody");
    const times = child.find("time[datetime]");

    console.log(
      `[F1] main > div #${i + 1}: htmlSize=${childHtml.length} tables=${tables.length} tbodies=${tbodies.length} times=${times.length}`
    );

    console.log(`[F1] main > div #${i + 1} sample:`);
    console.log(childHtml.slice(0, 1200));
  });

  const secondDiv = mainChildren.eq(1);
  console.log("[F1] second div exists:", secondDiv.length);

  if (secondDiv.length) {
    console.log("[F1] second div table count:", secondDiv.find("table").length);
    console.log("[F1] second div tbody count:", secondDiv.find("tbody").length);
    console.log("[F1] second div tr count:", secondDiv.find("tr").length);
    console.log("[F1] second div time count:", secondDiv.find("time[datetime]").length);

    secondDiv.find("tbody").each((i, tbodyNode) => {
      const tbody = $(tbodyNode);
      console.log(`[F1] second div tbody #${i + 1} id=`, tbody.attr("id"));

      const rows = tbody.find("tr");
      console.log(`[F1] second div tbody #${i + 1} rows=`, rows.length);

      rows.each((j, trNode) => {
        if (j >= 3) return false;

        const row = $(trNode);
        const cells = row
          .find("td")
          .map((_, td) => normSpaces($(td).text()))
          .get();

        const timeAttrs = row
          .find("time[datetime]")
          .map((_, t) => $(t).attr("datetime"))
          .get();

        console.log(
          `[F1] row sample tbody=${i + 1} row=${j + 1} cells=`,
          cells
        );
        console.log(
          `[F1] row sample tbody=${i + 1} row=${j + 1} datetimes=`,
          timeAttrs
        );
      });
    });
  }

  const out = [];
  console.log("[F1] parsed events:", out.length);
  return out;
}

// ------------------ Missed anime sheet sync ------------------
async function fetchExistingMissedKeys() {
  const res = await fetchWithTimeout(
    MISSED_API_URL,
    {
      headers: { "user-agent": UA },
    },
    20000
  );

  if (!res.ok) {
    throw new Error(`Missed sheet GET HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) return new Set();

  return new Set(data.map((item) => lower(item?.key)).filter(Boolean));
}

async function addMissedAnimeToSheet(ev) {
  const payload = {
    action: "add",
    key: makeKey(ev),
    anime: normSpaces(ev.title),
    start: formatStartForMissedSheet(ev.start),
    url: ev.url || "",
  };

  const res = await fetchWithTimeout(
    MISSED_API_URL,
    {
      method: "POST",
      headers: {
        "user-agent": UA,
        "content-type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify(payload),
    },
    20000
  );

  if (!res.ok) {
    throw new Error(`Missed sheet POST HTTP ${res.status}`);
  }

  return res.text();
}

async function syncMissedAnime(events) {
  const existingKeys = await fetchExistingMissedKeys();

  const candidates = dedupe(events)
    .filter((ev) => ev?.title && ev?.start)
    .filter((ev) => isAnimeEvent(ev))
    .filter((ev) => {
      const t = new Date(ev.start).getTime();
      return Number.isFinite(t) && t <= Date.now();
    });

  let added = 0;

  for (const ev of candidates) {
    const key = makeKey(ev);
    if (existingKeys.has(key)) continue;

    await addMissedAnimeToSheet(ev);
    existingKeys.add(key);
    added++;
  }

  return { added, totalCandidates: candidates.length };
}

// ------------------ MAIN ------------------
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

  await run("Anime (sheet)", fetchAnimeFromSheet);

  for (const ch of TWITCH_CHANNELS) {
    await run(`Twitch:${ch.user}`, () => fetchTwitchChannel(ch));
  }

  await run("lolix.gg", fetchLolixMatches);
  await run("football-data.org (foot)", fetchFootMatchesFootballData);
  await run("F1 (f1calendar.com)", fetchF1Sessions);

  const cleaned = dedupe(all)
    .filter((ev) => ev?.title && ev?.start)
    .filter((ev) => !isTooOld(ev.start))
    .map((ev) => ({
      title: normSpaces(ev.title),
      start: ev.start,
      end: ev.end,
      source: normSpaces(ev.source || "unknown"),
      url: ev.url || "",
      googleSheetUrl: ev.googleSheetUrl || "",
      location: normSpaces(ev.location || ""),
      tags: safeTags(ev.tags).map((t) => String(t).toLowerCase()),
    }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  let missedSync = { added: 0, totalCandidates: 0 };
  try {
    missedSync = await syncMissedAnime(cleaned);
  } catch (e) {
    errors.push(`missed-anime-sync: ${e?.message || String(e)}`);
  }

  counts["missed_anime_added"] = missedSync.added;
  counts["missed_anime_candidates"] = missedSync.totalCandidates;

  await writeJSON(OUT_EVENTS, cleaned);
  await writeJSON(OUT_STATUS, {
    generatedAt: new Date().toISOString(),
    total: cleaned.length,
    counts,
    errors,
  });

  console.log(`Wrote ${cleaned.length} events -> ${OUT_EVENTS}`);
  console.log(`Missed anime sync: added ${missedSync.added}/${missedSync.totalCandidates}`);
  if (errors.length) console.warn("Errors:", errors);
}

main().catch(async (e) => {
  console.error(e);
  await writeJSON(OUT_STATUS, {
    generatedAt: new Date().toISOString(),
    total: 0,
    counts: {},
    errors: [String(e?.message || e)],
  });
  process.exit(1);
});
