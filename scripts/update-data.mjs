import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import * as ical from "node-ical";
import { XMLParser } from "fast-xml-parser";

const OUT_PATH = path.join("data", "generated.json");

// Sources
const ANIMESAMA_PLANNING_URL = "https://anime-sama.si/planning/";
const LOLIX_PRED_URL = "https://lolix.gg/predictions";
const TWITCH_ICAL_URL = "https://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=40063341";
const FOOTMERCATO_RSS_URL = "https://www.footmercato.net/flux-rss";
const FOOTMERCATO_SITEMAP_NEWS_URL = "https://www.footmercato.net/sitemap-news.xml";

// Run only at 06:00 & 13:00 Paris (gère l’heure d’été)
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

// Helpers dates (ISO local sans offset)
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

// --- Anime-sama ---
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
      end: item.end?.toISOString?.() || item.end,
      source: "Twitch",
      url: "https://www.twitch.tv/domingo/schedule",
      tags: ["stream"]
    });
  }
  return events;
}

// --- Lolix predictions ---
async function fetchLolixPredictions() {
  const res = await fetch(LOLIX_PRED_URL, { headers: { "user-agent": "planning-bot/1.0" }});
  if (!res.ok) throw new Error(`Lolix HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const lines = $("body").text().split("\n").map(s => s.trim()).filter(Boolean);
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
      curTime = `${String(mTime[1]).padStart(2,"0")}:${mTime[2]}`;
      continue;
    }

    if (curDay && curTime && /%$/.test(line)) {
      const a = line.match(/^(.+?)\s+(\d{1,3})%$/);
      const bLine = lines[i + 1] || "";
      const b = bLine.match(/^(.+?)\s+(\d{1,3})%$/);
      if (a && b) {
        const [hh, mm] = curTime.split(":");
        out.push({
          title: `${a[1].trim()} vs ${b[1].trim()} (${a[2]}/${b[2]})`,
          start: isoLocal(curDay.y, curDay.m, curDay.d, hh, mm),
          source: "lolix.gg",
          url: LOLIX_PRED_URL,
          tags: ["predictions", "esport"]
        });
        i += 1;
      }
    }
  }
  return out;
}

// --- Foot Mercato : RSS si possible, sinon sitemap ---
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
  } catch (e) {
    // ignore -> fallback
  }

  // 2) Fallback sitemap-news.xml
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

async function main() {
  const out = [];
  try { out.push(...await fetchAnimeSama()); } catch (e) { console.warn(e.message); }
  try { out.push(...await fetchTwitchICal()); } catch (e) { console.warn(e.message); }
  try { out.push(...await fetchLolixPredictions()); } catch (e) { console.warn(e.message); }
  try { out.push(...await fetchFootMercato()); } catch (e) { console.warn(e.message); }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${out.length} events to ${OUT_PATH}`);
}

main();
