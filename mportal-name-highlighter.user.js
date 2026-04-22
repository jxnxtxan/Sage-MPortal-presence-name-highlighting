// ==UserScript==
// @name         mPortal Name Highlighter
// @namespace    local.tampermonkey.mportal
// @version      2.0.1
// @description  Auto-detect names in presence tiles, select via dropdown, and assign highlight colors.
// @author       jxnxtxan
// @downloadURL  https://raw.githubusercontent.com/jxnxtxan/Sage-MPortal-presence-name-highlighting/main/mportal-name-highlighter.user.js
// @updateURL    https://raw.githubusercontent.com/jxnxtxan/Sage-MPortal-presence-name-highlighting/main/mportal-name-highlighter.user.js
// @match        *://*/HRPortal/*/Time/Presence
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_PREFIX = "mportalNameHighlighterV2";
  const LEGACY_NAMES_KEY = "mportalHighlightedNames";
  const LEGACY_COLOR_KEY = "mportalHighlightColor";
  const DEFAULT_HIGHLIGHT_COLOR = "#ffb020";
  const DEFAULT_COLLECTION_MODE = "all_loaded";
  const DEFAULT_PRESENCE_ACCENT_MODE = "all";

  const PANEL_ID = "tm-name-highlight-panel";
  const TOGGLE_ID = "tm-name-highlight-toggle";
  const STYLE_ID = "tm-name-highlight-style";
  const TILE_SELECTOR = ".sagehr-tile";
  const HEADER_SELECTOR = ".sagehr-dataheader";
  const NAME_CONTAINER_SELECTOR = ".sagehr-tile-small-info > .text-overflow-ellipsis";
  const FAVORITES_SECTION_CLASS = "tm-favorites-tiles-section";
  const FAVORITES_SECTION_CARDS_CLASS = "tm-favorites-tiles-cards";

  const KEYS = {
    discovered: `${STORAGE_PREFIX}:discoveredNames`,
    selected: `${STORAGE_PREFIX}:selectedNames`,
    favorites: `${STORAGE_PREFIX}:favoriteNames`,
    colors: `${STORAGE_PREFIX}:perNameColors`,
    defaultColor: `${STORAGE_PREFIX}:defaultColor`,
    mode: `${STORAGE_PREFIX}:collectionMode`,
    presenceAccentMode: `${STORAGE_PREFIX}:presenceAccentMode`,
    migrated: `${STORAGE_PREFIX}:migrated`,
  };

  const state = {
    discoveredNames: {},
    selectedNames: [],
    favoriteNames: [],
    perNameColors: {},
    defaultColor: DEFAULT_HIGHLIGHT_COLOR,
    collectionMode: DEFAULT_COLLECTION_MODE,
    presenceAccentMode: DEFAULT_PRESENCE_ACCENT_MODE,
    panelVisible: false,
    dropdownOpen: false,
  };

  const tileNameCache = new WeakMap();
  const tileObserver = new MutationObserver(onMutations);
  let uiObserver = null;
  let highlightDebounce = null;
  let discoveryDebounce = null;

  function normalizeName(value) {
    return (value || "")
      .toString()
      .trim()
      .toLocaleLowerCase("de-DE")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function isElementVisible(el) {
    return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  function getStoredValue(key, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(key, fallback);
      }
    } catch (_error) {}

    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function setStoredValue(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return;
      }
    } catch (_error) {}

    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_error) {}
  }

  function getLegacyString(key, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(key, fallback);
      }
    } catch (_error) {}
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function migrateLegacyDataIfNeeded() {
    if (getStoredValue(KEYS.migrated, false)) {
      return;
    }

    const legacyNamesRaw = getLegacyString(LEGACY_NAMES_KEY, "");
    const legacyColor = getLegacyString(LEGACY_COLOR_KEY, DEFAULT_HIGHLIGHT_COLOR);
    const names = legacyNamesRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (names.length) {
      const discovered = {};
      const selected = [];
      names.forEach((name) => {
        const key = normalizeName(name);
        if (!key) {
          return;
        }
        discovered[key] = name;
        selected.push(key);
      });
      setStoredValue(KEYS.discovered, discovered);
      setStoredValue(KEYS.selected, selected);
      setStoredValue(KEYS.defaultColor, legacyColor || DEFAULT_HIGHLIGHT_COLOR);
    }

    setStoredValue(KEYS.migrated, true);
  }

  function loadState() {
    migrateLegacyDataIfNeeded();
    state.discoveredNames = getStoredValue(KEYS.discovered, {});
    state.selectedNames = getStoredValue(KEYS.selected, []);
    state.favoriteNames = getStoredValue(KEYS.favorites, []);
    state.perNameColors = getStoredValue(KEYS.colors, {});
    state.defaultColor = getStoredValue(KEYS.defaultColor, DEFAULT_HIGHLIGHT_COLOR);
    state.collectionMode = getStoredValue(KEYS.mode, DEFAULT_COLLECTION_MODE);
    state.presenceAccentMode = getStoredValue(KEYS.presenceAccentMode, DEFAULT_PRESENCE_ACCENT_MODE);
  }

  function persistState() {
    setStoredValue(KEYS.discovered, state.discoveredNames);
    setStoredValue(KEYS.selected, state.selectedNames);
    setStoredValue(KEYS.favorites, state.favoriteNames);
    setStoredValue(KEYS.colors, state.perNameColors);
    setStoredValue(KEYS.defaultColor, state.defaultColor);
    setStoredValue(KEYS.mode, state.collectionMode);
    setStoredValue(KEYS.presenceAccentMode, state.presenceAccentMode);
  }

  function getNameNodeFromTile(tile) {
    const direct = tile.querySelector(NAME_CONTAINER_SELECTOR);
    if (direct && direct.textContent && direct.textContent.trim()) {
      return direct;
    }
    return null;
  }

  function getNameInfoFromTile(tile) {
    const node = getNameNodeFromTile(tile);
    const label = (node?.textContent || "").trim();
    const key = normalizeName(label);
    return key ? { key, label } : null;
  }

  function getTilesByMode() {
    const allTiles = Array.from(document.querySelectorAll(TILE_SELECTOR)).filter(
      (tile) => !tile.classList.contains("tm-favorite-clone")
    );
    if (state.collectionMode === "visible_only") {
      return allTiles.filter(isElementVisible);
    }
    return allTiles;
  }

  function mergeDiscoveredFromTiles(tiles) {
    let changed = false;
    tiles.forEach((tile) => {
      const info = getNameInfoFromTile(tile);
      if (!info) {
        return;
      }
      tileNameCache.set(tile, info.key);
      if (!state.discoveredNames[info.key]) {
        state.discoveredNames[info.key] = info.label;
        changed = true;
      }
    });
    if (changed) {
      persistState();
      renderDiscoveredList();
    }
  }

  function rebuildDiscoveredByMode() {
    const tiles = getTilesByMode();
    const next = {};
    tiles.forEach((tile) => {
      const info = getNameInfoFromTile(tile);
      if (info) {
        next[info.key] = info.label;
        tileNameCache.set(tile, info.key);
      }
    });
    state.discoveredNames = next;
    state.selectedNames = state.selectedNames.filter((key) => Boolean(next[key]));
    state.favoriteNames = state.favoriteNames.filter((key) => Boolean(next[key]) && state.selectedNames.includes(key));
    Object.keys(state.perNameColors).forEach((key) => {
      if (!next[key]) {
        delete state.perNameColors[key];
      }
    });
    persistState();
    renderDiscoveredList();
    renderSelectedList();
    applyHighlighting();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOGGLE_ID} { margin-left: 4px; margin-right: 4px; display: flex; align-items: center; }
      #${TOGGLE_ID} button { border: 1px solid #c5c5c5; border-radius: 4px; background: #fff; color: #222; font-size: 12px; line-height: 1.2; min-height: 28px; padding: 5px 9px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
      #${PANEL_ID} { position: fixed; top: 70px; right: 20px; width: 340px; background: #fff; border: 1px solid #bfc6d4; border-radius: 8px; box-shadow: 0 8px 26px rgba(0,0,0,.18); z-index: 2147483647; display: none; font-family: Arial, sans-serif; }
      #${PANEL_ID}.open { display: block; }
      #${PANEL_ID} .tm-head { padding: 10px 12px 6px; font-weight: 600; font-size: 13px; }
      #${PANEL_ID} .tm-body { padding: 0 12px 12px; font-size: 12px; }
      #${PANEL_ID} .tm-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
      #${PANEL_ID} .tm-dropdown { position: relative; margin-top: 8px; }
      #${PANEL_ID} .tm-dropdown-toggle { width: 100%; text-align: left; border: 1px solid #9eacc5; border-radius: 6px; padding: 8px 34px 8px 10px; background: #fff; cursor: pointer; position: relative; font-weight: 400; }
      #${PANEL_ID} .tm-dropdown-toggle::after { content: "▾"; position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: #44516a; font-size: 14px; pointer-events: none; }
      #${PANEL_ID}.tm-dropdown-open .tm-dropdown-toggle::after { content: "▴"; }
      #${PANEL_ID} .tm-dropdown-toggle:hover { background: #f7faff; border-color: #8396b8; }
      #${PANEL_ID} .tm-picker-hint { margin-top: 4px; font-size: 11px; color: #5b6980; }
      #${PANEL_ID} .tm-dropdown-menu { display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; max-height: 260px; overflow: auto; border: 1px solid #c5c5c5; border-radius: 6px; background: #fff; z-index: 2; padding: 8px; }
      #${PANEL_ID}.tm-dropdown-open .tm-dropdown-menu { display: block; }
      #${PANEL_ID} .tm-search { width: 100%; border: 1px solid #d0d6e2; border-radius: 4px; padding: 5px 7px; margin-bottom: 6px; box-sizing: border-box; }
      #${PANEL_ID} .tm-option { display: flex; align-items: center; gap: 7px; padding: 2px 0; }
      #${PANEL_ID} .tm-selected-list { margin-top: 8px; border-top: 1px solid #eceff5; padding-top: 8px; max-height: 210px; overflow: auto; }
      #${PANEL_ID} .tm-selected-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      #${PANEL_ID} input[type="color"] { width: 45px; height: 26px; border: 1px solid #c5c5c5; border-radius: 4px; padding: 0; cursor: pointer; }
      #${PANEL_ID} .tm-actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
      #${PANEL_ID} .tm-actions button { border: 1px solid #c5c5c5; border-radius: 4px; background: #f8f8f8; font-size: 12px; padding: 5px 8px; cursor: pointer; }
      #${PANEL_ID} .tm-status { margin-top: 8px; color: #4f5b70; font-size: 11px; }
      #${PANEL_ID} .tm-name-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
      #${PANEL_ID} .tm-favorite-toggle { border: 1px solid #c5c5c5; background: #fff; border-radius: 4px; color: #607089; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; line-height: 1; }
      #${PANEL_ID} .tm-favorite-toggle.is-favorite { color: #c58600; border-color: #d4b45a; background: #fff8e6; }
      #${PANEL_ID} .tm-selected-item > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .${FAVORITES_SECTION_CLASS} { margin: 10px auto; width: calc(100% - 20px); box-sizing: border-box; padding: 8px; border: 1px solid #d9e2f1; border-radius: 8px; background: #f8fbff; }
      .${FAVORITES_SECTION_CLASS} .tm-favorites-tiles-title { font-size: 12px; font-weight: 600; color: #3f4f68; margin-bottom: 8px; }
      .${FAVORITES_SECTION_CARDS_CLASS} { display: flex; flex-wrap: wrap; gap: 8px; }
      .${FAVORITES_SECTION_CARDS_CLASS} .tm-favorite-clone { flex: 0 1 220px; max-width: 260px; }
      html.tm-presence-accent-all ${TILE_SELECTOR} > div[data-bind*="presenceState"],
      html.tm-presence-accent-selected ${TILE_SELECTOR}.tm-name-match > div[data-bind*="presenceState"] { width: 10px !important; border-right: 1px solid rgba(255,255,255,0.65); box-shadow: inset -1px 0 0 rgba(0,0,0,0.2), inset 0 0 0 1px rgba(255,255,255,0.2); filter: saturate(1.3) contrast(1.12) brightness(1.05); border-radius: 0; transition: box-shadow .15s ease, filter .15s ease; }
      html.tm-presence-accent-all ${TILE_SELECTOR}:hover > div[data-bind*="presenceState"],
      html.tm-presence-accent-selected ${TILE_SELECTOR}.tm-name-match:hover > div[data-bind*="presenceState"] { box-shadow: inset -1px 0 0 rgba(0,0,0,0.24), inset 0 0 0 1px rgba(255,255,255,0.24); }
      ${TILE_SELECTOR}.tm-name-match { outline: 3px solid var(--tm-tile-color, ${DEFAULT_HIGHLIGHT_COLOR}); border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 2px color-mix(in srgb, var(--tm-tile-color, ${DEFAULT_HIGHLIGHT_COLOR}) 35%, transparent), 0 0 14px color-mix(in srgb, var(--tm-tile-color, ${DEFAULT_HIGHLIGHT_COLOR}) 35%, transparent); background: linear-gradient(0deg, color-mix(in srgb, var(--tm-tile-color, ${DEFAULT_HIGHLIGHT_COLOR}) 24%, white), color-mix(in srgb, var(--tm-tile-color, ${DEFAULT_HIGHLIGHT_COLOR}) 24%, white)); }
    `;
    document.head.appendChild(style);
  }

  function getPanel() {
    return document.getElementById(PANEL_ID);
  }

  function getSelectedSet() {
    return new Set(state.selectedNames);
  }

  function getColorForNameKey(nameKey) {
    return state.perNameColors[nameKey] || state.defaultColor || DEFAULT_HIGHLIGHT_COLOR;
  }

  function applyHighlighting() {
    const selected = getSelectedSet();
    const favorites = new Set(state.favoriteNames);
    let hits = 0;
    const favoriteTilesByHost = new Map();

    Array.from(document.querySelectorAll(TILE_SELECTOR))
      .filter((tile) => !tile.classList.contains("tm-favorite-clone"))
      .forEach((tile) => {
      const info = getNameInfoFromTile(tile);
      const isMatch = Boolean(info && selected.has(info.key));
      tile.classList.toggle("tm-name-match", isMatch);
      if (isMatch) {
        tile.style.setProperty("--tm-tile-color", getColorForNameKey(info.key));
        hits += 1;
      } else {
        tile.style.removeProperty("--tm-tile-color");
      }
      if (info) {
        tileNameCache.set(tile, info.key);
      }

      if (info && favorites.has(info.key)) {
        const host = tile.parentElement;
        if (!host) {
          return;
        }
        const list = favoriteTilesByHost.get(host) || [];
        list.push(tile);
        favoriteTilesByHost.set(host, list);
      }
    });

    renderFavoriteTilesSections(favoriteTilesByHost);

    const status = document.querySelector(`#${PANEL_ID} .tm-status`);
    if (status) {
      status.textContent = `${hits} Treffer sichtbar`;
    }
  }

  function getOrCreateFavoriteSection(host) {
    let section = host.querySelector(`:scope > .${FAVORITES_SECTION_CLASS}`);
    if (!section) {
      section = document.createElement("div");
      section.className = FAVORITES_SECTION_CLASS;
      section.innerHTML = `<div class="tm-favorites-tiles-title">Favoriten</div><div class="${FAVORITES_SECTION_CARDS_CLASS}"></div>`;
      host.insertBefore(section, host.firstChild);
    }
    return section;
  }

  function cleanupFavoriteSections() {
    document.querySelectorAll(`.${FAVORITES_SECTION_CLASS}`).forEach((section) => section.remove());
  }

  function renderFavoriteTilesSections(favoriteTilesByHost) {
    cleanupFavoriteSections();
    favoriteTilesByHost.forEach((favoriteTiles, host) => {
      if (!favoriteTiles.length) {
        return;
      }
      const section = getOrCreateFavoriteSection(host);
      const cards = section.querySelector(`.${FAVORITES_SECTION_CARDS_CLASS}`);
      cards.innerHTML = "";
      favoriteTiles.forEach((tile) => {
        const clone = tile.cloneNode(true);
        clone.classList.add("tm-favorite-clone");
        cards.appendChild(clone);
      });
      host.insertBefore(section, host.firstChild);
    });
  }

  function applyPresenceAccentModeClass() {
    const root = document.documentElement;
    root.classList.remove("tm-presence-accent-all", "tm-presence-accent-selected");
    if (state.presenceAccentMode === "selected") {
      root.classList.add("tm-presence-accent-selected");
    } else if (state.presenceAccentMode === "all") {
      root.classList.add("tm-presence-accent-all");
    }
  }

  function scheduleHighlighting() {
    window.clearTimeout(highlightDebounce);
    highlightDebounce = window.setTimeout(applyHighlighting, 120);
  }

  function renderDiscoveredList() {
    const panel = getPanel();
    if (!panel) {
      return;
    }
    const list = panel.querySelector(".tm-options");
    if (!list) {
      return;
    }

    const filterValue = normalizeName(panel.querySelector(".tm-search")?.value || "");
    const selected = getSelectedSet();
    const names = Object.entries(state.discoveredNames).sort((a, b) => a[1].localeCompare(b[1], "de-DE"));
    const items = names.filter(([, label]) => normalizeName(label).includes(filterValue));

    list.innerHTML = items
      .map(([key, label]) => {
        const checked = selected.has(key) ? "checked" : "";
        return `<label class="tm-option"><input type="checkbox" data-name-key="${key}" ${checked}><span>${label}</span></label>`;
      })
      .join("");

    const toggle = panel.querySelector(".tm-dropdown-toggle");
    if (toggle) {
      const suffix = state.selectedNames.length === 1 ? "" : "e";
      toggle.textContent = `Namen auswählen (${state.selectedNames.length} Name${suffix} ausgewählt)`;
    }
  }

  function renderSelectedList() {
    const panel = getPanel();
    if (!panel) {
      return;
    }
    const list = panel.querySelector(".tm-selected-list");
    if (!list) {
      return;
    }
    const rows = state.selectedNames
      .filter((key) => state.discoveredNames[key])
      .map((key) => {
        const label = state.discoveredNames[key];
        const color = getColorForNameKey(key);
        const isFavorite = state.favoriteNames.includes(key);
        const favoriteClass = isFavorite ? "is-favorite" : "";
        const favoriteIcon = isFavorite ? "★" : "☆";
        const favoriteTitle = isFavorite ? "Favorit entfernen" : "Als Favorit markieren";
        return `<div class="tm-selected-item"><div class="tm-name-main"><button type="button" class="tm-favorite-toggle ${favoriteClass}" data-favorite-key="${key}" title="${favoriteTitle}" aria-label="${favoriteTitle}">${favoriteIcon}</button><span>${label}</span></div><input type="color" data-color-key="${key}" value="${color}"></div>`;
      });

    list.innerHTML = rows.join("") || "<div>Keine Namen ausgewählt</div>";
  }

  function toggleDropdown(forceOpen) {
    const panel = getPanel();
    if (!panel) {
      return;
    }
    state.dropdownOpen = typeof forceOpen === "boolean" ? forceOpen : !state.dropdownOpen;
    panel.classList.toggle("tm-dropdown-open", state.dropdownOpen);
  }

  function refreshDiscoveryIncremental() {
    const tiles = getTilesByMode();
    mergeDiscoveredFromTiles(tiles);
    scheduleHighlighting();
  }

  function scheduleDiscoveryUpdate(fullRebuild) {
    window.clearTimeout(discoveryDebounce);
    discoveryDebounce = window.setTimeout(() => {
      if (fullRebuild) {
        rebuildDiscoveredByMode();
      } else {
        refreshDiscoveryIncremental();
      }
    }, 130);
  }

  function createPanel() {
    if (getPanel()) {
      return;
    }
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="tm-head">Namen hervorheben</div>
      <div class="tm-body">
        <div class="tm-row">
          <label for="tm-default-color">Standardfarbe</label>
          <input id="tm-default-color" type="color" value="${state.defaultColor}">
        </div>
        <div class="tm-row">
          <label for="tm-collection-mode">Namensquelle</label>
          <select id="tm-collection-mode">
            <option value="all_loaded">Alle geladenen Kacheln</option>
            <option value="visible_only">Nur sichtbare Kacheln</option>
          </select>
        </div>
        <div class="tm-row">
          <label for="tm-presence-accent-mode">Status-Balken hervorheben</label>
          <select id="tm-presence-accent-mode">
            <option value="all">Bei allen Personen</option>
            <option value="selected">Nur bei ausgewählten Personen</option>
            <option value="none">Gar nicht hervorheben</option>
          </select>
        </div>
        <div class="tm-dropdown">
          <button type="button" class="tm-dropdown-toggle">Namen auswählen (0 Namen ausgewählt)</button>
          <div class="tm-picker-hint">Klicken, um Namen anzuhaken oder abzuwählen</div>
          <div class="tm-dropdown-menu">
            <input type="text" class="tm-search" placeholder="Namen filtern">
            <div class="tm-options"></div>
          </div>
        </div>
        <div class="tm-selected-list"></div>
        <div class="tm-actions">
          <button type="button" data-action="refresh">Jetzt aktualisieren</button>
          <button type="button" data-action="clear">Auswahl leeren</button>
          <button type="button" data-action="close">Schließen</button>
        </div>
        <div class="tm-status">0 Treffer sichtbar</div>
      </div>
    `;
    document.body.appendChild(panel);

    const defaultColorInput = panel.querySelector("#tm-default-color");
    const modeSelect = panel.querySelector("#tm-collection-mode");
    const presenceAccentModeSelect = panel.querySelector("#tm-presence-accent-mode");
    modeSelect.value = state.collectionMode;
    presenceAccentModeSelect.value = state.presenceAccentMode;

    panel.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) {
        return;
      }
      const action = button.getAttribute("data-action");
      if (button.classList.contains("tm-dropdown-toggle")) {
        toggleDropdown();
        return;
      }
      if (action === "refresh") {
        scheduleDiscoveryUpdate(true);
      } else if (action === "clear") {
        const confirmed = window.confirm("Möchtest du wirklich die komplette Auswahl leeren?");
        if (!confirmed) {
          return;
        }
        state.selectedNames = [];
        state.favoriteNames = [];
        persistState();
        renderDiscoveredList();
        renderSelectedList();
        scheduleHighlighting();
      } else if (action === "close") {
        togglePanel(false);
      } else {
        const favoriteButton = button.closest(".tm-favorite-toggle");
        if (!favoriteButton) {
          return;
        }
        const key = favoriteButton.getAttribute("data-favorite-key");
        if (!key || !state.selectedNames.includes(key)) {
          return;
        }
        const favorites = new Set(state.favoriteNames);
        if (favorites.has(key)) {
          favorites.delete(key);
        } else {
          favorites.add(key);
        }
        state.favoriteNames = Array.from(favorites);
        persistState();
        renderSelectedList();
        scheduleHighlighting();
      }
    });

    function handlePerNameColorInput(event) {
      const colorInput = event.target.closest('input[type="color"][data-color-key]');
      if (!colorInput) {
        return;
      }
      const key = colorInput.getAttribute("data-color-key");
      state.perNameColors[key] = colorInput.value;
      persistState();
      scheduleHighlighting();
    }

    panel.addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"][data-name-key]');
      if (checkbox) {
        const key = checkbox.getAttribute("data-name-key");
        const selected = getSelectedSet();
        if (checkbox.checked) {
          selected.add(key);
        } else {
          selected.delete(key);
        }
        state.selectedNames = Array.from(selected);
        state.favoriteNames = state.favoriteNames.filter((favoriteKey) => selected.has(favoriteKey));
        persistState();
        renderDiscoveredList();
        renderSelectedList();
        scheduleHighlighting();
        return;
      }
      handlePerNameColorInput(event);
    });

    panel.addEventListener("input", handlePerNameColorInput);

    defaultColorInput.addEventListener("input", () => {
      state.defaultColor = defaultColorInput.value || DEFAULT_HIGHLIGHT_COLOR;
      persistState();
      renderSelectedList();
      scheduleHighlighting();
    });

    modeSelect.addEventListener("change", () => {
      const next = modeSelect.value;
      if (next !== "all_loaded" && next !== "visible_only") {
        return;
      }
      state.collectionMode = next;
      persistState();
      scheduleDiscoveryUpdate(true);
    });

    presenceAccentModeSelect.addEventListener("change", () => {
      const next = presenceAccentModeSelect.value;
      if (next !== "all" && next !== "selected" && next !== "none") {
        return;
      }
      state.presenceAccentMode = next;
      persistState();
      applyPresenceAccentModeClass();
      scheduleHighlighting();
    });

    panel.querySelector(".tm-search").addEventListener("input", renderDiscoveredList);

    document.addEventListener("click", (event) => {
      if (!panel.contains(event.target) && event.target.id !== TOGGLE_ID) {
        toggleDropdown(false);
      }
    });

    renderDiscoveredList();
    renderSelectedList();
  }

  function togglePanel(forceState) {
    const panel = getPanel();
    if (!panel) {
      return;
    }
    state.panelVisible = typeof forceState === "boolean" ? forceState : !state.panelVisible;
    panel.classList.toggle("open", state.panelVisible);
    if (!state.panelVisible) {
      toggleDropdown(false);
    }
  }

  function injectToggleButtonIntoHeader() {
    const headers = document.querySelectorAll(HEADER_SELECTOR);
    if (!headers.length) {
      return false;
    }

    for (const header of headers) {
      const menu = header.querySelector(".sagehr-dataheader-menu");
      if (!menu || header.querySelector(`#${TOGGLE_ID}`)) {
        continue;
      }
      const wrapper = document.createElement("div");
      wrapper.id = TOGGLE_ID;
      wrapper.innerHTML = `<button type="button" title="Namen markieren">Highlight Namen</button>`;
      wrapper.querySelector("button").addEventListener("click", () => togglePanel());
      if (menu.parentElement === header) {
        header.insertBefore(wrapper, menu);
      } else {
        header.appendChild(wrapper);
      }
      return true;
    }
    return false;
  }

  function onMutations(mutations) {
    let hasRelevant = false;
    const hasRealTile = (node) => {
      if (!(node instanceof Element)) {
        return false;
      }
      if (node.closest(`.${FAVORITES_SECTION_CLASS}`)) {
        return false;
      }
      if (node.matches?.(`${TILE_SELECTOR}:not(.tm-favorite-clone)`)) {
        return true;
      }
      return Boolean(node.querySelector?.(`${TILE_SELECTOR}:not(.tm-favorite-clone)`));
    };

    mutations.forEach((mutation) => {
      if (mutation.type !== "childList") {
        return;
      }
      mutation.addedNodes.forEach((node) => {
        if (hasRealTile(node)) {
          hasRelevant = true;
        }
      });
      mutation.removedNodes.forEach((node) => {
        if (hasRealTile(node)) {
          hasRelevant = true;
        }
      });
    });
    if (!hasRelevant) {
      return;
    }
    scheduleDiscoveryUpdate(state.collectionMode === "visible_only");
  }

  function startObservers() {
    tileObserver.observe(document.body, { childList: true, subtree: true });

    uiObserver = new MutationObserver(() => {
      if (!document.getElementById(TOGGLE_ID)) {
        injectToggleButtonIntoHeader();
      }
    });
    uiObserver.observe(document.body, { childList: true, subtree: true });
  }

  function bootstrap() {
    loadState();
    injectStyles();
    applyPresenceAccentModeClass();
    createPanel();
    injectToggleButtonIntoHeader();
    refreshDiscoveryIncremental();
    applyHighlighting();
    startObservers();
  }

  bootstrap();
})();
