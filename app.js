// scripts/update-data.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import ical from "node-ical";

const OUT_PATH = path.join("data", "generated.json");
const STATUS_PATH = path.join("data", "status.json");

// ------------------ Config ------------------
const TWITCH_CHANNELS = [
  { user: "domingo", label: "Domingo", scheduleUrl: "https://www.twitch.tv/domingo/schedule" },
  { user: "joueur_du_grenier", label: "Joueur du Grenier", scheduleUrl: "https://www.twitch.tv/joueur_du_grenier/schedule" },
  { user: "rivenzi", label: "Rivenzi", scheduleUrl: "https://www.twitch.tv/rivenzi/schedule" },
];

const FOOT_CLUB_PAGES = [
  { tag: "barcelone", label: "Barcelone", url: "https://www.footmercato.net/programme-tv/club/fc-barcelone" },
  { tag: "real_madrid", label: "Real Madrid", url: "https://www.footmercato.net/programme-tv/club/real-madrid" },
  { tag: "manchester_city", label: "Manchester City", url: "https://www.footmercato.net/programme-tv/club/manchester-city" },
  { tag: "liverpool", label: "Liverpool", url: "https://www.footmercato.net/programme-tv/club/liverpool" },
  { tag: "bayern", label: "Bayern", url: "https://www.footmercato.net/programme-tv/club/bayern-munich" },
  { tag: "psg", label: "PSG", url: "https://www.footmercato.net/programme-tv/club/psg" },
  { tag: "nice", label: "Nice", url: "https://www.footmercato.net/programme-tv/club/ogc-nice" },
  { tag: "saint_etienne", label: "Saint-Étienne", url: "https://www.footmercato.net/programme-tv/club/saint-etienne" },
];

// Ligue des Champions : il peut y avoir “Aucun match” hors période
const FOOT_LDC_PAGE = {
  tag: "ldc",
  label: "Ligue des Champions",
  url: "https://www.footmercato.net/programme-tv/europe/ligue-des-champions-uefa",
};

// Filtre : pas d’event commencé il y a plus de 5h
const MAX_PAST_HOURS = 5;

// ------------------ Utils ------------------
const UA = "planning-bot/1.0 (+github-actions)";
const MONTHS_FR = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
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

function isTooOld(startISO) {
  const t = new Date(startISO).getTime();
  if (!Number.isFinite(t)) return false;
  const cutoff = Date.now() - MAX_PAST_HOURS * 3600 * 1000;
  return t < cutoff;
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const key = `${ev.source}|${ev.title}|${ev.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

async function writeJSON(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

// ------------------ Twitch ------------------
async function resolveTwitchIcal(scheduleUrl) {
  const res = await fetch(scheduleUrl, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`schedule HTTP ${res.status}`);
  const html = await res.text();

  const m = html.match(/https:\/\/api\.twitch\.tv\/helix\/schedule\/icalendar\?broadcaster_id=\d+/);
  if (!m) throw new Error("lien iCal introuvable sur la page /schedule");
  return m[0];
}

async function fetchTwitchChannel({ user, label, scheduleUrl }) {
  const icalUrl = await resolveTwitchIcal(scheduleUrl);

  const r = await fetch(icalUrl, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`iCal HTTP ${r.status}`);
  const icsText = await r.text();

  // node-ical : parseICS est dans sync
  const parsed = ical.sync.parseICS(icsText);

  const out = [];
  for (const k of Object.keys(parsed)) {
    const item = parsed[k];
    if (item?.type !== "VEVENT") continue;

    const start = item.start instanceof Date ? item.start.toISOString() : String(item.start);
    const end = item.end instanceof Date ? item.end.toISOString() : (item.end ? String(item.end) : null);

    if (!start || isTooOld(start)) continue;

    const summary = item.summary || "Stream";
    out.push({
      title: `${label} — ${summary}`,
      start,
      end,
      source: `Twitch:${user}`,
      url: scheduleUrl,
      tags: ["twitch", user],
    });
  }
  return out;
}

// ------------------ Foot Mercato (matchs uniquement) ------------------
function parseFMHeadingDate(text) {
  // Exemple: "Samedi 07 février"
  const m = text.trim().match(/^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche)\s+(\d{1,2})\s+([A-Za-zÀ-ÿ]+)/i);
  if (!m) return null;
  const day = Number(m[2]);
  const monthName = m[3].toLowerCase();
  const month = MONTHS_FR[monthName];
  if (!month) return null;
  const year = guessYear(day, month);
  return { year, month, day };
}

function parseMatchAnchorText(text) {
  // Exemple: "Barcelone Majorque 16:15"
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/(.+)\s+(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;

  const title = m[1].trim();
  const hh = String(m[2]).padStart(2, "0");
  const mm = m[3];
  return { title, hh, mm };
}

async function fetchFootMercatoPage({ url, label, tag }) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`FM HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const out = [];

  $("h2").each((_, h2) => {
    const dateInfo = parseFMHeadingDate($(h2).text());
    if (!dateInfo) return;

    const block = $(h2).nextUntil("h2");
    const anchors = block.find("a");

    anchors.each((__, a) => {
      const parsed = parseMatchAnchorText($(a).text());
      if (!parsed) return;

      const start = isoLocal(dateInfo.year, dateInfo.month, dateInfo.day, parsed.hh, parsed.mm);
      if (isTooOld(start)) return;

      out.push({
        title: `⚽ ${parsed.title}`,
        start,
        end: null,
        source: "Foot Mercato (match)",
        url, // on garde la page programme TV comme lien
        tags: ["foot", tag],
      });
    });
  });

  // dédoublonnage interne (même lien peut apparaître plusieurs fois)
  return dedupe(out);
}

async function fetchFootMatches() {
  const out = [];

  // clubs
  for (const club of FOOT_CLUB_PAGES) {
    try {
      const evs = await fetchFootMercatoPage(club);
      out.push(...evs);
    } catch (e) {
      // on remontera l’erreur via status
      throw new Error(`${club.label}: ${e.message}`);
    }
  }

  // LDC (peut être vide selon la période)
  try {
    const ldc = await fetchFootMercatoPage(FOOT_LDC_PAGE);
    // tag "ldc" + "foot"
    for (const ev of ldc) {
      ev.tags = Array.from(new Set([...(ev.tags || []), "ldc"]));
    }
    out.push(...ldc);
  } catch (e) {
    // pas bloquant
  }

  return dedupe(out);
}

// ------------------ Main ------------------
async function main() {
  const errors = [];
  const counts = {};
  const all = [];

  // Twitch
  for (const ch of TWITCH_CHANNELS) {
    try {
      const evs = await fetchTwitchChannel(ch);
      all.push(...evs);
      counts[`Twitch:${ch.user}`] = evs.length;
    } catch (e) {
      counts[`Twitch:${ch.user}`] = 0;
      errors.push(`Twitch:${ch.user}: ${e.message}`);
    }
  }

  // Foot Mercato (matchs)
  try {
    const evs = await fetchFootMatches();
    all.push(...evs);
    counts["Foot Mercato (match)"] = evs.length;
  } catch (e) {
    counts["Foot Mercato (match)"] = 0;
    errors.push(`Foot Mercato: ${e.message}`);
  }

  // tri + filtre final (sécurité)
  const cleaned = dedupe(all)
    .filter(ev => ev?.title && ev?.start)
    .filter(ev => !isTooOld(ev.start))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  await writeJSON(OUT_PATH, cleaned);

  await writeJSON(STATUS_PATH, {
    generatedAt: new Date().toISOString(),
    total: cleaned.length,
    counts,
    errors,
  });

  console.log(`Wrote ${cleaned.length} events -> ${OUT_PATH}`);
  if (errors.length) console.warn("Errors:", errors);
}

main().catch(async (e) => {
  console.error(e);
  await writeJSON(STATUS_PATH, {
    generatedAt: new Date().toISOString(),
    total: 0,
    counts: {},
    errors: [String(e?.message || e)],
  });
  process.exit(1);
});
