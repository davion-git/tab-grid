// Tab Grid background worker.
//
// What this does: moves tabs the user already opened into popup windows laid
// out as a grid, mutes all but one tab (browser-level mute), and optionally
// injects a stylesheet that makes the player fill its window.
//
// What it never does, on purpose: open or reload a page, touch network
// requests, run script in the page, talk to the YouTube player, fake focus or
// visibility, send synthetic input, or poll anything. Everything below is
// either a reaction to a browser event or to a click in the popup.

import { buildCells, cellRect, bigCellIndex, cleanLayout, siteKind } from "./layout.js";

const CSS = {
  yt: "css/video-only-youtube.css",
  generic: "css/video-only-generic.css",
};

const DEFAULT_SETTINGS = {
  videoOnlyDefault: true, // new youtube.com tiles start in video-only mode
  noPageChanges: false, // master switch: tile windows only, inject nothing
  singleAudio: true, // only one tile unmuted at a time (off = mute each tile yourself)
  audioFollowsFocus: true,
  wholeScreen: false, // tile over display.bounds instead of workArea (for an auto-hidden taskbar)
  tuckTitleBars: false, // push each window's title bar out of its cell
  layout: { rows: 2, cols: 2, merges: [] },
  displayId: null,
  savedLayouts: {},
};

const EMPTY_STATE = { tiles: [], layout: null, displayId: null, audioTabId: null };

// ---------------------------------------------------------------- storage

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// The current grid lives in session storage so it survives the service
// worker going to sleep, but not a browser restart (windows are gone then).
async function getState() {
  const { tiling } = await chrome.storage.session.get("tiling");
  return tiling ? { ...EMPTY_STATE, ...tiling } : { ...EMPTY_STATE };
}

async function setState(s) {
  await chrome.storage.session.set({ tiling: s });
}

// All work runs one job at a time, so browser events caused by our own moves
// are handled after the move has finished and the state is consistent.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch((e) => console.warn("Tab Grid:", e));
  return run;
}

// ---------------------------------------------------------------- helpers


const tryGet = (p) => p.catch(() => null);

async function pickDisplay(displayId) {
  const displays = await chrome.system.display.getInfo();
  return (
    displays.find((d) => d.id === displayId) ||
    displays.find((d) => d.isPrimary) ||
    displays[0]
  );
}

function sortedTiles(state) {
  return [...state.tiles].sort((a, b) => a.cell - b.cell);
}

async function placeWindow(windowId, rect) {
  const win = await chrome.windows.get(windowId);
  if (win.state !== "normal") await chrome.windows.update(windowId, { state: "normal" });
  await chrome.windows.update(windowId, rect);
}

// The window frame, read off a placed window: on Windows 10/11 a window has
// invisible ~8 px resize borders left, right and bottom (the gaps between
// plain tiles) plus the title bar on top. `border` and `title` are in px.
async function measureFrame(windowId, tabId) {
  const win = await tryGet(chrome.windows.get(windowId));
  const tab = await tryGet(chrome.tabs.get(tabId));
  const fx = win && tab ? win.width - tab.width : NaN;
  const fy = win && tab ? win.height - tab.height : NaN;
  if (!(fx >= 0 && fx <= 40 && fy >= 0 && fy <= 120)) return { border: 0, title: 0 };
  const border = Math.round(fx / 2);
  return { border, title: Math.max(0, fy - border) };
}

// Window bounds whose visible part fills `cell` exactly: the invisible
// borders overlap the neighbours, so tiles meet edge to edge. With `tuck`,
// the title bar sits above the cell too, so the page itself fills the cell
// (top-row bars go off the top of the screen; lower rows' bars lie behind
// the bottom strip of the tile above).
function windowRect(cell, frame, tuck) {
  const b = frame?.border || 0;
  const t = tuck ? frame?.title || 0 : 0;
  return { left: cell.left - b, top: cell.top - t, width: cell.width + 2 * b, height: cell.height + b + t };
}

// For tucked bars every tile must be in front of the tiles below it (a
// lower tile's bar lies behind the bottom strip of the tile above). Raise
// windows from the bottom row up; within a row, `lastTabId` (the tile just
// clicked, if it's in that row) goes last. Raising a window gives it focus,
// so the focus events this causes are ignored and the sound stays put.
let ignoreFocusUntil = 0;
async function stackRows(state, lastTabId = null) {
  const cells = buildCells(state.layout);
  const order = [...state.tiles].sort((a, b) =>
    cells[b.cell].r - cells[a.cell].r || (a.tabId === lastTabId) - (b.tabId === lastTabId)
  );
  ignoreFocusUntil = Date.now() + 2000;
  for (const t of order) await tryGet(chrome.windows.update(t.windowId, { focused: true }));
  ignoreFocusUntil = Date.now() + 500;
}

// Windows always brings a clicked window to the front, so a clicked tile
// below the top row shows its bar over the tile above. A second later, put
// the stack back in order. A one-off timer after the click, not a poll.
let restackTimer = null;
function scheduleRestack(tabId) {
  clearTimeout(restackTimer);
  restackTimer = setTimeout(() => {
    serial(async () => {
      const state = await getState();
      if (state.tuck && state.tiles.length) await stackRows(state, tabId);
    });
  }, 1000);
}

// --------------------------------------------------------------- page CSS

async function removeCss(tabId) {
  for (const file of Object.values(CSS)) {
    await tryGet(chrome.scripting.removeCSS({ target: { tabId }, files: [file], origin: "USER" }));
  }
}

// Remove-then-insert keeps exactly one copy, however often it is called
// (YouTube fires "complete" again on in-page navigation).
async function applyCss(tile, settings) {
  await removeCss(tile.tabId);
  if (settings.noPageChanges || !tile.videoOnly) return;
  const tab = await tryGet(chrome.tabs.get(tile.tabId));
  const file = tab && CSS[siteKind(tab.url)];
  if (!file) return;
  await tryGet(chrome.scripting.insertCSS({ target: { tabId: tile.tabId }, files: [file], origin: "USER" }));
}

// ------------------------------------------------------------------ audio

async function applyAudio(state) {
  if (!(await getSettings()).singleAudio) return;
  for (const t of state.tiles) {
    const muted = t.tabId !== state.audioTabId;
    const tab = await tryGet(chrome.tabs.get(t.tabId));
    if (tab && tab.mutedInfo?.muted !== muted) await tryGet(chrome.tabs.update(t.tabId, { muted }));
  }
}

// With "only one tile plays sound" off: flips one tile's own mute.
async function toggleMute(tabId) {
  const tab = await tryGet(chrome.tabs.get(tabId));
  if (tab) await tryGet(chrome.tabs.update(tabId, { muted: !tab.mutedInfo?.muted }));
  return getState();
}

async function setAudio(tabId) {
  const state = await getState();
  if (!state.tiles.some((t) => t.tabId === tabId)) return state;
  state.audioTabId = tabId;
  await setState(state);
  await applyAudio(state);
  return state;
}

// ----------------------------------------------------------------- tiling

async function tile(tabIds, layoutIn, displayId) {
  const settings = await getSettings();
  const layout = cleanLayout(layoutIn || settings.layout);
  const cells = buildCells(layout);
  const display = await pickDisplay(displayId ?? settings.displayId);
  const area = settings.wholeScreen ? display.bounds : display.workArea;
  const prev = await getState();
  let frame = null;

  const chosen = [...new Set(tabIds)].slice(0, cells.length);
  const leaving = prev.tiles.filter((t) => !chosen.includes(t.tabId));
  const tiles = [];

  for (let i = 0; i < chosen.length; i++) {
    const tabId = chosen[i];
    const tab = await tryGet(chrome.tabs.get(tabId));
    if (!tab) continue;
    const cell = cellRect(cells[i], layout, area);
    const rect = windowRect(cell, frame, settings.tuckTitleBars);
    const old = prev.tiles.find((t) => t.tabId === tabId);
    const win = await chrome.windows.get(tab.windowId, { populate: true });

    let windowId;
    if (win.type === "popup" && win.tabs.length === 1) {
      // Already alone in a popup window (a tile from before): just move it.
      windowId = win.id;
      await placeWindow(windowId, rect);
    } else {
      // chrome.windows.create({tabId}) moves the existing tab. It does not
      // reload it: the page, its player and its playback carry on as they are.
      const created = await chrome.windows.create({ tabId, type: "popup", focused: false, ...rect });
      windowId = created.id;
      await placeWindow(windowId, rect); // some window managers ignore bounds on create
    }
    if (!frame) {
      frame = await measureFrame(windowId, tabId);
      await placeWindow(windowId, windowRect(cell, frame, settings.tuckTitleBars));
    }

    tiles.push({
      tabId,
      windowId,
      cell: i,
      videoOnly: old ? old.videoOnly : siteKind(tab.url) !== "none" && settings.videoOnlyDefault,
      homeWindowId: old ? old.homeWindowId : win.type === "normal" ? win.id : null,
    });
  }

  if (leaving.length) await putBack(leaving, null);

  const state = {
    tiles,
    layout,
    displayId: display.id,
    area,
    frame,
    tuck: settings.tuckTitleBars,
    audioTabId: tiles.some((t) => t.tabId === prev.audioTabId) ? prev.audioTabId : tiles[0]?.tabId ?? null,
  };
  await setState(state);
  await setSettings({ layout, displayId: display.id });
  await applyAudio(state);
  for (const t of tiles) await applyCss(t, settings);

  if (state.tuck) await stackRows(state, state.audioTabId);
  else {
    const audioTile = tiles.find((t) => t.tabId === state.audioTabId);
    if (audioTile) await tryGet(chrome.windows.update(audioTile.windowId, { focused: true }));
  }
  return state;
}

// Moves tiles back into one normal window: the window most of them came
// from if it still exists, otherwise a new one.
async function putBack(tiles, activeTabId) {
  const alive = [];
  for (const t of tiles) if (await tryGet(chrome.tabs.get(t.tabId))) alive.push(t);
  for (const t of alive) await removeCss(t.tabId);
  if (!alive.length) return;

  const counts = new Map();
  for (const t of alive) if (t.homeWindowId != null) counts.set(t.homeWindowId, (counts.get(t.homeWindowId) || 0) + 1);
  let targetId = null;
  for (const [id] of [...counts].sort((a, b) => b[1] - a[1])) {
    const w = await tryGet(chrome.windows.get(id));
    if (w && w.type === "normal") { targetId = id; break; }
  }

  let rest = alive;
  if (targetId == null) {
    const w = await chrome.windows.create({ tabId: alive[0].tabId, type: "normal", focused: true });
    targetId = w.id;
    rest = alive.slice(1);
  }
  for (const t of rest) await chrome.tabs.move(t.tabId, { windowId: targetId, index: -1 });

  const active = alive.find((t) => t.tabId === activeTabId) || alive[0];
  await tryGet(chrome.tabs.update(active.tabId, { active: true }));
  await tryGet(chrome.windows.update(targetId, { focused: true }));
}

async function untile() {
  const state = await getState();
  await setState({ ...EMPTY_STATE });
  // Mute states are left as they are: only the audio tile keeps playing sound.
  await putBack(sortedTiles(state), state.audioTabId);
  return { ...EMPTY_STATE };
}

// Moves one tile's tab back into a normal window (no reload). The other
// tiles stay where they are. If it had the sound it keeps it, and the next
// tile you click takes over.
async function sendBack(tabId) {
  const state = await getState();
  const t = state.tiles.find((x) => x.tabId === tabId);
  if (!t) return state;
  state.tiles = state.tiles.filter((x) => x !== t);
  if (state.audioTabId === tabId) state.audioTabId = null;
  await setState(state);
  await putBack([t], tabId);
  return state;
}

async function setVideoOnly(tabId, on) {
  const state = await getState();
  const t = state.tiles.find((x) => x.tabId === tabId);
  if (!t) return state;
  t.videoOnly = !!on;
  await setState(state);
  await applyCss(t, await getSettings());
  return state;
}

async function focusTile(tile) {
  if (!tile) return;
  await tryGet(chrome.windows.update(tile.windowId, { focused: true }));
  await setAudio(tile.tabId);
}

// Swaps a tile (default: the one with audio) with whatever sits in the
// largest merged cell.
async function swapIntoBig(tabId) {
  const state = await getState();
  if (!state.layout) return state;
  const cells = buildCells(state.layout);
  const big = bigCellIndex(cells);
  if (big < 0) return state;
  const src = state.tiles.find((t) => t.tabId === (tabId ?? state.audioTabId));
  if (!src || src.cell === big) return state;
  const dst = state.tiles.find((t) => t.cell === big);
  const area = state.area || (await pickDisplay(state.displayId)).workArea;
  if (dst) dst.cell = src.cell;
  src.cell = big;
  await setState(state);
  for (const t of [src, dst]) {
    if (t) await tryGet(placeWindow(t.windowId, windowRect(cellRect(cells[t.cell], state.layout, area), state.frame, state.tuck)));
  }
  await focusTile(src);
  return getState();
}

// Drops tiles whose tab was closed, or that the user dragged into another
// window. Runs after events, never on a timer.
async function reconcile() {
  const state = await getState();
  if (!state.tiles.length) return;
  const keep = [];
  for (const t of state.tiles) {
    const tab = await tryGet(chrome.tabs.get(t.tabId));
    if (!tab) continue;
    const win = await tryGet(chrome.windows.get(tab.windowId, { populate: true }));
    if (win && win.type === "popup" && win.tabs.length === 1) {
      keep.push({ ...t, windowId: win.id });
    } else {
      await removeCss(t.tabId); // left the grid: give it its normal page back
    }
  }
  if (keep.length === state.tiles.length && keep.every((t, i) => t.windowId === state.tiles[i].windowId)) return;
  state.tiles = keep;
  if (!keep.some((t) => t.tabId === state.audioTabId)) {
    state.audioTabId = sortedTiles(state)[0]?.tabId ?? null;
    await setState(state);
    await applyAudio(state);
  } else {
    await setState(state);
  }
}

// ----------------------------------------------------------------- events

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE || Date.now() < ignoreFocusUntil) return;
  serial(async () => {
    const settings = await getSettings();
    const state = await getState();
    const t = state.tiles.find((x) => x.windowId === windowId);
    if (!t) return;
    if (state.tuck && buildCells(state.layout)[t.cell].r > 0) scheduleRestack(t.tabId);
    if (settings.singleAudio && settings.audioFollowsFocus && t.tabId !== state.audioTabId) await setAudio(t.tabId);
  });
});

chrome.windows.onRemoved.addListener(() => serial(reconcile));
chrome.tabs.onRemoved.addListener(() => serial(reconcile));
chrome.tabs.onAttached.addListener(() => serial(reconcile));

// A full reload drops injected CSS; put it back once the page has loaded.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  serial(async () => {
    const state = await getState();
    const t = state.tiles.find((x) => x.tabId === tabId);
    if (t) await applyCss(t, await getSettings());
  });
});

chrome.commands.onCommand.addListener((command) => {
  serial(async () => {
    const state = await getState();
    const order = sortedTiles(state);
    if (!order.length) return;
    if (command.startsWith("tile-")) return focusTile(order[Number(command.slice(5)) - 1]);
    if (command === "swap-big") return swapIntoBig();
    if (command === "send-back") {
      const focused = await tryGet(chrome.windows.getLastFocused());
      const t = state.tiles.find((x) => x.windowId === focused?.id);
      return t && sendBack(t.tabId);
    }
    const cur = Math.max(0, order.findIndex((t) => t.tabId === state.audioTabId));
    const step = command === "next-tile" ? 1 : command === "prev-tile" ? -1 : 0;
    if (step) return focusTile(order[(cur + step + order.length) % order.length]);
  });
});

// Messages from the popup.
const handlers = {
  tile: (m) => tile(m.tabIds, m.layout, m.displayId),
  retile: async (m) => {
    const state = await getState();
    return tile(sortedTiles(state).map((t) => t.tabId), m.layout, m.displayId);
  },
  untile: () => untile(),
  sendBack: (m) => sendBack(m.tabId),
  setAudio: (m) => setAudio(m.tabId),
  toggleMute: (m) => toggleMute(m.tabId),
  focusTile: async (m) => {
    const state = await getState();
    await focusTile(state.tiles.find((t) => t.tabId === m.tabId));
    return getState();
  },
  setVideoOnly: (m) => setVideoOnly(m.tabId, m.on),
  swapBig: (m) => swapIntoBig(m.tabId),
  setSettings: async (m) => {
    const before = await getSettings();
    const settings = await setSettings(m.patch);
    const state = await getState();
    if (before.noPageChanges !== settings.noPageChanges) for (const t of state.tiles) await applyCss(t, settings);
    if (settings.audioFollowsFocus && !before.audioFollowsFocus) await applyAudio(state);
    if (settings.singleAudio && !before.singleAudio) await applyAudio(state);
    if (!settings.singleAudio && before.singleAudio) {
      // Hear them all: unmute every tile; mute any of them from the popup.
      for (const t of state.tiles) await tryGet(chrome.tabs.update(t.tabId, { muted: false }));
    }
    const placement = (x) => `${x.wholeScreen}|${x.tuckTitleBars}`;
    if (state.tiles.length && placement(before) !== placement(settings)) {
      await tile(sortedTiles(state).map((t) => t.tabId), state.layout, state.displayId);
    }
    return settings;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  serial(() => h(msg)).then(
    (result) => reply({ ok: true, result }),
    (e) => reply({ ok: false, error: String(e?.message || e) })
  );
  return true;
});
