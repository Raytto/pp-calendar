"use strict";

(function initializeTheme() {
  const storageKey = "pp-calendar-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const validModes = new Set(["system", "light", "dark"]);

  function getMode() {
    try {
      const saved = localStorage.getItem(storageKey) || "system";
      return validModes.has(saved) ? saved : "system";
    } catch (_error) {
      return "system";
    }
  }

  function resolvedMode(mode = getMode()) {
    return mode === "system" ? (media.matches ? "dark" : "light") : mode;
  }

  function apply(mode = getMode(), persist = false) {
    const normalized = validModes.has(mode) ? mode : "system";
    if (persist) {
      try { localStorage.setItem(storageKey, normalized); } catch (_error) { /* storage can be unavailable */ }
    }
    const resolved = resolvedMode(normalized);
    document.documentElement.dataset.themeMode = normalized;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = resolved === "dark" ? "#18191d" : "#0f1120";
    window.dispatchEvent(new CustomEvent("ppcalendar-themechange", { detail: { mode: normalized, resolved } }));
  }

  media.addEventListener("change", () => {
    if (getMode() === "system") apply("system");
  });

  window.PPCalendarTheme = { getMode, resolvedMode, setMode: (mode) => apply(mode, true), apply };
  apply();
})();
