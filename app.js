const GENERATED_JSON_URL = "./data/generated.json";
const STATUS_JSON_URL = "./data/status.json";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT36bHnWhI-sdvq6NOmAyYU1BQZJT4WAsIYozR7fnARi_xBgU0keZw0mTF-N3s3x7V5tcaAofqO78Aq/pub?output=csv";

let allEvents = [];
let calendar = null;
let timeouts = [];
let searchQuery = "";

const norm = s => (s || "").toString().trim().toLowerCase();

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

function clearNotifs() { timeouts.forEach(clearTimeout); timeouts = []; }

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
  } catch { return []; }
}

async function loadStatus() {
  try {
    const r = await fetch(STATUS_JSON_URL, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
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

  return (parsed.data || [])
    .filter(row => row.title && row.start)
    .map(row => ({
      title: row.title,
      start: row.start,
      end: row.end || undefined,
      url: row.url || undefined,
      extendedProps: {
        source: row.source || "Google Sheet",
        tags: (row.tags || "").split(",").map(s => s.trim()).filter(Boolean),
        url: row.url || undefined
      }
    }));
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
      eventClick: (info) => {
        const url = info.event.url;
        if (url) {
          info.jsEvent.preventDefault();
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    });
    calendar.render();
  }

  calendar.removeAllEvents();
  calendar.addEventSource(events);
}

async function refreshData() {
  const [generated, sheet, status] = await Promise.all([loadGenerated(), loadSheet(), loadStatus()]);

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
