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

  // ---------- Const URLs ----------
  const LOL_URL = "https://www.twitch.tv/traytonlol";
  const FOOT_URL = "https://www.fctv33.quest/fr";

  // ---------- Helpers ----------
  const lower = (v) => String(v ?? "").toLowerCase();

  const stripSchedule = (url) => {
    const u = String(url || "").trim();
    if (!u) return "";
    return u.replace(/\/schedule\/?$/i, "");
  };

  const uniqLowerTags = (tags) => {
    if (!Array.isArray(tags)) return [];
    const s = new Set(tags.map(t => lower(t)).filter(Boolean));
    return Array.from(s);
  };

  const deriveTagsFromTitle = (rawTitle, existingTags = []) => {
    const t = lower(rawTitle);
    const out = new Set(existingTags.map(lower));

    // LoL (depuis préfixes courants)
    if (/\[\s*lec\s*\]/i.test(rawTitle) || /\blec\b/i.test(rawTitle)) out.add("lec");
    if (/\[\s*lck\s*\]/i.test(rawTitle) || /\blck\b/i.test(rawTitle)) out.add("lck");

    if (/\bfnatic\b/i.test(rawTitle)) out.add("fnatic");
    if (/\bgen\.?\s*g\b/i.test(rawTitle) || /\bgeng\b/i.test(rawTitle)) out.add("geng");

    // Twitch (si on repère un streamer)
    if (/\bdomingo\b/i.test(rawTitle) || /\brivenzi\b/i.test(rawTitle) || /\bjdg\b/i.test(rawTitle) || /joueur du grenier/i.test(rawTitle)) {
      out.add("twitch");
      if (/\bdomingo\b/i.test(rawTitle)) out.add("domingo");
      if (/\brivenzi\b/i.test(rawTitle)) out.add("rivenzi");
      if (/\bjdg\b/i.test(rawTitle) || /joueur du grenier/i.test(rawTitle)) out.add("joueur_du_grenier");
    }

    // Foot (si on voit des ligues ou équipes très typées)
    if (/ligue\s*1/i.test(rawTitle) || /primera\s*division/i.test(rawTitle) || /saint-germain|marseille|monaco|nice|barcelona|real madrid/i.test(rawTitle) || /^⚽/u.test(rawTitle)) {
      out.add("foot");
    }
    if (/barcelone|barcelona/i.test(rawTitle)) out.add("barcelona");

    return Array.from(out);
  };

  const isLoLEvent = (tags, rawTitle, source) => {
    const t = lower(rawTitle);
    const s = lower(source);
    const has = (x) => tags.includes(x);

    return (
      has("lec") || has("lck") || has("geng") || has("fnatic") ||
      /\[\s*(lec|lck)\s*\]/i.test(rawTitle) ||
      /\b(lec|lck)\b/i.test(rawTitle) ||
      /\bgen\.?\s*g\b/i.test(rawTitle) ||
      s.includes("lec") || s.includes("lck")
    );
  };

  const isFootEvent = (tags, rawTitle, source) => {
    const t = lower(rawTitle);
    const s = lower(source);
    const has = (x) => tags.includes(x);

    return (
      has("foot") || has("barcelone") || has("barcelona") || has("ldc") ||
      /ligue\s*1|primera\s*division|champions\s*league|ldc/i.test(t) ||
      /^⚽/u.test(rawTitle) ||
      s.includes("foot")
    );
  };

  const cleanTitleForDisplay = (rawTitle, tags) => {
    let title = String(rawTitle || "");

    // Enlever emoji foot au début (si présent)
    title = title.replace(/^⚽\s*/u, "");

    // Enlever le premier "[...]" au début (ex: [LEC], [LCK], [Ligue 1], [Primera Division])
    title = title.replace(/^\s*\[[^\]]+\]\s*/u, "");

    // Si foot: enlever noms de ligue (même sans crochets)
    const isFoot = tags.includes("foot") || tags.includes("barcelona") || tags.includes("barcelone") || tags.includes("ldc");
    if (isFoot) {
      title = title
        .replace(/\bLigue\s*1\b/gi, "")
        .replace(/\bPrimera\s*Division\b/gi, "")
        .replace(/\bLa\s*Liga\b/gi, "")
        .replace(/\bSerie\s*A\b/gi, "")
        .replace(/\bPremier\s*League\b/gi, "")
        .replace(/\bBundesliga\b/gi, "")
        .replace(/\bLigue\s*des\s*Champions\b/gi, "")
        .replace(/\bChampions\s*League\b/gi, "");
    }

    // Nettoyage espaces
    title = title.replace(/\s{2,}/g, " ").trim();
    title = title.replace(/^[-–—]\s*/u, ""); // si un dash reste en tête

    return title || String(rawTitle || "");
  };

  const colorVarFromEvent = (ev) => {
    const tags = uniqLowerTags(ev.extendedProps?.tags || []);
    const title = lower(ev.title);
    const rawTitle = lower(ev.extendedProps?.rawTitle || "");
    const source = lower(ev.extendedProps?.source || "");
    const text = `${title} ${rawTitle}`.trim();

    // Anime
    if (tags.includes("anime") || source.includes("anime-sama")) return "--c-anime";

    // Twitch
    const looksLikeTwitch =
      tags.includes("twitch") ||
      source.includes("twitch") ||
      /domingo|rivenzi|joueur du grenier|\bjdg\b/i.test(text);

    if (looksLikeTwitch) {
      if (tags.includes("domingo") || text.includes("domingo")) return "--c-tw-domingo";
      if (tags.includes("rivenzi") || text.includes("rivenzi")) return "--c-tw-rivenzi";
      if (tags.includes("joueur_du_grenier") || text.includes("joueur du grenier") || text.includes("jdg")) return "--c-tw-jdg";
      return "--c-tw-domingo";
    }

    // LoL
    if (tags.includes("lec") || /\b(lec)\b/i.test(text)) return "--c-lec";
    if (tags.includes("lck") || /\b(lck)\b/i.test(text)) return "--c-lck";
    if (tags.includes("geng") || /\bgen\.?\s*g\b/i.test(text) || /\bgeng\b/i.test(text)) return "--c-geng";
    if (tags.includes("fnatic") || /\bfnatic\b/i.test(text)) return "--c-fnatic";

    // Foot
    if (tags.includes("barcelone") || tags.includes("barcelona") || text.includes("barcelona") || text.includes("barcelone")) return "--c-barca";
    if (tags.includes("ldc")) return "--c-default";

    return "--c-default";
  };

  const normalizeEvents = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(e => e && e.title && e.start)
      .map(e => {
        const rawTitle = String(e.title || "");
        const baseTags = Array.isArray(e.tags) ? e.tags.map(String) : [];
        const tags = uniqLowerTags(deriveTagsFromTitle(rawTitle, baseTags));

        const source = e.source ? String(e.source) : "";

        // URL: garder la source, mais retirer /schedule pour streamers
        let url = stripSchedule(e.url ? String(e.url) : "");

        // Overrides demandés
        if (isLoLEvent(tags, rawTitle, source)) url = LOL_URL;
        if (isFootEvent(tags, rawTitle, source)) url = FOOT_URL;

        const title = cleanTitleForDisplay(rawTitle, tags);

        return {
          rawTitle,
          title,
          start: e.start,
          end: e.end || null,
          source,
          url,
          tags
        };
      });
  };

  const makeId = (e) => `${e.source}|${e.start}|${e.rawTitle}`.toLowerCase();

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
      const url = info.event.extendedProps?.url || "";
      if (url) {
        info.jsEvent.preventDefault();
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },

    eventDidMount: (info) => {
      const v = colorVarFromEvent(info.event);
      // On pose une couleur exploitable par le CSS
      info.el.style.setProperty("--event-color", `var(${v})`);
    },

    eventContent: (arg) => {
      // Rendu custom: week/day et month/list
      const viewType = arg.view.type;

      const container = document.createElement("div");
      const dot = document.createElement("span");
      const text = document.createElement("span");

      dot.className = "dot";
      text.className = "txt";
      text.textContent = arg.event.title;

      if (viewType.includes("list") || viewType.includes("dayGrid")) {
        container.className = "event-item";
        container.appendChild(dot);
        container.appendChild(text);
        return { domNodes: [container] };
      }

      container.className = "event-block";
      container.appendChild(dot);
      container.appendChild(text);
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
    const term = (searchTerm || "").trim().toLowerCase();

    const filtered = term
      ? allEvents.filter(e => {
          // recherche: titre nettoyé + titre brut + source + tags
          const hay = `${e.title} ${e.rawTitle} ${e.source} ${(e.tags || []).join(" ")}`.toLowerCase();
          return hay.includes(term);
        })
      : allEvents;

    calendar.removeAllEvents();

    filtered.forEach(e => {
      calendar.addEvent({
        id: makeId(e),
        title: e.title,         // ✅ affichage nettoyé
        start: e.start,
        end: e.end || null,
        extendedProps: {
          source: e.source || "",
          tags: e.tags || [],
          url: e.url || "",
          rawTitle: e.rawTitle || "" // ✅ conserve l’info d’origine (utile pour couleur/détection)
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
