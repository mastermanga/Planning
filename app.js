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

  if (!calendarEl) {
    console.error("❌ #calendar introuvable dans le DOM.");
    return;
  }
  if (!window.FullCalendar) {
    console.error("❌ FullCalendar introuvable. Vérifie le script CDN.");
    return;
  }

  // ---------- Helpers ----------
  const colorVarFromEvent = (ev) => {
    const tags = (ev.extendedProps?.tags || []).map(String).map(t => t.toLowerCase());
    const title = String(ev.title || "").toLowerCase();
    const source = String(ev.extendedProps?.source || "").toLowerCase();

    // Anime
    if (tags.includes("anime") || source.includes("anime-sama")) return "--c-anime";

    // Twitch
    if (tags.includes("twitch") || source.includes("twitch")) {
      if (tags.includes("domingo") || title.includes("domingo")) return "--c-tw-domingo";
      if (tags.includes("rivenzi") || title.includes("rivenzi")) return "--c-tw-rivenzi";
      if (tags.includes("joueur_du_grenier") || title.includes("joueur du grenier") || title.includes("jdg")) return "--c-tw-jdg";
      return "--c-tw-domingo";
    }

    // LoL
    if (tags.includes("lec")) return "--c-lec";
    if (tags.includes("lck")) return "--c-lck";
    if (tags.includes("geng")) return "--c-geng";
    if (tags.includes("fnatic")) return "--c-fnatic";

    // Foot
    if (tags.includes("barcelone") || tags.includes("barcelona")) return "--c-barca";
    if (tags.includes("ldc")) return "--c-default";

    return "--c-default";
  };

  const normalizeEvents = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(e => e && e.title && e.start)
      .map(e => ({
        title: String(e.title),
        start: e.start,
        end: e.end || null,
        source: e.source ? String(e.source) : "",
        url: e.url ? String(e.url) : "",
        tags: Array.isArray(e.tags) ? e.tags.map(String) : []
      }));
  };

  const makeId = (e) => `${e.source}|${e.start}|${e.title}`.toLowerCase();

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  const updateTitle = () => {
    if (currentTitleEl) currentTitleEl.textContent = calendar.view?.title || "";
  };

  const setActiveViewButton = (viewName) => {
    $$(".btn.pill[data-view]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });
  };

  const debounce = (fn, ms = 200) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  // ---------- State ----------
  let allEvents = [];
  let searchTerm = "";
  let notificationsEnabled = false;
  const notified = new Set();

  // ---------- Calendar init ----------
  const calendar = new FullCalendar.Calendar(calendarEl, {
    locale: "fr",
    firstDay: 1,
    initialView: "timeGridWeek",
    height: "100%",
    expandRows: true,
    nowIndicator: true,
    headerToolbar: false,

    eventClick: (info) => {
      const url = info.event.extendedProps?.url;
      if (url) {
        info.jsEvent.preventDefault();
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },

    eventDidMount: (info) => {
      const v = colorVarFromEvent(info.event);
      info.el.style.setProperty("--event-color", `var(${v})`);
    },

    eventContent: (arg) => {
      // Petit rendu custom pour coller à ton CSS (.event-item / .event-block)
      const viewType = arg.view.type;
      const container = document.createElement("div");

      // listYear / month : style "event-item"
      if (viewType.includes("list") || viewType.includes("dayGrid")) {
        container.className = "event-item";
        container.style.setProperty("--event-color", arg.el?.style.getPropertyValue("--event-color") || "var(--c-default)");

        const dot = document.createElement("span");
        dot.className = "dot";

        const text = document.createElement("span");
        text.textContent = arg.event.title;

        container.appendChild(dot);
        container.appendChild(text);
        return { domNodes: [container] };
      }

      // week/day : style "event-block"
      container.className = "event-block";
      container.style.setProperty("--event-color", arg.el?.style.getPropertyValue("--event-color") || "var(--c-default)");
      container.textContent = arg.event.title;
      return { domNodes: [container] };
    }
  });

  calendar.render();
  updateTitle();
  setActiveViewButton(calendar.view.type);

  // ---------- Data loading ----------
  async function loadStatusJSON() {
    try {
      const r = await fetch(`./data/status.json?ts=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function loadEvents() {
    setStatus("Chargement des événements…");

    // Le calendrier s'affiche même si le fetch échoue.
    try {
      const r = await fetch(`./data/generated.json?ts=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);

      const data = await r.json();
      allEvents = normalizeEvents(data);

      const st = await loadStatusJSON();
      if (st?.errors?.length) {
        setStatus(`${allEvents.length} événements — ⚠️ erreurs: ${st.errors.length} (voir data/status.json)`);
      } else {
        setStatus(`${allEvents.length} événements`);
      }

      applyFilters();
    } catch (e) {
      console.error(e);
      allEvents = [];
      applyFilters();

      setStatus(
        "Erreur de chargement de data/generated.json. " +
        "⚠️ Si tu ouvres le fichier en 'file://', fetch est souvent bloqué : lance un serveur local."
      );
    }
  }

  function applyFilters() {
    const term = searchTerm.trim().toLowerCase();

    const filtered = term
      ? allEvents.filter(e => {
          const hay = `${e.title} ${e.source} ${(e.tags || []).join(" ")}`.toLowerCase();
          return hay.includes(term);
        })
      : allEvents;

    // Recharge les events dans FullCalendar
    calendar.removeAllEvents();
    filtered.forEach(e => {
      calendar.addEvent({
        id: makeId(e),
        title: e.title,
        start: e.start,
        end: e.end || null,
        extendedProps: {
          source: e.source || "",
          tags: e.tags || [],
          url: e.url || ""
        }
      });
    });

    updateTitle();
  }

  // ---------- Controls ----------
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

  $$(".btn.pill[data-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      if (!view) return;
      calendar.changeView(view);
      setActiveViewButton(view);
      updateTitle();
    });
  });

  refreshBtn?.addEventListener("click", () => {
    loadEvents();
  });

  searchEl?.addEventListener("input", debounce((e) => {
    searchTerm = e.target.value || "";
    applyFilters();
  }, 200));

  // ---------- Notifications (optionnel) ----------
  async function toggleNotifications() {
    if (!("Notification" in window)) {
      alert("Les notifications ne sont pas supportées sur ce navigateur.");
      return;
    }
    if (Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") {
        notificationsEnabled = false;
        setStatus("Notifications refusées.");
        return;
      }
    }
    notificationsEnabled = !notificationsEnabled;
    setStatus(notificationsEnabled ? "Notifications activées ✅" : "Notifications désactivées ❌");
  }

  notifBtn?.addEventListener("click", toggleNotifications);

  // Check toutes les 30s : notif au début (une seule fois)
  setInterval(() => {
    if (!notificationsEnabled) return;

    const now = Date.now();
    const events = calendar.getEvents();

    for (const ev of events) {
      const start = ev.start?.getTime?.();
      if (!start) continue;

      // Début d'événement (fenêtre 60s)
      if (now >= start && now < start + 60_000) {
        if (notified.has(ev.id)) continue;
        notified.add(ev.id);

        const src = ev.extendedProps?.source ? ` (${ev.extendedProps.source})` : "";
        new Notification(`📅 ${ev.title}${src}`);
      }
    }
  }, 30_000);

  // ---------- Go ----------
  loadEvents();
})();
