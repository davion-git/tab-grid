import { PRESETS, MAX, VIDEO_URLS, cleanLayout, buildCells, bigCellIndex, describeLayout, siteKind, sameLayout, sitePattern } from "./layout.js";

// The known video sites, plus any other tab Chrome reports as playing sound
// (so streams on any site show up without Tab Grid reading the page), plus
// tabs already tiled. "Show all tabs" lists every ordinary web tab.
async function queryTabs() {
  const all = await chrome.tabs.query({ url: ["https://*/*", "http://*/*"] });
  if ($("showAll").checked) return all;
  const known = new Set((await chrome.tabs.query({ url: VIDEO_URLS })).map((t) => t.id));
  const { tiling } = await chrome.storage.session.get("tiling");
  const tiled = new Set((tiling?.tiles || []).map((t) => t.tabId));
  return all.filter((t) => known.has(t.id) || t.audible || tiled.has(t.id));
}

const $ = (id) => document.getElementById(id);
const WARN_ABOVE = 9;

let settings = null;
let state = null;
let tabs = [];
let selected = []; // tab ids in the order they were picked = cell order
let layout = { rows: 2, cols: 2, merges: [] };
let displays = [];

async function send(type, extra = {}) {
  $("error").hidden = true;
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) {
    $("error").textContent = res?.error || "Something went wrong.";
    $("error").hidden = false;
    return null;
  }
  return res.result;
}

async function load() {
  settings = (await chrome.storage.local.get("settings")).settings || {};
  settings = { videoOnlyDefault: true, noPageChanges: false, singleAudio: true, audioFollowsFocus: true, clickToMain: true, wholeScreen: false, tuckTitleBars: false, savedLayouts: {}, ...settings };
  state = (await chrome.storage.session.get("tiling")).tiling || { tiles: [] };
  layout = cleanLayout(state.tiles.length && state.layout ? state.layout : settings.layout || layout);
  $("showAll").checked = !!settings.showAll;
  tabs = await queryTabs();

  $("videoOnlyDefault").checked = settings.videoOnlyDefault;
  $("noPageChanges").checked = settings.noPageChanges;
  $("singleAudio").checked = settings.singleAudio;
  $("audioFollowsFocus").checked = settings.audioFollowsFocus;
  $("clickToMain").checked = settings.clickToMain;
  $("audioFollowsFocus").disabled = !settings.singleAudio;
  $("wholeScreen").checked = settings.wholeScreen;
  $("tuckTitleBars").checked = settings.tuckTitleBars;

  displays = await chrome.system.display.getInfo();
  $("display").replaceChildren(
    ...displays.map((d, i) => {
      const o = new Option(
        `${d.name || "Display " + (i + 1)} — ${d.workArea.width}×${d.workArea.height}${d.isPrimary ? " (main)" : ""}`,
        d.id
      );
      o.selected = settings.displayId ? d.id === settings.displayId : d.isPrimary;
      return o;
    })
  );

  for (const sel of [$("rows"), $("cols")]) {
    sel.replaceChildren(...Array.from({ length: MAX }, (_, i) => new Option(String(i + 1), i + 1)));
  }
  $("presets").replaceChildren(
    ...PRESETS.map((p) => {
      const b = document.createElement("button");
      b.textContent = p.label;
      b.dataset.id = p.id;
      b.onclick = () => setLayout(p);
      return b;
    })
  );
  renderAll();
}

// When the taskbar is always shown, Windows keeps it on top of the tiles, so
// "Use the whole screen" only pays off with the taskbar set to auto-hide.
function renderTaskbarHint() {
  const d = displays.find((x) => x.id === $("display").value) || displays[0];
  const reserved = d ? d.bounds.height - d.workArea.height + (d.bounds.width - d.workArea.width) : 0;
  const hint = $("taskbarHint");
  hint.hidden = !(reserved > 0 && $("wholeScreen").checked);
  hint.textContent = `The taskbar is taking ${reserved} px of this screen and will sit on top of the bottom tiles. ` +
    "To get it out of the way, turn on Windows Settings → Personalization → Taskbar → Taskbar behaviors → “Automatically hide the taskbar”.";
}

function renderAll() {
  renderTaskbarHint();
  renderTiles();
  renderTabs();
  renderLayout();
  renderSaved();
  renderWarning();
}

// ------------------------------------------------------------- tiles

function renderTiles() {
  const tiles = [...(state.tiles || [])].sort((a, b) => a.cell - b.cell);
  $("tiled").hidden = !tiles.length;
  if (!tiles.length) return;
  $("tiledSummary").textContent = `${tiles.length} · ${describeLayout(state.layout)}`;
  const big = bigCellIndex(buildCells(state.layout));
  $("swapBig").disabled = big < 0 || !tiles.some((t) => t.tabId === state.audioTabId && t.cell !== big);

  $("tileList").replaceChildren(
    ...tiles.map((t, i) => {
      const tab = tabs.find((x) => x.id === t.tabId);
      const li = document.createElement("li");
      const n = document.createElement("span");
      const single = settings.singleAudio;
      const hasSound = single ? t.tabId === state.audioTabId : !tab?.mutedInfo?.muted;
      n.className = "badge" + (hasSound ? " sel" : "");
      n.textContent = i + 1;
      n.title = t.cell === big ? "Big cell" : `Cell ${t.cell + 1}`;
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = (t.cell === big ? "★ " : "") + (tab?.title || "Tab " + t.tabId);
      title.title = tab?.title || "";

      const audio = document.createElement("button");
      audio.className = "icon-btn" + (hasSound ? " on" : "");
      audio.textContent = hasSound ? "🔊" : "🔇";
      audio.title = single ? "Play this tile's sound (mutes the others)" : "Mute or unmute this tile";
      audio.onclick = async () => {
        await send(single ? "setAudio" : "toggleMute", { tabId: t.tabId });
        refresh();
      };

      const vo = document.createElement("button");
      vo.className = "icon-btn" + (t.videoOnly && !settings.noPageChanges ? " on" : "");
      vo.textContent = "Video only";
      const kind = siteKind(tab?.url);
      vo.disabled = settings.noPageChanges || kind === "none";
      vo.title = settings.noPageChanges ? "Off: “No page changes” is on"
        : kind === "none" ? "Not available for this page"
        : kind === "other" ? "Makes the video fill the window. The first time on a site, Chrome asks to allow Tab Grid there"
        : kind === "generic" ? "Makes the video fill the window; covers the site's own player controls"
        : "Toggle video-only for this tile";
      if (kind === "none") vo.classList.remove("on");
      vo.onclick = () => {
        const on = !t.videoOnly;
        // Ask for this one site first, while the click still counts as a
        // user gesture. Chrome's prompt may close this popup; the
        // background applies the stylesheet when the permission arrives.
        const asked = on && kind === "other"
          ? chrome.permissions.request({ origins: [sitePattern(tab.url)] }).catch(() => false)
          : Promise.resolve(true);
        send("setVideoOnly", { tabId: t.tabId, on }).then((s) => { state = s || state; renderTiles(); });
        asked.then((granted) => {
          if (!granted) send("setVideoOnly", { tabId: t.tabId, on: false }).then((s) => { state = s || state; renderTiles(); });
        });
      };

      const go = document.createElement("button");
      go.className = "icon-btn";
      go.textContent = "Show";
      go.title = "Bring this tile to the front (moves audio there)";
      go.onclick = async () => { state = (await send("focusTile", { tabId: t.tabId })) || state; renderTiles(); };

      const back = document.createElement("button");
      back.className = "icon-btn";
      back.textContent = "↩ Tab";
      back.title = "Send back to a normal tab (no reload)";
      back.onclick = async () => { await send("sendBack", { tabId: t.tabId }); refresh(); };

      li.append(n, title, audio, vo, go, back);
      return li;
    })
  );
}

// -------------------------------------------------------------- tabs

function renderTabs() {
  selected = selected.filter((id) => tabs.some((t) => t.id === id));
  $("noTabs").hidden = tabs.length > 0;
  $("tabCount").textContent = tabs.length ? `${tabs.length} open` : "";
  $("tileAll").disabled = !tabs.length;
  $("tileSelected").disabled = !selected.length;
  $("tileSelected").textContent = selected.length ? `Tile selected (${selected.length})` : "Tile selected";

  const tiledIds = new Set((state.tiles || []).map((t) => t.tabId));
  $("tabList").replaceChildren(
    ...tabs.map((tab) => {
      const li = document.createElement("li");
      li.style.cursor = "pointer";
      const pos = selected.indexOf(tab.id);
      const badge = document.createElement("span");
      badge.className = "badge" + (pos >= 0 ? " sel" : "");
      badge.textContent = pos >= 0 ? pos + 1 : "";
      const icon = document.createElement("img");
      icon.src = tab.favIconUrl || "icons/16.png";
      icon.alt = "";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = tab.title || tab.url;
      title.title = tab.url;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = [tiledIds.has(tab.id) ? "tiled" : "", tab.audible ? "playing" : ""].filter(Boolean).join(" · ");
      li.append(badge, icon, title, tag);
      li.onclick = () => {
        selected = pos >= 0 ? selected.filter((id) => id !== tab.id) : [...selected, tab.id];
        renderTabs();
        renderWarning();
      };
      return li;
    })
  );
}

// ------------------------------------------------------------ layout

function setLayout(l) {
  layout = cleanLayout(l);
  renderLayout();
  renderWarning();
  chrome.storage.local.get("settings").then(({ settings: s }) =>
    chrome.storage.local.set({ settings: { ...(s || {}), layout } })
  );
}

function renderLayout() {
  $("rows").value = layout.rows;
  $("cols").value = layout.cols;
  for (const b of $("presets").children) {
    const p = PRESETS.find((x) => x.id === b.dataset.id);
    b.classList.toggle("on", sameLayout(p, layout));
  }
  const cells = buildCells(layout);
  $("grid").classList.toggle("pip", !!layout.pip);
  $("layoutSummary").textContent = `${cells.length} cell${cells.length === 1 ? "" : "s"}`;
  const g = $("grid");
  g.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;
  g.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
  const big = bigCellIndex(cells);
  g.replaceChildren(
    ...cells.map((c, i) => {
      const d = document.createElement("div");
      d.className = "cell" + (c.rs * c.cs > 1 || c.main ? " merged" : "") + (c.inset ? " inset" : "");
      d.style.gridArea = `${c.r + 1} / ${c.c + 1} / span ${c.rs} / span ${c.cs}`;
      if (c.inset) {
        d.style.width = `${layout.pip.size * 100}%`;
        d.style[layout.pip.corner === "tl" ? "left" : "right"] = "0";
      }
      d.textContent = (i === big ? "★ " : "") + (i + 1);
      return d;
    })
  );
}

// Drag across the preview to merge; click a merged cell to split it.
(function gridDrag() {
  const g = $("grid");
  let start = null, box = null;
  const at = (e) => {
    const r = g.getBoundingClientRect();
    const col = Math.min(layout.cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * layout.cols)));
    const row = Math.min(layout.rows - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * layout.rows)));
    return { r: row, c: col };
  };
  const rect = (a, b) => ({
    r: Math.min(a.r, b.r), c: Math.min(a.c, b.c),
    rs: Math.abs(a.r - b.r) + 1, cs: Math.abs(a.c - b.c) + 1,
  });
  g.addEventListener("pointerdown", (e) => {
    if (layout.pip) return; // the corner layout has nothing to merge
    start = at(e);
    g.setPointerCapture(e.pointerId);
    box = document.createElement("div");
    box.className = "drag";
    box.style.gridArea = `${start.r + 1} / ${start.c + 1} / span 1 / span 1`;
    g.append(box);
  });
  g.addEventListener("pointermove", (e) => {
    if (!start) return;
    const m = rect(start, at(e));
    box.style.gridArea = `${m.r + 1} / ${m.c + 1} / span ${m.rs} / span ${m.cs}`;
  });
  g.addEventListener("pointerup", (e) => {
    if (!start) return;
    const m = rect(start, at(e));
    start = null;
    box?.remove();
    const hits = (x) => x.r < m.r + m.rs && m.r < x.r + x.rs && x.c < m.c + m.cs && m.c < x.c + x.cs;
    const others = layout.merges.filter((x) => !hits(x));
    if (m.rs * m.cs === 1) {
      if (others.length !== layout.merges.length) setLayout({ ...layout, merges: others }); // split
      return;
    }
    setLayout({ ...layout, merges: [...others, m] });
  });
})();

$("rows").onchange = () => setLayout({ rows: +$("rows").value, cols: layout.cols, merges: [] });
$("cols").onchange = () => setLayout({ rows: layout.rows, cols: +$("cols").value, merges: [] });

// ------------------------------------------------------ saved layouts

function renderSaved() {
  const saved = settings.savedLayouts || {};
  $("savedLayouts").replaceChildren(
    ...Object.entries(saved).map(([name, l]) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const use = document.createElement("button");
      use.textContent = name;
      use.title = describeLayout(l);
      use.onclick = () => setLayout(l);
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = `Delete “${name}”`;
      del.onclick = () => saveLayouts(Object.fromEntries(Object.entries(saved).filter(([k]) => k !== name)));
      chip.append(use, del);
      return chip;
    })
  );
}

async function saveLayouts(savedLayouts) {
  settings = (await send("setSettings", { patch: { savedLayouts } })) || settings;
  renderSaved();
}

$("saveLayout").onclick = () => {
  const name = $("layoutName").value.trim() || describeLayout(layout);
  $("layoutName").value = "";
  saveLayouts({ ...(settings.savedLayouts || {}), [name]: layout });
};
$("layoutName").onkeydown = (e) => { if (e.key === "Enter") $("saveLayout").click(); };

// ------------------------------------------------------------ warning

function renderWarning() {
  const cells = buildCells(layout).length;
  const tiled = state.tiles?.length || 0;
  const wanted = selected.length || tabs.length;
  const count = Math.min(cells, Math.max(wanted, tiled));
  const msgs = [];
  if (count > WARN_ABOVE) {
    msgs.push(
      `${count} tiles is a lot: every one decodes its own video stream, which loads the CPU/GPU, and accounts can have a limit on how many streams play at once. If videos start failing, use fewer tiles.`
    );
  }
  if (selected.length > cells) msgs.push(`${selected.length} tabs selected but the layout has ${cells} cells; only the first ${cells} are tiled.`);
  $("warning").textContent = msgs.join(" ");
  $("warning").hidden = !msgs.length;
}

// ------------------------------------------------------------ actions

const displayId = () => $("display").value || null;

async function refresh() {
  state = (await chrome.storage.session.get("tiling")).tiling || { tiles: [] };
  tabs = await queryTabs();
  renderAll();
}

$("tileSelected").onclick = async () => {
  if (await send("tile", { tabIds: selected, layout, displayId: displayId() })) selected = [];
  refresh();
};
$("tileAll").onclick = async () => {
  await send("tile", { tabIds: tabs.map((t) => t.id), layout, displayId: displayId() });
  refresh();
};
$("retile").onclick = async () => { await send("retile", { layout, displayId: displayId() }); refresh(); };
$("untile").onclick = async () => { await send("untile"); refresh(); };
$("swapBig").onclick = async () => { await send("swapBig", {}); refresh(); };

for (const key of ["videoOnlyDefault", "noPageChanges", "singleAudio", "audioFollowsFocus", "clickToMain", "wholeScreen", "tuckTitleBars"]) {
  $(key).onchange = async () => {
    renderTaskbarHint();
    settings = (await send("setSettings", { patch: { [key]: $(key).checked } })) || settings;
    $("audioFollowsFocus").disabled = !settings.singleAudio;
    if (key === "singleAudio") return refresh();
    renderTiles();
  };
}
$("display").onchange = () => { renderTaskbarHint(); send("setSettings", { patch: { displayId: displayId() } }); };
$("showAll").onchange = () => {
  chrome.storage.local.get("settings").then(({ settings: s }) =>
    chrome.storage.local.set({ settings: { ...(s || {}), showAll: $("showAll").checked } }));
  refresh();
};
$("shortcuts").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); };

// Keep the list current while the popup is open (audio moved by a click
// or a shortcut, a tile window closed).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.tiling) refresh();
});

load();
