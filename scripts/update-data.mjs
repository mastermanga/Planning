import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import ical from "node-ical";
import { XMLParser } from "fast-xml-parser";

const OUT_PATH = path.join("data", "generated.json");
const STATUS_PATH = path.join("data", "status.json");

// Sources
const ANIMESAMA_PLANNING_URL = "https://anime-sama.si/planning/";
const LOLIX_PRED_URL = "https://lolix.gg/predictions";
const LOLIX_DATA_URL = "https://lolix.gg/predictions/__data.json";
const FOOTMERCATO_RSS_URL = "https://www.footmercato.net/flux-rss";
const FOOTMERCATO_SITEMAP_NEWS_URL = "https://www.footmercato.net/sitemap-news.xml";

// Twitch channels (IDs stables)
const TWITCH_CHANNELS = [
  { login: "domingo", display: "Domingo", broadcasterId: "40063341" },
  { login: "rivenzi", display: "Rivenzi", broadcasterId: "32053915" },
  { login: "joueur_du_grenier", display: "Joueur_du_Grenier", broadcasterId: "68078157" }
];

// Run only at 06:00 & 13:00 Paris (gère l’heure d’été) — sauf FORCE_UPDATE=1
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

// Helpers dates
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

// Keep: pas d’events vieux de +5h (pour Lolix)
function isTooOld(startISO, hours = 5) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return false;
  return t < Date.now() - hours * 3600_000;
}

// ---------- Anime-sama ----------
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

// ---------- Twitch iCalendar ----------
async function fetchTwitchICalOne(ch) {
  const icalUrl = `https://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=${ch.broadcasterId}`;
  const res = await fetch(icalUrl, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`Twitch ${ch.login} iCal HTTP ${res.status}`);

  const icsText = await res.text();
  const parsed = ical.parseICS(icsText);

  const events = [];
  for (const k of Object.keys(parsed)) {
    const item = parsed[k];
    if (item?.type !== "VEVENT") continue;

    const start = item.start?.toISOString?.() || item.start;
    const end = item.end?.toISOString?.() || item.end;

    events.push({
      title: `${ch.display} — ${item.summary || "Stream"}`,
      start,
      end,
      source: "Twitch",
      url: `https://www.twitch.tv/${ch.login}/schedule`,
      tags: ["stream", ch.login]
    });
  }
  return events;
}
async function fetchTwitchAll() {
  const all = [];
  for (const ch of TWITCH_CHANNELS) {
    const ev = await fetchTwitchICalOne(ch);
    all.push(...ev);
  }
  return all;
}

// ---------- Lolix (SvelteKit __data.json) ----------
function safePreview(str, max = 500) {
  const s = String(str ?? "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// Helpers de résolution “pool”
function poolGet(pool, ref) {
  if (typeof ref === "number" && ref >= 0 && ref < pool.length) return pool[ref];
  return ref;
}
function resolveString(pool, ref) {
  const v = poolGet(pool, ref);
  return typeof v === "string" ? v : (typeof ref === "string" ? ref : null);
}
function resolveArray(pool, ref) {
  const v = poolGet(pool, ref);
  return Array.isArray(v) ? v : (Array.isArray(ref) ? ref : null);
}
function resolveObj(pool, ref) {
  const v = poolGet(pool, ref);
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : ((ref && typeof ref === "object" && !Array.isArray(ref)) ? ref : null);
}

function looksLikeLolixMatch(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return ("begin_at" in obj) && ("opponents" in obj) && ("status" in obj || "match_type" in obj || "tournament_id" in obj);
}

function decodeLolixMatch(pool, m) {
  const begin = resolveString(pool, m.begin_at);
  if (!begin) return null;

  const startDate = new Date(begin);
  if (!Number.isFinite(startDate.getTime())) return null;

  const oppArr = resolveArray(pool, m.opponents);
  if (!oppArr || oppArr.length < 2) return null;

  const names = [];
  for (const entry of oppArr) {
    const entryObj = resolveObj(pool, entry) || entry;
    const oppRef = entryObj?.opponent ?? entryObj;
    const teamObj = resolveObj(pool, oppRef) || poolGet(pool, oppRef);

    const nm =
      resolveString(pool, teamObj?.name) ||
      resolveString(pool, teamObj?.acronym) ||
      resolveString(pool, teamObj?.slug);

    if (nm) names.push(nm);
  }
  if (names.length < 2) return null;

  // League / acronym (optionnel)
  let leagueAcr = null;
  const leagueObj = resolveObj(pool, m.league);
  if (leagueObj) {
    leagueAcr = resolveString(pool, leagueObj.acronym) || resolveString(pool, leagueObj.name);
  }

  const title = `${leagueAcr ? `[${leagueAcr}] ` : ""}${names[0]} vs ${names[1]}`;

  return {
    title,
    start: startDate.toISOString(),
    source: "lolix.gg",
    url: LOLIX_PRED_URL,
    tags: ["predictions", "esport", leagueAcr ? String(leagueAcr).toLowerCase() : "lolix"]
  };
}

function extractLolixFromAnySvelteData(root) {
  const out = [];
  const seenKey = new Set();

  function extractFromPool(pool) {
    for (const item of pool) {
      if (looksLikeLolixMatch(item)) {
        const ev = decodeLolixMatch(pool, item);
        if (ev) {
          const key = `${ev.start}__${ev.title}`;
          if (!seenKey.has(key)) {
            seenKey.add(key);
            out.push(ev);
          }
        }
      }
      // pools imbriqués
      if (item && typeof item === "object" && item.type === "data" && Array.isArray(item.data)) {
        extractFromPool(item.data);
      }
    }
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (node.type === "data" && Array.isArray(node.data)) {
      extractFromPool(node.data);
    }
    if (Array.isArray(node.nodes)) {
      for (const n of node.nodes) walk(n);
    }

    // Cherche aussi des "type:data" un peu partout sans traverser toute la planète :
    // on traverse uniquement les objets directs.
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") {
        if (v.type === "data" && Array.isArray(v.data)) walk(v);
        if (Array.isArray(v)) {
          for (const x of v) {
            if (x && typeof x === "object" && x.type === "data" && Array.isArray(x.data)) walk(x);
          }
        }
      }
    }
  }

  walk(root);
  return out;
}

async function fetchLolixPredictions() {
  // Important : reproduit le param vu dans ton navigateur
  const dataUrl = `${LOLIX_DATA_URL}?x=sveltekit-invalidate-${Date.now()}`;

  const res = await fetch(dataUrl, {
    headers: {
      "user-agent": "planning-bot/1.0",
      "accept": "application/json, text/plain, */*",
      "referer": LOLIX_PRED_URL
    }
  });
  if (!res.ok) throw new Error(`Lolix __data.json HTTP ${res.status}`);

  const raw = await res.text();

  console.log(`[lolix] __data.json bytes=${raw.length} preview=${safePreview(raw, 180)}`);

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Lolix: JSON.parse failed (${e.message}). preview=${safePreview(raw, 180)}`);
  }

  const extracted = extractLolixFromAnySvelteData(json);

  // Filtre “pas besoin de ce qui est passé de plus de 5h”
  const filtered = extracted.filter(ev => !isTooOld(ev.start, 5));

  console.log(`[lolix] extracted=${extracted.length} kept(last 5h+)=${filtered.length}`);
  return filtered;
}

// ---------- Foot Mercato (inchangé / à trier plus tard) ----------
async function fetchFootMercato() {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

  // RSS
  try {
    const r = await fetch(FOOTMERCATO_RSS_URL, { headers: { "user-agent": "planning-bot/1.0" }});
    if (r.ok) {
      const xml = await r.text();
      const doc = parser.parse(xml);
      const items = doc?.rss?.channel?.item || [];
      const arr = Array.isArray(items) ? items : [items];

      return arr
        .filter(it => it?.title && (it?.pubDate || it?.date))
        .slice(0, 80)
        .map(it => ({
          title: `FM: ${it.title}`,
          start: new Date(it.pubDate || it.date).toISOString(),
          source: "Foot Mercato (RSS)",
          url: it.link || FOOTMERCATO_RSS_URL,
          tags: ["foot", "news"]
        }));
    }
  } catch {
    // ignore -> fallback
  }

  // Fallback sitemap-news.xml
  const res = await fetch(FOOTMERCATO_SITEMAP_NEWS_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`FM sitemap HTTP ${res.status}`);
  const xml = await res.text();
  const doc = parser.parse(xml);

  let urls = doc?.urlset?.url || [];
  if (!Array.isArray(urls)) urls = [urls];

  const now = Date.now();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const out = [];

  for (const u of urls) {
    const loc = u.loc;
    const news = u.news;
    const title = news?.title;
    const pub = news?.publication_date;
    if (!loc || !title || !pub) continue;

    const t = new Date(pub).getTime();
    if (!Number.isFinite(t)) continue;
    if (now - t > maxAgeMs) continue;

    out.push({
      title: `FM: ${title}`,
      start: new Date(pub).toISOString(),
      source: "Foot Mercato (sitemap)",
      url: loc,
      tags: ["foot", "news"]
    });
  }
  return out;
}

// ---------- Main ----------
async function main() {
  const events = [];
  const errors = [];
  const counts = {};

  async function run(name, fn) {
    try {
      const arr = await fn();
      counts[name] = arr.length;
      events.push(...arr);
    } catch (e) {
      counts[name] = 0;
      errors.push(`${name}: ${e.message}`);
      console.warn(`${name} failed:`, e.message);
    }
  }

  await run("Anime-sama", fetchAnimeSama);
  await run("Twitch", fetchTwitchAll);
  await run("lolix.gg", fetchLolixPredictions);
  await run("Foot Mercato", fetchFootMercato);

  // Tri + écriture
  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(events, null, 2), "utf-8");

  const status = {
    generatedAt: new Date().toISOString(),
    total: events.length,
    counts,
    errors
  };
  await fs.writeFile(STATUS_PATH, JSON.stringify(status, null, 2), "utf-8");

  console.log(`Wrote ${events.length} events to ${OUT_PATH}`);
  console.log(`Status -> ${STATUS_PATH}`);
}

main();
