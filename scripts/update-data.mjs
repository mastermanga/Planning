import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import * as ical from "node-ical";
import { XMLParser } from "fast-xml-parser";

const OUT_PATH = path.join("data", "generated.json");
const STATUS_PATH = path.join("data", "status.json");

// Sources
const ANIMESAMA_PLANNING_URL = "https://anime-sama.si/planning/";
const LOLIX_PRED_URL = "https://lolix.gg/predictions";
const LOLIX_DATA_URL = "https://lolix.gg/predictions/__data.json";
const TWITCH_ICAL_URL = "https://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=40063341";
const FOOTMERCATO_RSS_URL = "https://www.footmercato.net/flux-rss";
const FOOTMERCATO_SITEMAP_NEWS_URL = "https://www.footmercato.net/sitemap-news.xml";

// =========================
// Helpers temps / filtrage
// =========================

// Garder tout ce qui est futur + passé max 5h
const PAST_LIMIT_MS = 5 * 60 * 60 * 1000;

function keepNotTooOld(startISO) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - PAST_LIMIT_MS;
}

// Dédup simple
function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = `${e.title}__${e.start}__${e.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function sortByStart(events) {
  return events.sort((a, b) => new Date(a.start) - new Date(b.start));
}

// =========================
// Helpers dates (Anime/Lolix texte si besoin)
// =========================

const MONTHS_FR = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12
};

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

// =========================
// Anime-sama (optionnel)
// =========================

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

// Version robuste : parse du texte
async function fetchAnimeSama() {
  const res = await fetch(ANIMESAMA_PLANNING_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`Anime-sama HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const text = $("body").text().replace(/\u00a0/g, " ");
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);

  let currentDate = null; // {y,m,d}
  const out = [];

  for (const line of lines) {
    const dm = line.match(/\b(\d{2})\/(\d{2})\b/);
    if (dm) {
      const d = Number(dm[1]);
      const m = Number(dm[2]);
      const y = guessYear(d, m);
      currentDate = { y, m, d };
    }

    if (!currentDate) continue;

    const tm = line.match(/\b(\d{1,2})h(\d{2})\b/);
    if (!tm) continue;

    const hh = String(tm[1]).padStart(2, "0");
    const mm = tm[2];

    let title = line
      .replace(/\b(\d{2})\/(\d{2})\b/g, "")
      .replace(/\b(\d{1,2})h(\d{2})\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!title || title.length < 3) continue;
    if (title.toLowerCase().includes("planning")) continue;

    out.push({
      title: cleanTitle(title),
      start: isoLocal(currentDate.y, currentDate.m, currentDate.d, hh, mm),
      source: "Anime-sama",
      url: ANIMESAMA_PLANNING_URL,
      tags: ["anime"]
    });
  }

  return out;
}

// =========================
// Twitch iCalendar
// =========================

async function fetchTwitchICal() {
  const res = await fetch(TWITCH_ICAL_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`Twitch iCal HTTP ${res.status}`);
  const icsText = await res.text();
  const parsed = ical.parseICS(icsText);

  const out = [];
  for (const k of Object.keys(parsed)) {
    const item = parsed[k];
    if (item?.type !== "VEVENT") continue;

    const startISO = item.start?.toISOString?.() || item.start;
    if (!startISO) continue;

    out.push({
      title: item.summary || "Stream",
      start: startISO,
      end: item.end?.toISOString?.() || item.end,
      source: "Twitch",
      url: "https://www.twitch.tv/domingo/schedule",
      tags: ["stream"]
    });
  }
  return out;
}

// =========================
// Lolix (JSON SvelteKit __data.json)
// =========================

function findAllMatchLists(node, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const it of node) findAllMatchLists(it, found);
    return found;
  }
  if (typeof node === "object") {
    if (Array.isArray(node.matches)) found.push(node.matches);
    for (const k of Object.keys(node)) findAllMatchLists(node[k], found);
  }
  return found;
}

async function fetchLolixPredictions() {
  // 1) on tente direct __data.json
  let json = null;

  const r = await fetch(LOLIX_DATA_URL, {
    headers: { "user-agent": "planning-bot/1.0", "accept": "application/json" }
  });

  if (r.ok) {
    json = await r.json();
  } else {
    // 2) fallback : on récupère le HTML et on cherche une URL __data.json?...
    const htmlRes = await fetch(LOLIX_PRED_URL, { headers: { "user-agent": "planning-bot/1.0" }});
    if (!htmlRes.ok) throw new Error(`Lolix page HTTP ${htmlRes.status}`);
    const html = await htmlRes.text();

    const m = html.match(/\/predictions\/__data\.json[^"'<> ]*/);
    if (!m) throw new Error(`Lolix: __data.json not found in HTML (maybe protected)`);
    const url = new URL(m[0], "https://lolix.gg").toString();

    const rr = await fetch(url, { headers: { "user-agent": "planning-bot/1.0", "accept": "application/json" }});
    if (!rr.ok) throw new Error(`Lolix __data.json fallback HTTP ${rr.status}`);
    json = await rr.json();
  }

  const lists = findAllMatchLists(json);
  const matches = lists.sort((a, b) => b.length - a.length)[0] || [];

  const out = [];

  for (const m of matches) {
    const beginAt = m.begin_at || m.beginAt || m.start_at || m.startAt;
    if (!beginAt) continue;

    const d = new Date(beginAt);
    if (!Number.isFinite(d.getTime())) continue;

    const opponents = m.opponents || [];
    const t1 = opponents?.[0]?.opponent?.name || opponents?.[0]?.name;
    const t2 = opponents?.[1]?.opponent?.name || opponents?.[1]?.name;
    if (!t1 || !t2) continue;

    const leagueName = m.league?.name || m.tournament?.league?.name || "";
    const startISO = d.toISOString();

    // Filtre demandé : pas besoin de ce qui est passé depuis + de 5h
    if (!keepNotTooOld(startISO)) continue;

    out.push({
      title: `${t1} vs ${t2}${leagueName ? ` (${leagueName})` : ""}`,
      start: startISO,
      source: "lolix.gg",
      url: LOLIX_PRED_URL,
      tags: ["esport", "predictions", leagueName ? String(leagueName).toLowerCase() : ""].filter(Boolean)
    });
  }

  return dedupe(out);
}

// =========================
// FootMercato : RSS ou sitemap -> filtre clubs + LDC
// =========================

const CLUB_KEYWORDS = [
  "barcelone", "fc barcelone", "barça", "barca",
  "real madrid", "madrid",
  "manchester city", "man city",
  "liverpool",
  "bayern", "bayern munich", "bayern de munich",
  "psg", "paris saint-germain", "paris sg",
  "nice", "ogc nice",
  "saint-etienne", "saint étienne", "asse"
];

const LDC_KEYWORDS = [
  "ligue des champions", "champions league", "ldc", "c1"
];

function classifyFM(title) {
  const t = String(title || "").toLowerCase();

  const isLDC = LDC_KEYWORDS.some(k => t.includes(k));
  if (isLDC) return "Foot Mercato (LDC)";

  const isClub = CLUB_KEYWORDS.some(k => t.includes(k));
  if (isClub) return "Foot Mercato (clubs)";

  return null; // on ignore le reste
}

async function fetchFootMercato() {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

  // 1) Essai RSS
  try {
    const r = await fetch(FOOTMERCATO_RSS_URL, { headers: { "user-agent": "planning-bot/1.0" }});
    if (r.ok) {
      const xml = await r.text();
      const doc = parser.parse(xml);

      const items = doc?.rss?.channel?.item || [];
      const arr = Array.isArray(items) ? items : [items];

      const out = [];
      for (const it of arr) {
        const title = it?.title;
        const pubDate = it?.pubDate || it?.date;
        const link = it?.link || FOOTMERCATO_RSS_URL;
        if (!title || !pubDate) continue;

        const cat = classifyFM(title);
        if (!cat) continue;

        const startISO = new Date(pubDate).toISOString();
        if (!keepNotTooOld(startISO)) continue;

        out.push({
          title: `FM: ${title}`,
          start: startISO,
          source: cat,
          url: link,
          tags: ["foot", cat.includes("LDC") ? "ldc" : "clubs"]
        });
      }
      return out;
    }
  } catch {
    // ignore -> fallback
  }

  // 2) Fallback sitemap-news.xml
  const res = await fetch(FOOTMERCATO_SITEMAP_NEWS_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`FM sitemap HTTP ${res.status}`);
  const xml = await res.text();
  const doc = parser.parse(xml);

  let urls = doc?.urlset?.url || [];
  if (!Array.isArray(urls)) urls = [urls];

  const out = [];
  for (const u of urls) {
    const loc = u.loc;
    const news = u.news;
    const title = news?.title;
    const pub = news?.publication_date;
    if (!loc || !title || !pub) continue;

    const cat = classifyFM(title);
    if (!cat) continue;

    const startISO = new Date(pub).toISOString();
    if (!keepNotTooOld(startISO)) continue;

    out.push({
      title: `FM: ${title}`,
      start: startISO,
      source: cat,
      url: loc,
      tags: ["foot", cat.includes("LDC") ? "ldc" : "clubs"]
    });
  }

  return out;
}

// =========================
// Main
// =========================

async function main() {
  const all = [];
  const errors = [];

  try { all.push(...await fetchAnimeSama()); } catch (e) { errors.push(`Anime-sama: ${e.message}`); }
  try { all.push(...await fetchTwitchICal()); } catch (e) { errors.push(`Twitch: ${e.message}`); }
  try { all.push(...await fetchLolixPredictions()); } catch (e) { errors.push(`lolix.gg: ${e.message}`); }
  try { all.push(...await fetchFootMercato()); } catch (e) { errors.push(`Foot Mercato: ${e.message}`); }

  // Filtre global : pas besoin de tout ce qui est passé depuis + de 5h
  const filtered = all.filter(e => e?.start && keepNotTooOld(e.start));
  const finalEvents = sortByStart(dedupe(filtered));

  // Status counts
  const counts = {};
  for (const e of finalEvents) {
    counts[e.source] = (counts[e.source] || 0) + 1;
  }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(finalEvents, null, 2), "utf-8");

  const status = {
    generatedAt: new Date().toISOString(),
    total: finalEvents.length,
    counts,
    errors: errors.length ? errors : undefined
  };
  await fs.writeFile(STATUS_PATH, JSON.stringify(status, null, 2), "utf-8");

  console.log(`Wrote ${finalEvents.length} events to ${OUT_PATH}`);
  console.log(`Wrote status to ${STATUS_PATH}`);
  if (errors.length) console.warn("Errors:\n" + errors.join("\n"));
}

main();
