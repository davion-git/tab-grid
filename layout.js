// Grid maths shared by the popup and the background worker.
// A layout is { rows, cols, merges: [{ r, c, rs, cs }] } with rows/cols 1..4,
// or a corner overlap { rows: 1, cols: 1, merges: [], pip: { corner, size } }:
// one tile fills the area and a second, smaller one sits on top in a corner.
export const MAX = 4;

export const PRESETS = [
  { id: "1x2", label: "1×2", rows: 1, cols: 2 },
  { id: "2x2", label: "2×2", rows: 2, cols: 2 },
  { id: "3x3", label: "3×3", rows: 3, cols: 3 },
  { id: "4x4", label: "4×4", rows: 4, cols: 4 },
  // One main game with the others in a strip along the bottom.
  { id: "main2", label: "Main + 2", rows: 3, cols: 2, merges: [{ r: 0, c: 0, rs: 2, cs: 2 }] },
  { id: "main3", label: "Main + 3", rows: 4, cols: 3, merges: [{ r: 0, c: 0, rs: 3, cs: 3 }] },
  { id: "main4", label: "Main + 4", rows: 4, cols: 4, merges: [{ r: 0, c: 0, rs: 3, cs: 4 }] },
  // Two games: one fills the screen, the other overlaps it in a top corner.
  { id: "corner", label: "Corner (2)", rows: 1, cols: 1, pip: { corner: "tr", size: 0.3 } },
];

// The next bigger layout with room for n tiles, used when a pasted link
// doesn't fit: a main-game layout stays one (Main + 2/3/4), anything else
// becomes the smallest square grid that fits.
export function growLayout(layout, n) {
  const l = cleanLayout(layout);
  if (buildCells(l).length >= n) return l;
  const main = PRESETS.filter((p) => p.id.startsWith("main"));
  if ((l.pip || l.merges.length) && n <= 5) return cleanLayout(main.find((p) => buildCells(p).length >= n));
  const grid = PRESETS.filter((p) => /^\d+x\d+$/.test(p.id) && p.rows === p.cols).find((p) => p.rows * p.cols >= n);
  return cleanLayout(grid || { rows: 4, cols: 4 });
}

export function sameLayout(a, b) {
  return JSON.stringify(cleanLayout(a)) === JSON.stringify(cleanLayout(b));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

// Drops merges that are out of range, 1x1 or overlap an earlier merge.
export function cleanLayout(l = {}) {
  if (l.pip) {
    const corner = l.pip.corner === "tl" ? "tl" : "tr";
    const size = Math.min(0.5, Math.max(0.15, Number(l.pip.size) || 0.3));
    return { rows: 1, cols: 1, merges: [], pip: { corner, size } };
  }
  const rows = clamp(l.rows | 0, 1, MAX);
  const cols = clamp(l.cols | 0, 1, MAX);
  const taken = Array.from({ length: rows }, () => Array(cols).fill(false));
  const merges = [];
  for (const m of l.merges || []) {
    const r = m.r | 0, c = m.c | 0, rs = m.rs | 0, cs = m.cs | 0;
    if (r < 0 || c < 0 || rs < 1 || cs < 1 || r + rs > rows || c + cs > cols) continue;
    if (rs === 1 && cs === 1) continue;
    let free = true;
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if (taken[y][x]) free = false;
    if (!free) continue;
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) taken[y][x] = true;
    merges.push({ r, c, rs, cs });
  }
  return { rows, cols, merges };
}

// Cells in reading order (by top-left corner). Tile n goes into cell n.
export function buildCells(layout) {
  const { rows, cols, merges, pip } = cleanLayout(layout);
  if (pip) {
    return [
      { r: 0, c: 0, rs: 1, cs: 1, main: true },
      { r: 0, c: 0, rs: 1, cs: 1, inset: true },
    ];
  }
  const owner = Array.from({ length: rows }, () => Array(cols).fill(-1));
  merges.forEach((m, i) => {
    for (let y = m.r; y < m.r + m.rs; y++) for (let x = m.c; x < m.c + m.cs; x++) owner[y][x] = i;
  });
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const o = owner[r][c];
      if (o === -1) cells.push({ r, c, rs: 1, cs: 1 });
      else if (merges[o].r === r && merges[o].c === c) cells.push({ ...merges[o] });
    }
  }
  return cells;
}

// Window bounds for a cell inside a display's workArea. Edges are rounded
// from the same grid lines so neighbouring windows meet without gaps.
export function cellRect(cell, layout, area) {
  const { rows, cols, pip } = cleanLayout(layout);
  if (cell.inset && pip) {
    // 16:9, flush with the top edge so a tucked title bar goes off-screen.
    const width = Math.round(area.width * pip.size);
    const height = Math.round((width * 9) / 16);
    const left = pip.corner === "tl" ? area.left : area.left + area.width - width;
    return { left, top: area.top, width, height };
  }
  const x = (k) => area.left + Math.round((k * area.width) / cols);
  const y = (k) => area.top + Math.round((k * area.height) / rows);
  return {
    left: x(cell.c),
    top: y(cell.r),
    width: x(cell.c + cell.cs) - x(cell.c),
    height: y(cell.r + cell.rs) - y(cell.r),
  };
}

// Index of the largest merged cell, or -1 when nothing is merged.
export function bigCellIndex(cells) {
  const main = cells.findIndex((c) => c.main);
  if (main >= 0) return main;
  let best = -1, size = 1;
  cells.forEach((c, i) => {
    if (c.rs * c.cs > size) { size = c.rs * c.cs; best = i; }
  });
  return best;
}

export function describeLayout(l) {
  const { rows, cols, merges, pip } = cleanLayout(l);
  if (pip) return "corner overlap";
  const n = buildCells(l).length;
  return `${rows}×${cols}` + (merges.length ? `, ${n} cells` : "");
}

// Tabs the popup offers for tiling ("Show all tabs" lists every web tab).
export const VIDEO_URLS = [
  "https://www.youtube.com/watch*",
  "https://www.youtube.com/live/*",
  "https://m.youtube.com/watch*",
  "https://tv.youtube.com/*",
  "https://*.fox.com/*",
  "https://*.foxone.com/*",
  "https://*.paramountplus.com/*",
  "https://*.twitch.tv/*",
  "https://*.primevideo.com/*",
  "https://www.amazon.com/gp/video/*",
];

// Which video-only stylesheet a tab gets: "yt" (made for youtube.com),
// "generic" (known streaming sites: makes the <video> fill the window),
// "other" (any other web page: the generic sheet too, once the user has
// granted Tab Grid that one site), or "none" (not a web page).
export function siteKind(url = "") {
  let u;
  try { u = new URL(url); } catch { return "none"; }
  if (!/^https?:$/.test(u.protocol)) return "none";
  const host = u.hostname;
  if (host === "www.youtube.com" || host === "m.youtube.com") return "yt";
  if (host === "tv.youtube.com") return "generic";
  if (/(^|\.)(fox|foxone|paramountplus|primevideo)\.com$/.test(host)) return "generic";
  if (/(^|\.)twitch\.tv$/.test(host)) return "generic";
  if (host === "www.amazon.com" && u.pathname.startsWith("/gp/video")) return "generic";
  return "other";
}

// The match pattern Chrome's permission prompt uses for a page's site.
export function sitePattern(url = "") {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
