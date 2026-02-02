import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import * as icalNS from "node-ical";
import { XMLParser } from "fast-xml-parser";

const OUT_PATH = path.join("data", "generated.json");
const STATUS_PATH = path.join("data", "status.json");

// Sources
const ANIMESAMA_PLANNING_URL = "https://anime-sama.si/planning/";

const LOLIX_PRED_URL = "https://lolix.gg/predictions";
const LOLIX_FALLBACK_DATA_URL = "https://lolix.gg/predictions/__data.json";

const FOOTMERCATO_RSS_URL = "https://www.footmercato.net/flux-rss";
const FOOTMERCATO_SITEMAP_NEWS_URL = "https://www.footmercato.net/sitemap-news.xml";

// Twitch channels (logins)
const TWITCH_LOGINS = ["domingo", "rivenzi", "joueur_du_grenier"];

// =========================
// Filtre temps : passé max 5h
// =========================
const PAST_LIMIT_MS = 5 * 60 * 60 * 1000;
function keepNotTooOld(startISO) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - PAST_LIMIT_MS;
}

// Dédup + tri
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
// Twitch : parseICS robuste + plusieurs chaînes
// =========================
function getParseICS() {
  const fn = icalNS?.parseICS || icalNS?.default?.parseICS;
  if (typeof fn !== "function") throw new Error("node-ical: parseICS introuvable.");
  return fn;
}

// Trouve le broadcaster_id en scrapant la page Twitch (sans API/clé)
async function resolveTwitchBroadcasterId(login) {
  const url = `https://www.twitch.tv/${login}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "planning-bot/1.0",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`Twitch page HTTP ${res.status} (${login})`);
  const html = await res.text();

  // Plusieurs patterns possibles selon les versions Twitch
  const patterns = [
    /"channelId":"(\d+)"/,
    /"channelID":"(\d+)"/,
    /"broadcasterId":"(\d+)"/,
    /"id":"(\d+)","login":"([^"]+)"/, // on vérifie login après
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (!m) continue;

    if (p.source.includes('"id":"') && m[2]) {
      if (m[2].toLowerCase() === login.toLowerCase()) return m[1];
      continue;
    }
    return m[1];
  }

  throw new Error(`Twitch: broadcaster_id introuvable pour ${login}`);
}

async function fetchTwitchICalForLogin(login) {
  const broadcasterId = await resolveTwitchBroadcasterId(login);
  const icalUrl = `https://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=${broadcasterId}`;

  const res = await fetch(icalUrl, { headers: { "user-agent": "planning-bot/1.0" } });
  if (!res.ok) throw new Error(`Twitch iCal HTTP ${res.status} (${login})`);
  const icsText = await res.text();

  const parseICS = getParseICS();
  const parsed = parseICS(icsText);

  const out = [];
  for (const k of Object.keys(parsed)) {
    const item = parsed[k];
    if (item?.type !== "VEVENT") continue;

    const startISO = item.start?.toISOString?.() || item.start;
    if (!startISO) continue;

    // filtre 5h
    if (!keepNotTooOld(startISO)) continue;

    out.push({
      title: `${login} — ${item.summary || "Stream"}`,
      start: startISO,
      end: item.end?.toISOString?.() || item.end,
      source: "Twitch",
      url: `https://www.twitch.tv/${login}/schedule`,
      tags: ["stream", login],
    });
  }
  return out;
}

async function fetchAllTwitch() {
  const all = [];
  for (const login of TWITCH_LOGINS) {
    try {
      all.push(...await fetchTwitchICalForLogin(login));
    } catch (e) {
      // on laisse main() collecter l'erreur via throw
      throw e;
    }
  }
  return all;
}

// =========================
// Anime-sama (simple, garde si tu veux)
// =========================
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
function cleanTitle(raw) {
  return raw
    .replace(/^\s*(Anime|Scans)\s+/i, "")
    .replace(/\s+\d{1,2}h\d{2}\s*/i, " ")
    .replace(/\s+Saison\s+\d+/i, "")
    .trim();
}
async function fetchAnimeSama() {
  const res = await fetch(ANIMESAMA_PLANNING_URL, {
    headers: { "user-agent": "planning-bot/1.0" },
  });
  if (!res.ok) throw new Error(`Anime-sama HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const text = $("body").text().replace(/\u00a0/g, " ");
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);

  let currentDate = null;
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

    const start = isoLocal(currentDate.y, currentDate.m, currentDate.d, hh, mm);
    if (!keepNotTooOld(start)) continue;

    out.push({
      title: cleanTitle(title),
      start,
      source: "Anime-sama",
      url: ANIMESAMA_PLANNING_URL,
      tags: ["anime"],
    });
  }

  return out;
}

// =========================
// Lolix : récupérer l’URL __data.json exacte (avec query) + debug
// =========================

// Résolution SvelteKit refs -> pool
function resolveFromPool(pool, value, memo) {
  // ref
  if (Number.isInteger(value) && value >= 0 && value < pool.length) {
    const target = pool[value];
    if (target === null || typeof target !== "object") return target; // primitif
    return resolveFromPool(pool, target, memo);
  }

  // array
  if (Array.isArray(value)) return value.map(v => resolveFromPool(pool, v, memo));

  // object
  if (value && typeof value === "object") {
    if (memo.has(value)) return memo.get(value);
    const out = {};
    memo.set(value, out);
    for (const k of Object.keys(value)) out[k] = resolveFromPool(pool, value[k], memo);
    return out;
  }

  return value;
}

function extractMatchesFromLolixSveltekit(json) {
  const nodes = Array.isArray(json?.nodes) ? json.nodes : [];
  let best = [];

  for (const node of nodes) {
    if (!node || node.type !== "data" || !Array.isArray(node.data)) continue;
    const pool = node.data;

    for (const item of pool) {
      if (!item || typeof item !== "object") continue;
      if (!("matches" in item)) continue;

      const memo = new WeakMap();
      const resolved = resolveFromPool(pool, item, memo);
      const matches = resolved?.matches;

      if (Array.isArray(matches) && matches.length > best.length) best = matches;
    }
  }
  return best;
}

async function getLolixDataUrlFromHtml() {
  const res = await fetch(LOLIX_PRED_URL, {
    headers: { "user-agent": "planning-bot/1.0" },
  });
  if (!res.ok) throw new Error(`Lolix page HTTP ${res.status}`);
  const html = await res.text();

  // debug HTML reçu par GH Actions (pratique si blocage)
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(path.join("data", "lolix-page.html"), html, "utf-8");

  // On cherche /predictions/__data.json?... (avec query si présent)
  const m = html.match(/\/predictions\/__data\.json\?[^"'<> ]+/);
  if (m) return new URL(m[0], "https://lolix.gg").toString();

  // sinon sans query
  const m2 = html.match(/\/predictions\/__data\.json/);
  if (m2) return new URL(m2[0], "https://lolix.gg").toString();

  // fallback
  return LOLIX_FALLBACK_DATA_URL;
}

async function fetchLolixPredictions() {
  const dataUrl = await getLolixDataUrlFromHtml();

  const res = await fetch(dataUrl, {
    headers: {
      "user-agent": "planning-bot/1.0",
      accept: "application/json",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      referer: LOLIX_PRED_URL,
    },
  });

  const rawText = await res.text();
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(path.join("data", "lolix-raw.txt"), rawText, "utf-8");

  if (!res.ok) throw new Error(`Lolix data HTTP ${res.status}`);

  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error("Lolix: réponse non-JSON (voir data/lolix-raw.txt)");
  }

  // debug JSON (si vide, on le verra)
  await fs.writeFile(path.join("data", "lolix-raw.json"), JSON.stringify(json, null, 2), "utf-8");

  // Si c’est vide: très probablement besoin de query spécifique ou données non publiques côté runner
  if (Array.isArray(json) && json.length === 0) {
    throw new Error("Lolix: __data.json renvoie [] sur GitHub Actions (voir data/lolix-raw.txt + lolix-page.html)");
  }

  const matches = extractMatchesFromLolixSveltekit(json);
  if (!matches.length) {
    throw new Error("Lolix: 0 match extrait (structure inattendue). Voir data/lolix-raw.json");
  }

  const out = [];
  for (const m of matches) {
    const beginAt = m.begin_at || m.beginAt;
    if (!beginAt) continue;

    const d = new Date(beginAt);
    if (!Number.isFinite(d.getTime())) continue;

    const startISO = d.toISOString();
    if (!keepNotTooOld(startISO)) continue;

    const opp = m.opponents || [];
    const t1 = opp?.[0]?.opponent?.name || opp?.[0]?.name;
    const t2 = opp?.[1]?.opponent?.name || opp?.[1]?.name;
    if (!t1 || !t2) continue;

    const leagueName = m.league?.name || m.tournament?.league?.name || "";

    out.push({
      title: `${t1} vs ${t2}${leagueName ? ` (${leagueName})` : ""}`,
      start: startISO,
      source: "lolix.gg",
      url: LOLIX_PRED_URL,
      tags: ["esport", "predictions", leagueName ? String(leagueName).toLowerCase() : ""].filter(Boolean),
    });
  }

  return dedupe(out);
}

// =========================
// FootMercato (on touche pas maintenant)
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
const LDC_KEYWORDS = ["ligue des champions", "champions league", "ldc", "c1"];
function classifyFM(title) {
  const t = String(title || "").toLowerCase();
  if (LDC_KEYWORDS.some(k => t.includes(k))) return "Foot Mercato (LDC)";
  if (CLUB_KEYWORDS.some(k => t.includes(k))) return "Foot Mercato (clubs)";
  return null;
}
async function fetchFootMercato() {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

  // RSS
  try {
    const r = await fetch(FOOTMERCATO_RSS_URL, { headers: { "user-agent": "planning-bot/1.0" } });
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
          tags: ["foot", cat.includes("LDC") ? "ldc" : "clubs"],
        });
      }
      return out;
    }
  } catch {
    // fallback
  }

  // sitemap
  const res = await fetch(FOOTMERCATO_SITEMAP_NEWS_URL, { headers: { "user-agent": "planning-bot/1.0" } });
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
      tags: ["foot", cat.includes("LDC") ? "ldc" : "clubs"],
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
  try { all.push(...await fetchAllTwitch()); } catch (e) { errors.push(`Twitch: ${e.message}`); }
  try { all.push(...await fetchLolixPredictions()); } catch (e) { errors.push(`lolix.gg: ${e.message}`); }
  try { all.push(...await fetchFootMercato()); } catch (e) { errors.push(`Foot Mercato: ${e.message}`); }

  const filtered = all.filter(e => e?.start && keepNotTooOld(e.start));
  const finalEvents = sortByStart(dedupe(filtered));

  const counts = {};
  for (const e of finalEvents) counts[e.source] = (counts[e.source] || 0) + 1;

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(finalEvents, null, 2), "utf-8");

  const status = {
    generatedAt: new Date().toISOString(),
    total: finalEvents.length,
    counts,
    errors: errors.length ? errors : undefined,
  };
  await fs.writeFile(STATUS_PATH, JSON.stringify(status, null, 2), "utf-8");

  console.log(`Wrote ${finalEvents.length} events to ${OUT_PATH}`);
  if (errors.length) console.warn(errors.join("\n"));
}

main();
