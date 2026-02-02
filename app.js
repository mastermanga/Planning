const GENERATED_JSON_URL = "./data/generated.json";
const STATUS_JSON_URL = "./data/status.json";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT36bHnWhI-sdvq6NOmAyYU1BQZJT4WAsIYozR7fnARi_xBgU0keZw0mTF-N3s3x7V5tcaAofqO78Aq/pub?output=csv";

const REPEAT_WEEKS_AHEAD = 52; // occurrences générées pour repeat=oui

let allEvents = [];
let calendar = null;
let timeouts = [];
let searchQuery = "";

const norm = s => (s || "").toString().trim().toLowerCase();

// Convertit "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS"
function normalizeDate(s) {
  const v = (s || "").trim();
  if (!v) return "";
  if (v.includes("T")) return v;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(v)) return v.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(v)) return v.replace(" ", "T") + ":00";
  return v;
}

function isOui(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "oui" || s === "yes" || s === "true" || s === "1";
}

function addWeeks(isoStr, weeks) {
  const d = new Date(isoStr);
  if (!Number.isFinite(d.getTime())) return null;
  d.setDate(d.getDate() + 7 * weeks);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function matchesSearch(evt, q) {
  if (!q) return true;
  const hay = [
    evt.title,
    evt.extendedProps?.source,
    (evt.extendedProps?.tags || []).join(" "),
    evt.extendedProps?.url
  ].map(norm).join(" ");
  return hay.includes(q);
}

function clearNotifs() {
  timeouts.forEach(clearTimeout);
  timeouts = [];
}

function scheduleNotifs(events) {
  clearNotifs();
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const now = Date.now();
  const horizonMs = 24 * 60 * 60 * 1000;

  for (const e of events) {
    const startMs = new Date(e.start).getTime();
    const inMs = startMs - now;
    if (inMs > 0 && inMs <= horizonMs) {
      timeouts.push(setTimeout(() => {
        new Notification(`Ça commence : ${e.title}`, {
          body: `${new Date(e.start).toLocaleString()} • ${e.extendedProps?.source || ""}`,
        });
      }, inMs));
    }
  }
}

async function loadGenerated() {
  try {
    const r = await fetch(GENERATED_JSON_URL, { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function loadStatus() {
  try {
    const r = await fetch(STATUS_JSON_URL, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function renderStatus(status) {
  const el = document.getElementById("status");
  if (!el) return;
  if (!status) { el.textContent = ""; return; }

  const counts = status.counts || {};
  const parts = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
  el.textContent = `Sources (${status.total}) — ${parts.join(" • ")}`;
}

async function loadSheet() {
  const r = await fetch(SHEET_CSV_URL, { cache: "no-store" });
  if (!r.ok) return [];
  const csv = await r.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

  const rows = parsed.data || [];

  const pick = (row, ...keys) => {
    for (const k of keys) {
      if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
    }
    return "";
  };

  const out = [];

  for (const row of rows) {
    const title = pick(row, "title", "Title");
    const startRaw = pick(row, "start", "Start");
    const endRaw = pick(row, "end", "End");
    const tagsRaw = pick(row, "tags", "Tags");
    const source = pick(row, "source", "Source") || "Google Sheet";
    const url = pick(row, "url", "URL", "Url");
    const repeatRaw = pick(row, "repeat", "Repeat");

    const start = normalizeDate(startRaw);
    const end = normalizeDate(endRaw);

    if (!title || !start) continue;

    const baseEvent = {
      title,
      start,
      end: end || undefined, // si vide -> pas de durée (OK)
      url: url || undefined, // si vide -> pas cliquable (géré plus bas)
      extendedProps: {
        source,
        tags: tagsRaw.split(",").map(s => s.trim()).filter(Boolean),
        url: url || undefined,
        repeat: isOui(repeatRaw)
      }
    };

    out.push(baseEvent);

    // Repeat hebdo : on génère des occurrences futures
    if (isOui(repeatRaw)) {
      for (let w = 1; w <= REPEAT_WEEKS_AHEAD; w++) {
        const nextStart = addWeeks(start, w);
        if (!nextStart) continue;
        const nextEnd = end ? addWeeks(end, w) : null;

        out.push({
          ...baseEvent,
          start: nextStart,
          end: nextEnd || undefined
        });
      }
    }
  }

  return out;
}

function filteredEvents() {
  const q = norm(searchQuery);
  return allEvents.filter(e => matchesSearch(e, q));
}

function renderCalendar() {
  const el = document.getElementById("calendar");
  const events = filteredEvents();

  if (!calendar) {
    calendar = new FullCalendar.Calendar(el, {
      initialView: "dayGridMonth",
      height: "auto",
      nowIndicator: true,

      headerToolbar: {
        left: "prev,next today",
        center: "title",
        right: "dayGridMonth,timeGridWeek,timeGridDay,listYear"
      },
      views: { listYear: { buttonText: "Total" } },

      // ✅ 24h (plus de "4p")
      eventTimeFormat: {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      },

      // ✅ pas cliquable si pas d'URL
      eventDidMount: (info) => {
        const url = info.event.url;
        if (!url) {
          info.el.style.cursor = "default";
          const a = info.el.querySelector("a");
          if (a) {
            a.removeAttribute("href");
            a.style.pointerEvents = "none";
            a.style.cursor = "default";
            a.style.textDecoration = "none";
          }
        } else {
          info.el.style.cursor = "pointer";
        }
      },

      eventClick: (info) => {
        const url = info.event.url;
        if (!url) {
          info.jsEvent.preventDefault();
          return;
        }
        info.jsEvent.preventDefault();
        window.open(url, "_blank", "noopener,noreferrer");
      },
    });

    calendar.render();
  }

  calendar.removeAllEvents();
  calendar.addEventSource(events);
}

async function refreshData() {
  const [generated, sheet, status] = await Promise.all([
    loadGenerated(),
    loadSheet(),
    loadStatus()
  ]);

  allEvents = [...generated, ...sheet].map(e => ({
    title: e.title,
    start: e.start,
    end: e.end || undefined,
    url: e.url || e.extendedProps?.url || undefined,
    extendedProps: {
      source: e.source || e.extendedProps?.source || "Source",
      tags: e.tags || e.extendedProps?.tags || [],
      url: e.url || e.extendedProps?.url || undefined
    }
  }));

  renderStatus(status);
  renderCalendar();
  scheduleNotifs(filteredEvents());
}

document.getElementById("search").addEventListener("input", e => {
  searchQuery = e.target.value || "";
  renderCalendar();
});

document.getElementById("refresh").addEventListener("click", refreshData);

document.getElementById("notif").addEventListener("click", async () => {
  if (!("Notification" in window)) return alert("Notifications non supportées.");
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    scheduleNotifs(filteredEvents());
    alert("OK — notifications activées (tant que la page est ouverte).");
  }
});

refreshData();
