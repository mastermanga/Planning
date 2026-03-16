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

  // ---------- URLs fixes ----------
  const LOL_URL = "https://www.twitch.tv/traytonlol";
  const FOOT_URL = "https://www.fctv33.quest/fr";

  // ---------- Helpers ----------
  const lower = (v) => String(v ?? "").toLowerCase();

  const stripTwitchSchedule = (url) => {
    const u = String(url || "").trim();
    if (!u) return "";
    return u.replace(/^(https?:\/\/)?(www\.)?twitch\.tv\/([^\/?#]+)\/schedule\/?$/i, (m, p1, p2, channel) => {
      const proto = p1 || "https://";
      const www = p2 || "";
      return `${proto}${www}twitch.tv/${channel}`;
    });
  };

  const uniqLowerTags = (tags) => {
    if (!Array.isArray(tags)) return [];
    const s = new Set(tags.map(t => lower(t)).filter(Boolean));
    return Array.from(s);
  };

  const deriveTagsFromTitle = (rawTitle, existingTags = []) => {
    const out = new Set(existingTags.map(lower));
    const t = String(rawTitle || "");

    // LoL
    if (/\[\s*lec\s*\]/i.test(t) || /\blec\b/i.test(t)) out.add("lec");
    if (/\[\s*lck\s*\]/i.test(t) || /\blck\b/i.test(t)) out.add("lck");
    if (/\blol\b/i.test(t)) out.add("lol");
    if (/lolix/i.test(t)) out.add("lolix");
    if (/first stand/i.test(t)) out.add("first stand");
    if (/\bmsi\b/i.test(t)) out.add("msi");
    if (/\bworlds\b/i.test(t)) out.add("worlds");
    if (/\bfnatic\b/i.test(t)) out.add("fnatic");
    if (/\bgen\.?\s*g\b/i.test(t) || /\bgeng\b/i.test(t)) out.add("geng");

    // Barca
    if (/barcelone|barcelona/i.test(t)) out.add("barcelona");

    // Twitch
    if (/\bdomingo\b/i.test(t)) { out.add("twitch"); out.add("domingo"); }
    if (/\brivenzi\b/i.test(t)) { out.add("twitch"); out.add("rivenzi"); }
    if (/\bjdg\b/i.test(t) || /joueur du grenier/i.test(t)) {
      out.add("twitch");
      out.add("joueur_du_grenier");
      out.add("jdg");
    }

    // Foot / LDC
    if (/ligue\s*1|primera\s*division|la\s*liga|serie\s*a|premier\s*league|bundesliga|ldc|champions\s*league/i.test(t) || /^⚽/u.test(t)) {
      out.add("foot");
    }
    if (/\bldc\b/i.test(t) || /champions\s*league|ligue\s*des\s*champions/i.test(t)) out.add("ldc");

    // JDR
    if (/\bjdr\b/i.test(t) || /jeu de rôle|jeu de role|dungeons|donjons/i.test(t)) {
      out.add("jdr");
    }

    // Work
    if (/\bwork\b/i.test(t) || /travail|boulot|réunion|reunion|meeting|taf/i.test(t)) {
      out.add("work");
    }

    // F1
    if (/\bf1\b/i.test(t) || /formula\s*1|formule\s*1|grand prix|gp\b/i.test(t)) {
      out.add("f1");
    }

    // Sport générique
    if (/sport|muscu|fitness|run|running|course|vélo|velo|natation|tennis|rugby|basket|nba|footing/i.test(t)) {
      out.add("sport");
    }

    return Array.from(out);
  };

  const isLoLEvent = (tags, rawTitle, source) => {
    const t = lower(rawTitle);
    const s = lower(source);
    return (
      tags.includes("lol") ||
      tags.includes("lolix") ||
      tags.includes("first stand") ||
      tags.includes("msi") ||
      tags.includes("worlds") ||
      tags.includes("lec") ||
      tags.includes("lck") ||
      tags.includes("geng") ||
      tags.includes("fnatic") ||
      /\[\s*(lec|lck)\s*\]/i.test(rawTitle) ||
      /\b(lol|lec|lck|msi|worlds)\b/i.test(t) ||
      /first stand/i.test(rawTitle) ||
      /\bgeng\b/i.test(t) ||
      /\bgen\.?\s*g\b/i.test(t) ||
      /\bfnatic\b/i.test(t) ||
      s.includes("lec") ||
      s.includes("lck") ||
      s.includes("lol") ||
      s.includes("lolix")
    );
  };

  const isFootEvent = (tags, rawTitle, source) => {
    const t = lower(rawTitle);
    const s = lower(source);
    return (
      tags.includes("foot") || tags.includes("ldc") || tags.includes("barcelona") || tags.includes("barcelone") ||
      /ligue\s*1|primera\s*division|la\s*liga|serie\s*a|premier\s*league|bundesliga|champions\s*league|\bldc\b/i.test(t) ||
      /^⚽/u.test(rawTitle) ||
      s.includes("foot")
    );
  };

  const cleanTitleForDisplay = (rawTitle, tags) => {
    let title = String(rawTitle || "");

    title = title.replace(/^⚽\s*/u, "");
    title = title.replace(/^\s*\[[^\]]+\]\s*/u, "");

    const isFoot = tags.includes("foot") || tags.includes("ldc") || tags.includes("barcelona") || tags.includes("barcelone");
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

    title = title.replace(/\s{2,}/g, " ").trim();
    title = title.replace(/^[-–—]\s*/u, "");
    return title || String(rawTitle || "");
  };

  // --- Catégorisation : badge + couleur + important ---
  const CATS = {
    geng:   { key: "geng",   cssVar: "--c-geng",   icon: "🔥", label: "GENG", important: true },
    fnatic: { key: "fnatic", cssVar: "--c-fnatic", icon: "⚡", label: "Fnatic", important: true },
    barca:  { key: "barca",  cssVar: "--c-barca",  icon: "🔵🔴", label: "FC Barcelone", important: true },

    jdr:    { key: "jdr",    cssVar: "--c-jdr",    icon: "🎲", label: "JDR", important: true },
    work:   { key: "work",   cssVar: "--c-work",   icon: "💼", label: "Work", important: false },

    lol:    { key: "lol",    cssVar: "--c-lol",    icon: "🎮", label: "LoL", important: false },

    domingo:{ key: "domingo",cssVar: "--c-domingo",icon: "📺", label: "Domingo", important: false },
    rivenzi:{ key: "rivenzi",cssVar: "--c-rivenzi",icon: "🟦", label: "Rivenzi", important: false },
    jdg:    { key: "jdg",    cssVar: "--c-jdg",    icon: "🕹️", label: "JDG", important: false },

    anime:  { key: "anime",  cssVar: "--c-anime",  icon: "🎬", label: "Anime", important: false },

    foot:   { key: "foot",   cssVar: "--c-foot",   icon: "⚽", label: "Foot / LDC", important: false },
    sport:  { key: "sport",  cssVar: "--c-sport",  icon: "🏅", label: "Sport", important: false },
    f1:     { key: "f1",     cssVar: "--c-f1",     icon: "🏎️", label: "F1", important: false },

    def:    { key: "default",cssVar: "--c-default",icon: "•",  label: "Autre", important: false },
  };

  const getCategory = (ev) => {
    const tags = uniqLowerTags(ev.extendedProps?.tags || []);
    const title = lower(ev.title || "");
    const rawTitle = lower(ev.extendedProps?.rawTitle || "");
    const source = lower(ev.extendedProps?.source || "");
    const text = `${title} ${rawTitle}`.trim();

    if (tags.includes("geng") || /\bgeng\b/.test(text) || /\bgen\.?\s*g\b/.test(text)) return CATS.geng;
    if (tags.includes("fnatic") || /\bfnatic\b/.test(text)) return CATS.fnatic;
    if (tags.includes("barcelona") || tags.includes("barcelone") || /barcelona|barcelone/.test(text)) return CATS.barca;

    if (tags.includes("jdr") || /\bjdr\b/.test(text) || /jeu de rôle|jeu de role|dungeons|donjons/.test(text)) return CATS.jdr;
    if (tags.includes("work") || /\bwork\b/.test(text) || /travail|boulot|réunion|reunion|meeting|taf/.test(text)) return CATS.work;

    if (tags.includes("f1") || /\bf1\b/.test(text) || /formula\s*1|formule\s*1|grand prix|gp\b/.test(text)) return CATS.f1;

    if (
      tags.includes("lol") ||
      tags.includes("lolix") ||
      tags.includes("first stand") ||
      tags.includes("msi") ||
      tags.includes("worlds") ||
      tags.includes("lec") ||
      tags.includes("lck") ||
      /\b(lol|lec|lck|msi|worlds)\b/.test(text) ||
      /first stand/.test(text) ||
      source.includes("lol") ||
      source.includes("lolix") ||
      source.includes("lec") ||
      source.includes("lck")
    ) return CATS.lol;

    if (tags.includes("domingo") || /domingo/.test(text)) return CATS.domingo;
    if (tags.includes("rivenzi") || /rivenzi/.test(text)) return CATS.rivenzi;
    if (tags.includes("jdg") || tags.includes("joueur_du_grenier") || /joueur du grenier|\bjdg\b/.test(text)) return CATS.jdg;

    if (tags.includes("anime") || source.includes("anime-sama")) return CATS.anime;

    if (tags.includes("foot") || tags.includes("ldc") || /^⚽/u.test(ev.extendedProps?.rawTitle || "")) return CATS.foot;

    if (
      tags.includes("sport") ||
      /sport|muscu|fitness|run|running|course|vélo|velo|natation|tennis|rugby|basket|nba|footing/.test(text)
    ) return CATS.sport;

    return CATS.def;
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

        let url = e.url ? String(e.url) : "";
        url = stripTwitchSchedule(url);

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
          googleSheetUrl: e.googleSheetUrl ? String(e.googleSheetUrl) : "",
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
      const cat = getCategory(info.event);
      info.el.style.setProperty("--event-color", `var(${cat.cssVar})`);
      info.el.classList.toggle("is-important", !!cat.important);
    },

    eventContent: (arg) => {
      const viewType = arg.view.type;
      const cat = getCategory(arg.event);

      const container = document.createElement("div");
      container.className = (viewType.includes("list") || viewType.includes("dayGrid"))
        ? "event-item"
        : "event-block";

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = cat.icon;
      badge.title = cat.label;

      const text = document.createElement("span");
      text.className = "txt";
      text.textContent = arg.event.title;

      container.appendChild(badge);
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
          const hay = `${e.title} ${e.rawTitle} ${e.source} ${(e.tags || []).join(" ")}`.toLowerCase();
          return hay.includes(term);
        })
      : allEvents;

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
          url: e.url || "",
          googleSheetUrl: e.googleSheetUrl || "",
          rawTitle: e.rawTitle || ""
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

  refreshBtn?.addEventListener("click", async () => {
    await loadEvents();
  });

  searchEl?.addEventListener("input", debounce((e) => {
    searchTerm = e.target.value || "";
    applyFilters();
  }, 200));

  // ---------- Notifications ----------
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

  setInterval(async () => {
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
