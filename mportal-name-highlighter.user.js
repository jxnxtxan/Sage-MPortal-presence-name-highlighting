// ==UserScript==
// @name         mPortal Name Highlighter
// @namespace    local.tampermonkey.mportal
// @version      2.1.0
// @description  Auto-detect names in presence tiles, select via dropdown, and assign highlight colors.
// @author       jxnxtxan
// @downloadURL  https://raw.githubusercontent.com/jxnxtxan/Sage-MPortal-presence-name-highlighting/main/mportal-name-highlighter.user.js
// @updateURL    https://raw.githubusercontent.com/jxnxtxan/Sage-MPortal-presence-name-highlighting/main/mportal-name-highlighter.user.js
// @match        *://*/HRPortal/*/Time/Presence
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const PRESENCE_API_PATH = "/hrportalapi/Time/Presence";
  const PRESENCE_POST_MIN_BATCH = 500;

  // Runs in the page context (injected as source), so it must not reference anything outside itself.
  function presencePostBodyAmplifier(target, minTake) {
    if (window.__tmMportalPresenceAmplify) {
      return;
    }
    window.__tmMportalPresenceAmplify = true;
    const TAKE_KEYS = ["take", "pagesize", "rowcount", "maxrows", "size", "count", "top", "limit"];

    function bumpTakeDeep(o) {
      if (!o || typeof o !== "object") {
        return false;
      }
      if (Array.isArray(o)) {
        return o.some(bumpTakeDeep);
      }
      const keys = Object.keys(o);
      for (const name of TAKE_KEYS) {
        const key = keys.find((k) => k.toLowerCase() === name && typeof o[k] === "number" && o[k] > 0);
        if (key) {
          o[key] = Math.max(o[key], minTake);
          return true;
        }
      }
      return keys.some((k) => bumpTakeDeep(o[k]));
    }

    function rewriteBody(body) {
      try {
        const parsed = JSON.parse(body);
        bumpTakeDeep(parsed);
        return JSON.stringify(parsed);
      } catch (_error) {
        return body;
      }
    }

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__tmPresenceReqUrl = String(url || "");
      return origOpen.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      if ((this.__tmPresenceReqUrl || "").includes(target) && typeof body === "string" && body) {
        body = rewriteBody(body);
      }
      return origSend.call(this, body);
    };

    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.includes(target) && String(init?.method).toUpperCase() === "POST" && typeof init.body === "string" && init.body) {
          return origFetch.call(this, input, { ...init, body: rewriteBody(init.body) });
        }
        return origFetch.apply(this, arguments);
      };
    }
  }

  const amplifierScript = document.createElement("script");
  amplifierScript.textContent = `(${presencePostBodyAmplifier})(${JSON.stringify(PRESENCE_API_PATH)}, ${PRESENCE_POST_MIN_BATCH});`;
  document.documentElement.appendChild(amplifierScript);
  amplifierScript.remove();

  const STORAGE_PREFIX = "mportalNameHighlighterV2";
  const DEFAULT_HIGHLIGHT_COLOR = "#ffb020";
  const AUTO_COLOR_PALETTE = [
    "#ffb020",
    "#2f80ed",
    "#27ae60",
    "#eb5757",
    "#9b51e0",
    "#00b8d9",
    "#ff6fb5",
    "#8d6e63",
    "#f2c94c",
    "#1abc9c",
    "#e67e22",
    "#34495e",
  ];
  const FAVORITE_PREFETCH_MAX_STEPS = 90;
  const FAVORITE_PREFETCH_STEP_DELAY_MS = 160;
  const FAVORITE_PREFETCH_SCHEDULE_MS = 380;

  const PANEL_ID = "tm-name-highlight-panel";
  const TOGGLE_ID = "tm-name-highlight-toggle";
  const STYLE_ID = "tm-name-highlight-style";
  const TILE_SELECTOR = ".sagehr-tile";
  const REAL_TILE_SELECTOR = `${TILE_SELECTOR}:not(.tm-favorite-clone)`;
  const HEADER_SELECTOR = ".sagehr-dataheader";
  const NAME_CONTAINER_SELECTOR = ".sagehr-tile-small-info > .text-overflow-ellipsis";
  const FAVORITES_SECTION_CLASS = "tm-favorites-tiles-section";
  const FAVORITES_SECTION_CARDS_CLASS = "tm-favorites-tiles-cards";

  // Persisted fields; each is stored under `${STORAGE_PREFIX}:${field}`.
  const PERSISTED_DEFAULTS = {
    discoveredNames: {},
    selectedNames: [],
    favoriteNames: [],
    perNameColors: {},
    defaultColor: DEFAULT_HIGHLIGHT_COLOR,
    collectionMode: "all_loaded",
    presenceAccentMode: "all",
  };

  const state = {
    ...structuredClone(PERSISTED_DEFAULTS),
    panelVisible: false,
    dropdownOpen: false,
  };

  let favoritePrefetchRunning = false;
  let favoritePrefetchExhaustedFp = "";

  function debounce(fn, ms) {
    let timer = null;
    const debounced = (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), ms);
    };
    debounced.cancel = () => window.clearTimeout(timer);
    return debounced;
  }

  const scheduleHighlighting = debounce(() => applyHighlighting(), 120);
  const scheduleDiscoveryUpdate = debounce((fullRebuild) => {
    if (fullRebuild) {
      rebuildDiscoveredByMode();
    } else {
      refreshDiscoveryIncremental();
    }
  }, 130);
  const scheduleFavoritePrefetch = debounce(() => runFavoritePrefetch(false), FAVORITE_PREFETCH_SCHEDULE_MS);

  function normalizeName(value) {
    return (value || "")
      .toString()
      .trim()
      .toLocaleLowerCase("de-DE")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function loadState() {
    Object.keys(PERSISTED_DEFAULTS).forEach((field) => {
      state[field] = getStoredValue(`${STORAGE_PREFIX}:${field}`, structuredClone(PERSISTED_DEFAULTS[field]));
    });
  }

  function persist(...fields) {
    fields.forEach((field) => setStoredValue(`${STORAGE_PREFIX}:${field}`, state[field]));
  }

  function getRealTiles() {
    return Array.from(document.querySelectorAll(REAL_TILE_SELECTOR));
  }

  function getNameInfoFromTile(tile) {
    const label = (tile.querySelector(NAME_CONTAINER_SELECTOR)?.textContent || "").trim();
    const key = normalizeName(label);
    return key ? { key, label } : null;
  }

  function getTilesByMode() {
    const tiles = getRealTiles();
    return state.collectionMode === "visible_only" ? tiles.filter(isElementVisible) : tiles;
  }

  function refreshDiscoveryIncremental() {
    let changed = false;
    getTilesByMode().forEach((tile) => {
      const info = getNameInfoFromTile(tile);
      if (info && !state.discoveredNames[info.key]) {
        state.discoveredNames[info.key] = info.label;
        changed = true;
      }
    });
    if (changed) {
      persist("discoveredNames");
      renderDiscoveredList();
    }
    scheduleHighlighting();
  }

  function rebuildDiscoveredByMode() {
    const next = {};
    getTilesByMode().forEach((tile) => {
      const info = getNameInfoFromTile(tile);
      if (info) {
        next[info.key] = info.label;
      }
    });
    // Keep selected names even if their tile is currently not rendered (virtualized list /
    // "visible only" mode); otherwise scrolling would silently drop selection, colors and favorites.
    state.selectedNames.forEach((key) => {
      if (!next[key] && state.discoveredNames[key]) {
        next[key] = state.discoveredNames[key];
      }
    });
    state.discoveredNames = next;
    state.selectedNames = state.selectedNames.filter((key) => next[key]);
    state.favoriteNames = state.favoriteNames.filter((key) => state.selectedNames.includes(key));
    Object.keys(state.perNameColors).forEach((key) => {
      if (!next[key]) {
        delete state.perNameColors[key];
      }
    });
    persist("discoveredNames", "selectedNames", "favoriteNames", "perNameColors");
    renderPanelLists();
    applyHighlighting();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOGGLE_ID} {
        margin-left: 4px; margin-right: 4px; display: flex; align-items: center;
        button { border: 1px solid #c5c5c5; border-radius: 4px; background: #fff; color: #222; font-size: 12px; line-height: 1.2; min-height: 28px; padding: 5px 9px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
      }
      #${PANEL_ID} {
        position: fixed; top: 70px; right: 20px; width: 340px; background: #fff; border: 1px solid #bfc6d4; border-radius: 8px; box-shadow: 0 8px 26px rgba(0,0,0,.18); z-index: 2147483647; display: none; font-family: Arial, sans-serif;
        &.open { display: block; }
        .tm-head { padding: 10px 12px 6px; font-weight: 600; font-size: 13px; }
        .tm-body { padding: 0 12px 12px; font-size: 12px; }
        .tm-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
        .tm-dropdown { position: relative; margin-top: 8px; }
        .tm-dropdown-toggle { width: 100%; text-align: left; border: 1px solid #9eacc5; border-radius: 6px; padding: 8px 34px 8px 10px; background: #fff; cursor: pointer; position: relative; font-weight: 400; }
        .tm-dropdown-toggle::after { content: "▾"; position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: #44516a; font-size: 14px; pointer-events: none; }
        .tm-dropdown-toggle:hover { background: #f7faff; border-color: #8396b8; }
        .tm-picker-hint { margin-top: 4px; font-size: 11px; color: #5b6980; }
        .tm-dropdown-menu { display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; max-height: 260px; overflow: auto; border: 1px solid #c5c5c5; border-radius: 6px; background: #fff; z-index: 2; padding: 8px; }
        &.tm-dropdown-open .tm-dropdown-toggle::after { content: "▴"; }
        &.tm-dropdown-open .tm-dropdown-menu { display: block; }
        .tm-search { width: 100%; border: 1px solid #d0d6e2; border-radius: 4px; padding: 5px 7px; margin-bottom: 6px; box-sizing: border-box; }
        .tm-option { display: flex; align-items: center; gap: 7px; padding: 2px 0; }
        .tm-selected-list { margin-top: 8px; border-top: 1px solid #eceff5; padding-top: 8px; max-height: 210px; overflow: auto; }
        .tm-selected-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
        .tm-selected-item > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        input[type="color"] { width: 45px; height: 26px; border: 1px solid #c5c5c5; border-radius: 4px; padding: 0; cursor: pointer; }
        .tm-actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
        .tm-actions button { border: 1px solid #c5c5c5; border-radius: 4px; background: #f8f8f8; font-size: 12px; padding: 5px 8px; cursor: pointer; }
        .tm-status { margin-top: 8px; color: #4f5b70; font-size: 11px; }
        .tm-name-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .tm-favorite-toggle { border: 1px solid #c5c5c5; background: #fff; border-radius: 4px; color: #607089; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; line-height: 1; }
        .tm-favorite-toggle.is-favorite { color: #c58600; border-color: #d4b45a; background: #fff8e6; }
      }
      .${FAVORITES_SECTION_CLASS} {
        margin: 10px auto; width: calc(100% - 20px); box-sizing: border-box; padding: 8px; border: 1px solid #d9e2f1; border-radius: 8px; background: #f8fbff;
        .tm-favorites-tiles-title { font-size: 12px; font-weight: 600; color: #3f4f68; margin-bottom: 8px; }
      }
      .${FAVORITES_SECTION_CARDS_CLASS} {
        display: flex; flex-wrap: wrap; gap: 8px;
        .tm-favorite-clone { flex: 0 1 220px; max-width: 260px; }
        .tm-favorite-placeholder { flex: 0 1 220px; max-width: 260px; box-sizing: border-box; min-height: 72px; padding: 10px 12px; border: 1px dashed #9eacc5; border-radius: 8px; background: #fff; color: #3f4f68; font-size: 13px; line-height: 1.35; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
        .tm-favorite-placeholder-name { font-weight: 600; }
        .tm-favorite-placeholder-hint { font-size: 11px; color: #5b6980; font-weight: 400; }
      }
      :is(html.tm-presence-accent-all ${TILE_SELECTOR}, html.tm-presence-accent-selected ${TILE_SELECTOR}.tm-name-match) {
        > div[data-bind*="presenceState"] { width: 10px !important; border-right: 1px solid rgba(255,255,255,0.65); box-shadow: inset -1px 0 0 rgba(0,0,0,0.2), inset 0 0 0 1px rgba(255,255,255,0.2); filter: saturate(1.3) contrast(1.12) brightness(1.05); border-radius: 0; transition: box-shadow .15s ease, filter .15s ease; }
        &:hover > div[data-bind*="presenceState"] { box-shadow: inset -1px 0 0 rgba(0,0,0,0.24), inset 0 0 0 1px rgba(255,255,255,0.24); }
      }
      ${TILE_SELECTOR}.tm-name-match {
        --tm-c: var(--tm-tile-color, ${DEFAULT_HIGHLIGHT_COLOR});
        outline: 3px solid var(--tm-c); border-radius: 8px; overflow: hidden;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--tm-c) 35%, transparent), 0 0 14px color-mix(in srgb, var(--tm-c) 35%, transparent);
        background: color-mix(in srgb, var(--tm-c) 24%, white);
      }
    `;
    document.head.appendChild(style);
  }

  function getPanel() {
    return document.getElementById(PANEL_ID);
  }

  function getColorForNameKey(nameKey) {
    return state.perNameColors[nameKey] || state.defaultColor || DEFAULT_HIGHLIGHT_COLOR;
  }

  function ensureDistinctColorForNameKey(nameKey) {
    const usedByOthers = new Set(
      state.selectedNames
        .filter((key) => key !== nameKey)
        .map((key) => getColorForNameKey(key).toLowerCase())
    );
    const current = state.perNameColors[nameKey];
    if (current && !usedByOthers.has(current.toLowerCase())) {
      return;
    }
    const free = AUTO_COLOR_PALETTE.find((color) => !usedByOthers.has(color));
    state.perNameColors[nameKey] = free || AUTO_COLOR_PALETTE[usedByOthers.size % AUTO_COLOR_PALETTE.length];
  }

  function getMissingFavoriteKeys() {
    if (!state.favoriteNames.length) {
      return [];
    }
    const loaded = new Set(getRealTiles().map((tile) => getNameInfoFromTile(tile)?.key));
    return state.favoriteNames.filter((key) => state.selectedNames.includes(key) && !loaded.has(key));
  }

  function fingerprintKeys(keys) {
    return keys.slice().sort().join("\u0001");
  }

  function pickBestListScroller(sampleTile) {
    const scrollRange = (el) => el.scrollHeight - el.clientHeight;
    let best = null;
    for (let el = sampleTile.parentElement; el; el = el.parentElement) {
      const scrollableY = ["auto", "scroll", "overlay"].includes(window.getComputedStyle(el).overflowY);
      if (scrollableY && scrollRange(el) > 6 && (!best || scrollRange(el) > scrollRange(best))) {
        best = el;
      }
    }
    if (best) {
      return best;
    }
    const root = document.scrollingElement || document.documentElement;
    return scrollRange(root) > 6 ? root : null;
  }

  // Scrolls the tile list step by step so the portal lazy-loads tiles of favorites that are not yet in the DOM.
  function runFavoritePrefetch(force) {
    if (favoritePrefetchRunning) {
      return;
    }
    if (force) {
      favoritePrefetchExhaustedFp = "";
    }
    const missingStart = getMissingFavoriteKeys();
    if (!missingStart.length) {
      favoritePrefetchExhaustedFp = "";
      return;
    }
    if (fingerprintKeys(missingStart) === favoritePrefetchExhaustedFp) {
      return;
    }
    const sample = document.querySelector(REAL_TILE_SELECTOR);
    const scroller = sample && pickBestListScroller(sample);
    if (!scroller) {
      return;
    }

    favoritePrefetchRunning = true;
    const savedTop = scroller.scrollTop;
    let steps = 0;
    let stagnantMoves = 0;

    const finish = (stillMissing) => {
      favoritePrefetchRunning = false;
      scroller.scrollTop = savedTop;
      favoritePrefetchExhaustedFp = stillMissing.length ? fingerprintKeys(stillMissing) : "";
      refreshDiscoveryIncremental();
    };

    const step = () => {
      const stillMissing = getMissingFavoriteKeys();
      if (!stillMissing.length || steps >= FAVORITE_PREFETCH_MAX_STEPS) {
        finish(stillMissing);
        return;
      }

      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const prevTop = scroller.scrollTop;
      const delta = Math.max(200, Math.floor(scroller.clientHeight * 0.82));
      scroller.scrollTop = Math.min(prevTop + delta, maxScroll);
      steps += 1;
      stagnantMoves = scroller.scrollTop > prevTop + 0.5 ? 0 : stagnantMoves + 1;

      if (scroller.scrollTop >= maxScroll - 2 || stagnantMoves >= 4) {
        finish(stillMissing);
        return;
      }
      window.setTimeout(step, FAVORITE_PREFETCH_STEP_DELAY_MS);
    };

    window.setTimeout(step, 120);
  }

  function applyHighlighting() {
    const selected = new Set(state.selectedNames);
    const favorites = new Set(state.favoriteNames);
    // host element -> (name key -> first tile with that name)
    const favoriteTilesByHost = new Map();
    let hits = 0;

    getRealTiles().forEach((tile) => {
      const info = getNameInfoFromTile(tile);
      const isMatch = Boolean(info && selected.has(info.key));
      tile.classList.toggle("tm-name-match", isMatch);
      if (isMatch) {
        tile.style.setProperty("--tm-tile-color", getColorForNameKey(info.key));
        hits += 1;
      } else {
        tile.style.removeProperty("--tm-tile-color");
      }

      const host = tile.parentElement;
      if (info && favorites.has(info.key) && host) {
        const tilesByKey = favoriteTilesByHost.get(host) || new Map();
        if (!tilesByKey.has(info.key)) {
          tilesByKey.set(info.key, tile);
        }
        favoriteTilesByHost.set(host, tilesByKey);
      }
    });

    const missingFavoriteKeys = getMissingFavoriteKeys();
    renderFavoriteTilesSections(favoriteTilesByHost, missingFavoriteKeys);

    if (missingFavoriteKeys.length) {
      scheduleFavoritePrefetch();
    } else {
      favoritePrefetchExhaustedFp = "";
    }

    const status = document.querySelector(`#${PANEL_ID} .tm-status`);
    if (status) {
      status.textContent = `${hits} Treffer sichtbar`;
    }
  }

  function renderFavoriteTilesSections(favoriteTilesByHost, missingFavoriteKeys) {
    document.querySelectorAll(`.${FAVORITES_SECTION_CLASS}`).forEach((section) => section.remove());

    const primaryHost =
      favoriteTilesByHost.keys().next().value || document.querySelector(REAL_TILE_SELECTOR)?.parentElement;
    if (missingFavoriteKeys.length && primaryHost && !favoriteTilesByHost.has(primaryHost)) {
      favoriteTilesByHost.set(primaryHost, new Map());
    }

    favoriteTilesByHost.forEach((tilesByKey, host) => {
      const section = document.createElement("div");
      section.className = FAVORITES_SECTION_CLASS;
      section.innerHTML = `<div class="tm-favorites-tiles-title">Favoriten</div><div class="${FAVORITES_SECTION_CARDS_CLASS}"></div>`;
      const cards = section.lastElementChild;
      tilesByKey.forEach((tile) => {
        const clone = tile.cloneNode(true);
        clone.classList.add("tm-favorite-clone");
        cards.appendChild(clone);
      });
      if (host === primaryHost) {
        missingFavoriteKeys.forEach((key) => {
          const placeholder = document.createElement("div");
          placeholder.className = "tm-favorite-placeholder";
          placeholder.dataset.nameKey = key;
          placeholder.innerHTML = `<span class="tm-favorite-placeholder-name"></span><span class="tm-favorite-placeholder-hint">Kachel erscheint nach dem Nachladen der Liste (z. B. nach unten scrollen).</span>`;
          placeholder.firstElementChild.textContent = state.discoveredNames[key] || key;
          cards.appendChild(placeholder);
        });
      }
      host.prepend(section);
    });
  }

  function applyPresenceAccentModeClass() {
    const classes = document.documentElement.classList;
    classes.toggle("tm-presence-accent-all", state.presenceAccentMode === "all");
    classes.toggle("tm-presence-accent-selected", state.presenceAccentMode === "selected");
  }

  function renderDiscoveredList() {
    const panel = getPanel();
    const list = panel?.querySelector(".tm-options");
    if (!list) {
      return;
    }

    const filterValue = normalizeName(panel.querySelector(".tm-search").value);
    const selected = new Set(state.selectedNames);
    list.innerHTML = Object.entries(state.discoveredNames)
      .sort((a, b) => a[1].localeCompare(b[1], "de-DE"))
      .filter(([, label]) => normalizeName(label).includes(filterValue))
      .map(([key, label]) => {
        const checked = selected.has(key) ? "checked" : "";
        return `<label class="tm-option"><input type="checkbox" data-name-key="${escapeHtml(key)}" ${checked}><span>${escapeHtml(label)}</span></label>`;
      })
      .join("");

    const count = state.selectedNames.length;
    panel.querySelector(".tm-dropdown-toggle").textContent = `Namen auswählen (${count} Name${count === 1 ? "" : "n"} ausgewählt)`;
  }

  function renderSelectedList() {
    const list = getPanel()?.querySelector(".tm-selected-list");
    if (!list) {
      return;
    }
    const rows = state.selectedNames
      .filter((key) => state.discoveredNames[key])
      .map((key) => {
        const isFavorite = state.favoriteNames.includes(key);
        const favoriteTitle = isFavorite ? "Favorit entfernen" : "Als Favorit markieren";
        const safeKey = escapeHtml(key);
        return `<div class="tm-selected-item"><div class="tm-name-main"><button type="button" class="tm-favorite-toggle ${isFavorite ? "is-favorite" : ""}" data-favorite-key="${safeKey}" title="${favoriteTitle}" aria-label="${favoriteTitle}">${isFavorite ? "★" : "☆"}</button><span>${escapeHtml(state.discoveredNames[key])}</span></div><input type="color" data-color-key="${safeKey}" value="${escapeHtml(getColorForNameKey(key))}"></div>`;
      });

    list.innerHTML = rows.join("") || "<div>Keine Namen ausgewählt</div>";
  }

  function renderPanelLists() {
    renderDiscoveredList();
    renderSelectedList();
  }

  function toggleDropdown(forceOpen) {
    state.dropdownOpen = typeof forceOpen === "boolean" ? forceOpen : !state.dropdownOpen;
    getPanel()?.classList.toggle("tm-dropdown-open", state.dropdownOpen);
  }

  function togglePanel(forceState) {
    state.panelVisible = typeof forceState === "boolean" ? forceState : !state.panelVisible;
    getPanel()?.classList.toggle("open", state.panelVisible);
    if (!state.panelVisible) {
      toggleDropdown(false);
    }
  }

  function toggleFavorite(key) {
    if (!state.selectedNames.includes(key)) {
      return;
    }
    state.favoriteNames = state.favoriteNames.includes(key)
      ? state.favoriteNames.filter((favoriteKey) => favoriteKey !== key)
      : [...state.favoriteNames, key];
    persist("favoriteNames");
    renderSelectedList();
    scheduleHighlighting();
  }

  function setNameSelected(key, isSelected) {
    state.selectedNames = state.selectedNames.filter((selectedKey) => selectedKey !== key);
    if (isSelected) {
      ensureDistinctColorForNameKey(key);
      state.selectedNames.push(key);
    }
    state.favoriteNames = state.favoriteNames.filter((favoriteKey) => state.selectedNames.includes(favoriteKey));
    persist("selectedNames", "favoriteNames", "perNameColors");
    renderPanelLists();
    scheduleHighlighting();
  }

  function clearSelection() {
    if (!window.confirm("Möchtest du wirklich die komplette Auswahl leeren?")) {
      return;
    }
    state.selectedNames = [];
    state.favoriteNames = [];
    persist("selectedNames", "favoriteNames");
    renderPanelLists();
    scheduleHighlighting();
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
          <input id="tm-default-color" type="color" value="${escapeHtml(state.defaultColor)}">
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
          <button type="button" data-action="prefetch-favorites" title="Liste kurz durchscrollen, damit Favoriten-Kacheln nachgeladen werden">Favoriten nachladen</button>
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

    const actions = {
      refresh: () => scheduleDiscoveryUpdate(true),
      "prefetch-favorites": () => {
        scheduleFavoritePrefetch.cancel();
        runFavoritePrefetch(true);
      },
      clear: clearSelection,
      close: () => togglePanel(false),
    };

    panel.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) {
        return;
      }
      if (button.classList.contains("tm-dropdown-toggle")) {
        toggleDropdown();
      } else if (button.classList.contains("tm-favorite-toggle")) {
        toggleFavorite(button.dataset.favoriteKey);
      } else {
        actions[button.dataset.action]?.();
      }
    });

    function handlePerNameColorInput(event) {
      const colorInput = event.target.closest("input[data-color-key]");
      if (!colorInput) {
        return;
      }
      state.perNameColors[colorInput.dataset.colorKey] = colorInput.value;
      persist("perNameColors");
      scheduleHighlighting();
    }

    panel.addEventListener("change", (event) => {
      const checkbox = event.target.closest("input[data-name-key]");
      if (checkbox) {
        setNameSelected(checkbox.dataset.nameKey, checkbox.checked);
      } else {
        handlePerNameColorInput(event);
      }
    });

    panel.addEventListener("input", handlePerNameColorInput);

    defaultColorInput.addEventListener("input", () => {
      state.defaultColor = defaultColorInput.value || DEFAULT_HIGHLIGHT_COLOR;
      persist("defaultColor");
      renderSelectedList();
      scheduleHighlighting();
    });

    modeSelect.addEventListener("change", () => {
      state.collectionMode = modeSelect.value;
      persist("collectionMode");
      scheduleDiscoveryUpdate(true);
    });

    presenceAccentModeSelect.addEventListener("change", () => {
      state.presenceAccentMode = presenceAccentModeSelect.value;
      persist("presenceAccentMode");
      applyPresenceAccentModeClass();
      scheduleHighlighting();
    });

    panel.querySelector(".tm-search").addEventListener("input", renderDiscoveredList);

    document.addEventListener("click", (event) => {
      if (event.target.closest?.(`#${TOGGLE_ID}`)) {
        return;
      }
      // composedPath() is captured at dispatch time, so it still contains the panel
      // even if a panel click handler re-rendered (and detached) the clicked element.
      const path = event.composedPath();
      if (!path.includes(panel)) {
        togglePanel(false);
      } else if (state.dropdownOpen && !path.includes(panel.querySelector(".tm-dropdown"))) {
        toggleDropdown(false);
      }
    });

    document.addEventListener(
      "keydown",
      (event) => {
        // The dropdown can only be open while the panel is visible.
        if (event.key !== "Escape" || !state.panelVisible) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (state.dropdownOpen) {
          toggleDropdown(false);
        } else {
          togglePanel(false);
        }
      },
      true
    );

    renderPanelLists();
  }

  function injectToggleButtonIntoHeader() {
    if (document.getElementById(TOGGLE_ID)) {
      return;
    }
    const menu = document.querySelector(`${HEADER_SELECTOR} .sagehr-dataheader-menu`);
    if (!menu) {
      return;
    }
    const header = menu.closest(HEADER_SELECTOR);
    const wrapper = document.createElement("div");
    wrapper.id = TOGGLE_ID;
    wrapper.innerHTML = `<button type="button" title="Namen markieren">Highlight Namen</button>`;
    wrapper.firstElementChild.addEventListener("click", () => togglePanel());
    if (menu.parentElement === header) {
      header.insertBefore(wrapper, menu);
    } else {
      header.appendChild(wrapper);
    }
  }

  function isRealTileNode(node) {
    return (
      node instanceof Element &&
      !node.closest(`.${FAVORITES_SECTION_CLASS}`) &&
      (node.matches(REAL_TILE_SELECTOR) || Boolean(node.querySelector(REAL_TILE_SELECTOR)))
    );
  }

  function startObserver() {
    new MutationObserver((mutations) => {
      injectToggleButtonIntoHeader();
      const tilesChanged = mutations.some(
        (mutation) => [...mutation.addedNodes].some(isRealTileNode) || [...mutation.removedNodes].some(isRealTileNode)
      );
      if (tilesChanged) {
        scheduleDiscoveryUpdate(state.collectionMode === "visible_only");
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function bootstrap() {
    try {
      loadState();
      injectStyles();
      applyPresenceAccentModeClass();
      createPanel();
      injectToggleButtonIntoHeader();
      refreshDiscoveryIncremental();
      applyHighlighting();
      startObserver();
    } catch (err) {
      console.warn("[mPortal Name Highlighter] bootstrap failed", err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => window.setTimeout(bootstrap, 0), { once: true });
  } else {
    window.setTimeout(bootstrap, 0);
  }
})();
