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

import { buildCells, cellRect, bigCellIndex, cleanLayout, siteKind, sitePattern, growLayout } from "./layout.js";
import { markLargestPlayer } from "./detect.js";

const CSS = {
  yt: "css/video-only-youtube.css",
  generic: "css/video-only-generic.css",
  marked: "css/video-only-marked.css", // sites the user allowed: the player detect.js found
  fill: "css/fill.css", // added on top of either when "Fill each tile" is on
};

const DEFAULT_SETTINGS = {
  videoOnlyDefault: true, // new youtube.com tiles start in video-only mode
  noPageChanges: false, // master switch: tile windows only, inject nothing
  singleAudio: true, // only one tile unmuted at a time (off = mute each tile yourself)
  audioFollowsFocus: true,
  clickToMain: true, // in a layout with a main cell, clicking a small tile swaps it in
  fillTiles: false, // crop the picture to fill each tile instead of black bars
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
// Focus changes Tab Grid causes itself (raising a window gives it focus)
// must not count as clicks. Each window it raises is remembered for a
// moment and its next focus event skipped; the user's clicks always count.
const ownFocus = new Map(); // windowId -> expiry time
async function raise(windowId) {
  ownFocus.set(windowId, Date.now() + 1500);
  await tryGet(chrome.windows.update(windowId, { focused: true }));
}
function isOwnFocus(windowId) {
  const until = ownFocus.get(windowId);
  ownFocus.delete(windowId);
  return until > Date.now();
}
async function stackRows(state, lastTabId = null) {
  const cells = buildCells(state.layout);
  const order = [...state.tiles].sort((a, b) =>
    !!cells[a.cell].inset - !!cells[b.cell].inset ||
    cells[b.cell].r - cells[a.cell].r ||
    (a.tabId === lastTabId) - (b.tabId === lastTabId)
  );
  for (const t of order) await raise(t.windowId);
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
    await tryGet(chrome.scripting.removeCSS({ target: { tabId, allFrames: true }, files: [file], origin: "USER" })
      .catch(() => chrome.scripting.removeCSS({ target: { tabId }, files: [file], origin: "USER" })));
  }
}

// Remove-then-insert keeps exactly one copy, however often it is called
// (YouTube fires "complete" again on in-page navigation).
// What happened the last time video-only was applied to each tab, so the
// popup can show it instead of failing silently: "on", "off",
// "needs-permission" (Chrome isn't letting Tab Grid into that site: never
// allowed, or access held back after an update) or "error: ...".
async function setCssStatus(tabId, status) {
  const { cssStatus = {} } = await chrome.storage.session.get("cssStatus");
  if (cssStatus[tabId] === status) return;
  cssStatus[tabId] = status;
  await chrome.storage.session.set({ cssStatus });
}

const retriedFind = new Set();

async function applyCss(tile, settings) {
  await removeCss(tile.tabId);
  if (settings.noPageChanges || !tile.videoOnly) return setCssStatus(tile.tabId, "off");
  const tab = await tryGet(chrome.tabs.get(tile.tabId));
  if (!tab) return;
  const kind = siteKind(tab.url);
  let file = { yt: CSS.yt, generic: CSS.marked, other: CSS.marked }[kind];
  if (!file) return setCssStatus(tile.tabId, "off");
  if (!(await tryGet(chrome.permissions.contains({ origins: [sitePattern(tab.url)] })))) {
    return setCssStatus(tile.tabId, "needs-permission");
  }
  // On sites Tab Grid doesn't know, look in every frame of the page: many
  // put the whole page, or the player, in a frame from another site.
  const allFrames = kind === "other";
  let frameOnly = false;
  if (kind !== "yt") {
    // Find the page's player box first (see detect.js).
    const runs = await chrome.scripting.executeScript({ target: { tabId: tile.tabId, allFrames }, func: markLargestPlayer }).catch(() => []);
    const hits = runs.filter((r) => r.result);
    const run = hits.find((r) => r.frameId === 0) || hits[0];
    // The top page's "player" is a frame, and nothing answered from that
    // frame's site: the real player is in a frame Tab Grid can't see into.
    const top = hits.find((r) => r.frameId === 0)?.result;
    frameOnly = allFrames && !!top?.frameFrom && !hits.some((r) => r.frameId !== 0 && r.result.page === top.frameFrom);
    if (!run?.result && kind === "generic") {
      // A known site whose player wasn't found: lift any <video> instead.
      file = CSS.generic;
    } else if (!run?.result) {
      // Players often appear after the page has loaded: look once more.
      if (!retriedFind.has(tile.tabId)) {
        retriedFind.add(tile.tabId);
        setTimeout(() => serial(async () => {
          const t = (await getState()).tiles.find((x) => x.tabId === tile.tabId);
          if (t) await applyCss(t, await getSettings());
        }), 4000);
      }
      return setCssStatus(tile.tabId, "error: no video player found on this page yet (start it playing, then switch Video only off and on)");
    }
    retriedFind.delete(tile.tabId);
  }
  try {
    const insert = (files) => chrome.scripting.insertCSS({ target: { tabId: tile.tabId, allFrames }, files, origin: "USER" })
      .catch(() => chrome.scripting.insertCSS({ target: { tabId: tile.tabId }, files, origin: "USER" }));
    await insert([file]);
    if (settings.fillTiles) await insert([CSS.fill]);
    await setCssStatus(tile.tabId, frameOnly ? "frame-only" : "on");
  } catch (e) {
    await setCssStatus(tile.tabId, `error: ${e?.message || e}`);
  }
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
      videoOnly: old ? old.videoOnly : ["yt", "generic"].includes(siteKind(tab.url)) && settings.videoOnlyDefault,
      homeWindowId: old ? old.homeWindowId : win.type === "normal" ? win.id : null,
    });
  }

  if (leaving.length) await putBack(leaving, null);
  if (!layout.pip) await closeHolder();

  const state = {
    tiles,
    layout,
    displayId: display.id,
    area,
    frame,
    tuck: settings.tuckTitleBars,
    audioTabId: tiles.some((t) => t.tabId === prev.audioTabId) ? prev.audioTabId : tiles[0]?.tabId ?? null,
  };
  // With a main cell, the game in it starts with the sound.
  const mainTile = tiles.find((t) => t.cell === bigCellIndex(cells));
  if (mainTile && settings.singleAudio) state.audioTabId = mainTile.tabId;
  await setState(state);
  await setSettings({ layout, displayId: display.id });
  await applyAudio(state);
  for (const t of tiles) await applyCss(t, settings);

  if (layout.pip) {
    const main = tiles.find((t) => cells[t.cell].main);
    if (main) await tryGet(placeCornerTile(main, state, area));
    await cornerRestack(state);
  } else if (state.tuck) await stackRows(state, state.audioTabId);
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
  await closeHolder();
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

// A small window that asks Chrome for one site's permission. Asked from the
// popup itself, Chrome's prompt can vanish when the popup closes.
async function openAllowWindow(tabId) {
  const area = (await pickDisplay(null)).workArea;
  const width = 440, height = 240;
  await chrome.windows.create({
    url: chrome.runtime.getURL(`allow.html?tab=${tabId}`), type: "popup", focused: true, width, height,
    left: area.left + Math.round((area.width - width) / 2), top: area.top + Math.round((area.height - height) / 2),
  });
}

// "Paste a link": opens the address the user pasted in a new window and
// adds it to the grid. A direct video file plays in Tab Grid's own player
// page. Only ever done on the user's click in the popup.
const MEDIA_FILE = /\.(mp4|m4v|webm|mov|ogv|m3u8)$/i;
async function openLink(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { throw new Error("That doesn't look like a web address."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http:// and https:// links can be opened.");
  const url = MEDIA_FILE.test(u.pathname) ? chrome.runtime.getURL(`player.html?src=${encodeURIComponent(u.href)}`) : u.href;
  const state = await getState();
  const settings = await getSettings();
  const w = await chrome.windows.create({ url, type: "popup", focused: true, width: 960, height: 540 });
  const tabId = w.tabs[0].id;
  const tabIds = [...sortedTiles(state).map((t) => t.tabId), tabId];
  // A full layout grows to the next size that fits (16 tiles at most).
  const layout = growLayout(state.tiles.length ? state.layout : settings.layout, tabIds.length);
  const next = await tile(tabIds, layout, state.displayId ?? undefined);
  if (!next.tiles.some((t) => t.tabId === tabId)) {
    throw new Error("Opened, but the grid is full (16 tiles). It's in its own window.");
  }
  // A pasted page: show just its player straight away, asking for the
  // site's permission if Tab Grid doesn't have it yet.
  if (siteKind(url) === "other") {
    await setVideoOnly(tabId, true);
    const { cssStatus = {} } = await chrome.storage.session.get("cssStatus");
    if (cssStatus[tabId] === "needs-permission") await openAllowWindow(tabId);
  }
  return getState();
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
  const state = await getState();
  if (state.layout?.pip) {
    // Bringing either window forward would cover the corner one; Alt+N
    // on the corner game swaps it in instead.
    if (buildCells(state.layout)[tile.cell].inset) await cornerSwap();
    return;
  }
  await tryGet(chrome.windows.update(tile.windowId, { focused: true }));
  await setAudio(tile.tabId);
}

// Swaps a tile (default: the one with audio) with whatever sits in the
// largest merged cell.
async function swapIntoBig(tabId) {
  const state = await getState();
  if (!state.layout) return state;
  if (state.layout.pip) return cornerSwap();
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

// ------------------------------------------------------------- Corner layout
// Windows always puts the active window in front. For the corner game to
// stay on top of the big one while a click on it can still be seen, neither
// game may be the active window. So a small "holder" window of this
// extension's own (holder.html, a blank black page, no website) is kept
// active, on another monitor if there is one. Chrome won't place a window
// less than half on a screen, so with one monitor it sits half off the
// bottom-left edge.

async function holderId() {
  const { holderWindowId } = await chrome.storage.session.get("holderWindowId");
  return holderWindowId ?? null;
}

async function ensureHolder(state) {
  const id = await holderId();
  if (id != null && (await tryGet(chrome.windows.get(id)))) return id;
  const displays = await chrome.system.display.getInfo();
  const other = displays.find((d) => d.id !== state.displayId);
  const width = 240, height = 100;
  let left, top;
  if (other) {
    const a = other.workArea;
    left = a.left + a.width - width - 16;
    top = a.top + a.height - height - 16;
  } else {
    const a = state.area;
    left = a.left - width / 2 + 8;
    top = a.top + a.height - height;
  }
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL("holder.html"), type: "popup", left, top, width, height, focused: false,
  });
  await chrome.storage.session.set({ holderWindowId: w.id });
  return w.id;
}

async function closeHolder() {
  const id = await holderId();
  await chrome.storage.session.remove("holderWindowId");
  if (id != null) await tryGet(chrome.windows.remove(id));
}

// Big game at the back, the corner game on top of it, the holder active.
async function cornerRestack(state) {
  const cells = buildCells(state.layout);
  const inset = state.tiles.find((t) => cells[t.cell]?.inset);
  const holder = await ensureHolder(state);
  if (inset) await raise(inset.windowId);
  await raise(holder);
}

// With "Hide title bars" the big game goes full screen: no title bar, and no
// limit on height (a normal window can't be taller than the screen plus its
// frame, which left a strip at the bottom).
async function placeCornerTile(t, state, area) {
  const cell = buildCells(state.layout)[t.cell];
  if (cell.main && state.tuck) {
    const win = await tryGet(chrome.windows.get(t.windowId));
    if (win?.state !== "fullscreen") {
      await placeWindow(t.windowId, cellRect(cell, state.layout, area)); // onto the right monitor first
      await chrome.windows.update(t.windowId, { state: "fullscreen" });
    }
    return;
  }
  await placeWindow(t.windowId, windowRect(cellRect(cell, state.layout, area), state.frame, state.tuck));
}

let swapping = false;
let lastCornerSwap = 0;

// Swaps the two games; the sound goes with the big one.
async function cornerSwap() {
  const state = await getState();
  const cells = buildCells(state.layout);
  const main = state.tiles.find((t) => cells[t.cell]?.main);
  const inset = state.tiles.find((t) => cells[t.cell]?.inset);
  if (!main || !inset) return state;
  const area = state.area || (await pickDisplay(state.displayId)).workArea;
  [main.cell, inset.cell] = [inset.cell, main.cell];
  if ((await getSettings()).singleAudio) state.audioTabId = inset.tabId;
  await setState(state);
  // Leaving and entering full screen can activate windows by themselves;
  // ignore focus changes until both windows are in place.
  swapping = true;
  try {
    await tryGet(placeCornerTile(main, state, area)); // old big game into the corner
    await tryGet(placeCornerTile(inset, state, area)); // old corner game fills the screen
  } finally {
    swapping = false;
  }
  lastCornerSwap = Date.now();
  await applyAudio(state);
  await cornerRestack(state);
  // Full screen can finish settling after that and cover the corner game;
  // check the stack once more when it has.
  // Skipped if a game is active by then: that's a click waiting to be handled.
  setTimeout(() => serial(async () => {
    const s = await getState();
    if (!s.layout?.pip) return;
    const active = await tryGet(chrome.windows.getLastFocused());
    if (active?.focused && s.tiles.some((t) => t.windowId === active.id)) return;
    await cornerRestack(s);
  }), 900);
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
  if (windowId === chrome.windows.WINDOW_ID_NONE || swapping) return;
  const own = isOwnFocus(windowId);
  serial(async () => {
    const settings = await getSettings();
    const state = await getState();
    const t = state.tiles.find((x) => x.windowId === windowId);
    if (!t) return;
    const cells = buildCells(state.layout);
    if (state.layout.pip) {
      // Decided by which window is active now, not by remembering what
      // Tab Grid did: when it raises the corner game it makes the helper
      // active straight after, so by now that one is active; after a real
      // click the clicked game still is.
      const active = await tryGet(chrome.windows.getLastFocused());
      if (!active?.focused || active.id !== windowId) return;
      // Clicking the corner game swaps it in. Clicking the big game brought
      // it in front of the corner one, so put the corner one back on top.
      // A second swap right after one is a stray event, not a click.
      const swapNow = cells[t.cell].inset && settings.clickToMain && state.tiles.length > 1 && Date.now() - lastCornerSwap > 400;
      if (swapNow) await cornerSwap();
      else await cornerRestack(state);
      return;
    }
    if (own) return;
    const big = bigCellIndex(cells);
    if (settings.clickToMain && big >= 0 && t.cell !== big) {
      await swapIntoBig(t.tabId); // also gives it the sound
      if (state.tuck) scheduleRestack(t.tabId);
      return;
    }
    if (state.tuck && cells[t.cell].r > 0) scheduleRestack(t.tabId);
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

// The popup asks Chrome for a site's permission when video-only is switched
// on there; the popup may close while Chrome's prompt is up, so the
// stylesheet is applied from here once the permission arrives.
chrome.permissions.onAdded.addListener(() => {
  serial(async () => {
    const state = await getState();
    const settings = await getSettings();
    for (const t of state.tiles) await applyCss(t, settings);
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
  openLink: (m) => openLink(m.url),
  sendBack: (m) => sendBack(m.tabId),
  setAudio: (m) => setAudio(m.tabId),
  toggleMute: (m) => toggleMute(m.tabId),
  focusTile: async (m) => {
    const state = await getState();
    await focusTile(state.tiles.find((t) => t.tabId === m.tabId));
    return getState();
  },
  setVideoOnly: (m) => setVideoOnly(m.tabId, m.on),
  openAllow: (m) => openAllowWindow(m.tabId),
  swapBig: (m) => swapIntoBig(m.tabId),
  setSettings: async (m) => {
    const before = await getSettings();
    const settings = await setSettings(m.patch);
    const state = await getState();
    if (before.noPageChanges !== settings.noPageChanges || before.fillTiles !== settings.fillTiles) {
      for (const t of state.tiles) await applyCss(t, settings);
    }
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
