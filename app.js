// app.js (FRONT - navigateur)
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const calendarEl = $("#calendar");
  const statusEl = $("#status");
  const currentTitleEl = $("#currentTitle");

  const searchEl = $("#search");
  const prevBtn = $("#prevBtn");
  const nextBtn = $("#nextBtn");
  const todayBtn = $("#todayBtn");
  const refreshBtn = $("#refresh");
  const notifBtn = $("#notif");
  const missedListEl = $("#missedList");

  if (!calendarEl) {
    console.error("❌ #calendar introuvable dans le DOM.");
    return;
  }
  if (!window.FullCalendar) {
    console.error("❌ FullCalendar introuvable.");
    return;
  }

  const MISSED_API_URL =
    "https://script.google.com/macros/s/AKfycbyc3qhOWQ7u6wSer9pXlUxldIykkmls32tsgFV7gd45yIapraoVEPUHLPRhXozM7OGeMw/exec";

  const LOL_URL = "https://www.twitch.tv/traytonlol";
  const FOOT_URL = "https://www.fctv33.quest/fr";

  const lower = (v) => String(v ?? "").toLowerCase();

  const uniqLowerTags = (tags) => {
    if (!Array.isArray(tags)) return [];
    return Array.from(new Set(tags.map(t => lower(t)).filter(Boolean)));
  };

  const stripTwitchSchedule = (url) => {
    const u = String(url || "").trim();
    if (!u) return "";
    return u.replace(/^(https?:\/\/)?(www\.)?twitch\.tv\/([^\/?#]+)\/schedule\/?$/i,
      (m, p1, p2, channel) => {
        const proto = p1 || "https://";
        const www = p2 || "";
        return `${proto}${www}twitch.tv/${channel}`;
      }
    );
  };

  const normalizeEvents = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(e => ({
      rawTitle: e.title,
      title: e.title,
      start: e.start,
      end: e.end || null,
      source: e.source || "",
      url: stripTwitchSchedule(e.url || ""),
      tags: uniqLowerTags(e.tags || [])
    }));
  };

  const makeId = (e) =>
    `${e.source}|${e.start}|${e.rawTitle}`.toLowerCase();

  const makeMissedKeyFromCalendarEvent = (ev) => {
    const source = ev.extendedProps?.source || "";
    const rawTitle = ev.extendedProps?.rawTitle || ev.title || "";
    const start = ev.start?.toISOString?.() || "";
    return `${source}|${rawTitle}|${start}`.toLowerCase();
  };

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  const updateTitle = () => {
    if (currentTitleEl) currentTitleEl.textContent = calendar.view?.title || "";
  };

  const debounce = (fn, ms = 200) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  async function fetchMissedAnime() {
    const r = await fetch(`${MISSED_API_URL}?ts=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("Erreur API missed");

    const data = await r.json();
    if (!Array.isArray(data)) return [];

    return data.sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  async function deleteMissedAnime(key) {
    await fetch(MISSED_API_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "delete",
        key
      })
    });
  }

  async function addMissedAnimeFromCalendarEvent(ev) {
    const tags = uniqLowerTags(ev.extendedProps?.tags || []);
    if (!tags.includes("anime")) return;

    const key = makeMissedKeyFromCalendarEvent(ev);

    await fetch(MISSED_API_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "add",
        key,
        anime: ev.title,
        start: ev.start.toISOString(),
        url: ev.extendedProps?.url || ""
      })
    });
  }

  async function renderMissedAnime() {
    if (!missedListEl) return;

    missedListEl.innerHTML = "";

    try {
      const missed = await fetchMissedAnime();

      if (!missed.length) {
        const empty = document.createElement("div");
        empty.className = "missedEmpty";
        empty.textContent = "Rien à rattraper";
        missedListEl.appendChild(empty);
        return;
      }

      missed.forEach(itemData => {
        const item = document.createElement("button");
        item.className = "missedItem";

        const name = document.createElement("span");
        name.className = "missedItemTitle";
        name.textContent = itemData.anime;

        const meta = document.createElement("span");
        meta.className = "missedItemMeta";
        meta.textContent = new Date(itemData.start).toLocaleString("fr-FR");

        item.appendChild(name);
        item.appendChild(meta);

        item.addEventListener("click", async () => {
          if (itemData.url) {
            window.open(itemData.url, "_blank");
          }

          await deleteMissedAnime(itemData.key);
          await renderMissedAnime();
        });

        missedListEl.appendChild(item);
      });

    } catch (e) {
      console.error(e);
    }
  }

  let allEvents = [];
  let searchTerm = "";
  let notificationsEnabled = false;
  const notified = new Set();

  const calendar = new FullCalendar.Calendar(calendarEl, {
    locale: "fr",
    firstDay: 1,
    initialView: "timeGridWeek",
    height: "100%",
    nowIndicator: true,
    headerToolbar: false,

    eventClick: (info) => {
      const url = info.event.extendedProps?.url;
      if (url) {
        info.jsEvent.preventDefault();
        window.open(url, "_blank");
      }
    }
  });

  calendar.render();
  updateTitle();

  async function loadStatusJSON() {
    try {
      const r = await fetch(`./data/status.json?ts=${Date.now()}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function loadEvents() {
    setStatus("Chargement…");

    try {
      const r = await fetch(`./data/generated.json?ts=${Date.now()}`);
      const data = await r.json();

      allEvents = normalizeEvents(data);

      const st = await loadStatusJSON();
      if (st?.errors?.length) {
        setStatus(`⚠️ ${st.errors.length} erreurs`);
      } else {
        setStatus(`${allEvents.length} événements`);
      }

      applyFilters();
      await renderMissedAnime();

    } catch (e) {
      console.error(e);
      setStatus("Erreur chargement planning");
    }
  }

  function applyFilters() {
    const term = (searchTerm || "").toLowerCase();

    const filtered = term
      ? allEvents.filter(e =>
          `${e.title} ${e.source} ${(e.tags || []).join(" ")}`
            .toLowerCase()
            .includes(term)
        )
      : allEvents;

    calendar.removeAllEvents();

    filtered.forEach(e => {
      calendar.addEvent({
        id: makeId(e),
        title: e.title,
        start: e.start,
        end: e.end,
        extendedProps: {
          source: e.source,
          tags: e.tags,
          url: e.url,
          rawTitle: e.rawTitle
        }
      });
    });

    updateTitle();
  }

  prevBtn?.addEventListener("click", () => {
    calendar.prev();
    updateTitle();
  });

  nextBtn?.addEventListener("click", () => {
    calendar.next();
    updateTitle();
  });

  todayBtn?.addEventListener("click", () => {
    calendar.today();
    updateTitle();
  });

  refreshBtn?.addEventListener("click", async () => {
    await loadEvents();
    await renderMissedAnime();
  });

  searchEl?.addEventListener("input", debounce((e) => {
    searchTerm = e.target.value;
    applyFilters();
  }));

  async function toggleNotifications() {
    if (!("Notification" in window)) return;

    if (Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") return;
    }

    notificationsEnabled = !notificationsEnabled;
    setStatus(
      notificationsEnabled
        ? "Notifications activées"
        : "Notifications désactivées"
    );
  }

  notifBtn?.addEventListener("click", toggleNotifications);

  setInterval(async () => {
    if (!notificationsEnabled) return;

    const now = Date.now();
    const events = calendar.getEvents();

    for (const ev of events) {
      const start = ev.start?.getTime?.();
      if (!start) continue;

      if (now >= start && now < start + 60000) {
        if (notified.has(ev.id)) continue;
        notified.add(ev.id);

        new Notification(`📅 ${ev.title}`);

        try {
          await addMissedAnimeFromCalendarEvent(ev);
          await renderMissedAnime();
        } catch (e) {
          console.error(e);
        }
      }
    }
  }, 30000);

  loadEvents();
})();
