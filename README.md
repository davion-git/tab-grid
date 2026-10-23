# Tab Grid

A Chrome extension for watching several streams at once, such as several
games on a Sunday. It tiles video tabs **you already opened and started
playing** into a grid of windows.

It's a window manager, not a player: it never opens, loads, reloads or
controls a video. Each stream stays an ordinary tab that you started
yourself, just as if you'd opened several browser windows by hand and
dragged them into a grid.

What it uses: `chrome.windows` / `chrome.tabs` (to move tabs into popup
windows and size them), the browser's own tab mute, and an optional
stylesheet that hides everything on the page except the video.

What it never does: intercept or change network requests, use iframes or
embeds, change the user agent, send fake clicks or keys, fake focus or
visibility, poll or call a site's video player, capture video, or load
pages in the background. It has no content script; the only thing it puts
into a page is CSS, and "No page changes" turns even that off.

Some multiview tools that do those things have reportedly got accounts
temporarily blocked as "bot-like". Avoiding all of it is the point of this
design, but see [Caveats](#caveats-read-these): there's no guarantee.

> Not affiliated with or endorsed by YouTube, Google, Fox, Paramount or any
> other streaming service. Use it at your own risk and within each
> service's terms.

## Sites

- **YouTube** (youtube.com watch/live pages): everything, including a
  video-only look made for YouTube's page.
- **Fox One** (fox.com, foxone.com), **Paramount+**, **Twitch**, **Prime
  Video** (primevideo.com, amazon.com/gp/video) and **YouTube TV**
  (tv.youtube.com): listed automatically; tiling, seamless mode and sound
  work as for YouTube. Video-only is on by default: Tab Grid finds the
  site's player box (the picture plus the site's own controls) and makes it
  fill the window; **hover at the bottom edge for the site's play and volume
  controls**. Checked on a live Twitch channel (its mute button works from
  the tile) and on the public pages of the others, not on live
  subscription content.
- **Any other site**, e.g. smaller stream sites: a tab shows up in the list
  by itself **while it's playing sound** (Chrome reports that; Tab Grid
  doesn't read the page). Or tick **Show all tabs**, or paste the page's
  link (below). Tiling, seamless mode and sound work everywhere.
  **Video only finds the player itself** (also inside self-contained player
  widgets, and in every frame of the page): the first time on a site, a
  small Tab Grid window asks whether to allow it on **All sites** or **Only
  this site**, then Chrome confirms. Stream sites usually show a player from
  another site inside their page (sometimes the whole page is a frame from
  elsewhere); only **All sites** lets Tab Grid reach that player. With
  "Only this site", the popup says when the player is out of reach. After that Tab Grid looks for the biggest video or embedded
  player on the page (skipping small ads), marks it, and makes just that one
  fill the window, over headers, chat, ads and banners. This is the one
  place Tab Grid runs a script in a page: once, only on sites you allowed,
  only reading sizes and marking the player; it never controls it. If the
  player hasn't appeared yet, it looks again a few seconds later; if it
  still finds nothing, start the stream and switch Video only off and on.
  An embedded player is stretched as a whole; real embed pages fill their
  frame, so that fills the window.

The popup says under a tile, in words, when video-only couldn't do its job
there (waiting for you to allow the site, or no player found yet).

**If a tile's button says "Allow…"**, Chrome isn't letting Tab Grid into
that site, so video-only can't apply: either it was never allowed, or
Chrome held the access back after an update added the site (Chrome does
that with new sites). Click it and allow. If the button shows a ⚠, video-only
failed on that page; hover over it for the reason.

### Paste a link

The popup has a **Paste a stream or video link** box. **Open as tile** opens
the address in a new window and adds it to the grid (a full layout grows:
1×2 → 2×2 → 3×3 → 4×4, Main + 2 → Main + 3 → Main + 4). A link
straight to a video file (.mp4, .webm, .mov, .m3u8) plays in Tab Grid's own
small player page. A pasted web page gets Video only straight away, with
the Allow window if the site is new. This is the one feature where Tab Grid opens a page
itself, and only when you click Open; for accounts you worry about (e.g.
YouTube and NFL Sunday Ticket) opening the stream yourself is the more
conservative choice. Whether a .m3u8 live-stream link plays depends on the
Chrome version; the player says so if it can't.

## Install (load unpacked)

The popup shows the version (top right), so you can see that a reload took
effect.


1. Download this repository (green **Code** button → **Download ZIP**, then
   unzip it) or `git clone` it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder that contains
   `manifest.json`.
5. Pin it: puzzle-piece icon in the toolbar → pin **Tab Grid**.

After updating the files, click the circular arrow on Tab Grid's card at
`chrome://extensions` to reload it.

## Use

1. Open each stream yourself in its own tab and press play.
2. Click the Tab Grid icon. Your video tabs are listed.
3. Pick a layout (1×2, 2×2, 3×3, 4×4, or rows × columns). Drag across cells
   in the preview to merge them, e.g. a 2×2 block of a 3×3 for the main
   game; click a merged cell to split it. **Save** keeps a named layout.
4. Click tabs to choose them (the number is the cell they go into), then
   **Tile selected**, or just **Tile all**.
5. Click any tile to move the sound there; the others are muted. To hear
   several at once, untick **Only one tile plays sound**: every tile is
   unmuted and each tile's 🔊 button mutes or unmutes just that tile.
   (This is Chrome's own tab mute. The page isn't told, and the video keeps
   playing normally.)

### One main game

- **Main + 2 / Main + 3 / Main + 4**: one big game on top, the others in a
  strip underneath. **Click a game in the strip to make it the main one**
  (they swap places, and the sound goes with the main game). Any layout
  with a merged ★ cell works the same way, e.g. one you drew yourself.
- **Corner (2)**: one game fills the screen and the other sits on top of it
  in the top-right corner. **Click the corner game to swap them**; clicking
  the big game doesn't swap. The sound goes with the big game.
  How: Windows always puts the active window in front, so neither game can
  be the active window (the corner one would hide the big one's clicks, the
  big one would cover the corner). Tab Grid keeps a small black **helper
  window** of its own active instead: on your other monitor if you have one,
  otherwise half off the bottom-left edge of the screen. It's a blank page,
  not a website, and closes on Un-tile. If you click the big game it comes
  forward for a moment, then the corner game is put back on top.
  With **Hide title bars** on, the big game uses Chrome's real full-screen
  mode (no title bar, no gap at the bottom); Chrome shows "To exit full
  screen, press and hold Esc" for a few seconds after each swap.
- Turn off **Click a small game to make it the main one** to stop the
  swaps on click (the swap button and shortcut still work).

Popup controls once tiled: per-tile 🔊 (sound here), **Video only** toggle,
**Show**, **↩ Tab** (send that tile back to a normal tab without reloading;
the other tiles stay put); **Re-tile** (applies a new layout to the same
tabs, moving the existing windows), **Swap into big cell** (puts the tile
with sound into the merged cell), **Un-tile** (all tabs back into one normal
window).

Keyboard: **Alt+1 … Alt+4** jump to tiles 1–4 (the sound follows). Next
tile, previous tile, swap-into-big-cell and **send back to tab** (acts on
the tile you're in) have no default keys because Chrome allows only four;
set them at `chrome://extensions/shortcuts` (the popup links there).
Shortcuts work while a Chrome window is focused.

In video-only mode a transparent layer over each page takes mouse clicks,
so clicking a tile to switch games or sound never pauses its video. On
YouTube the layer stops short of the bottom edge: **hover at the bottom of
a tile for the player's control bar** (play/pause, volume), and clicks
there work. On Fox One / Paramount+ / YouTube TV the player's own controls
are covered; switch **Video only** off for that tile to reach them.

Without clicking into a page at all:
- **Chrome's media controls**: while anything plays, a normal Chrome
  window's toolbar has a play-icon button listing every tab with media,
  including the tiles, each with its own play/pause.
- Your keyboard's **play/pause and volume keys**, and the Windows volume
  pop-up. Only one tile plays sound by default, so the system volume is
  that game's volume.

Tab Grid itself has no play or volume buttons on purpose: those would mean
the extension operating the site's player.

Options: **Video-only for new tiles**, **No page changes** (only arranges
windows; injects nothing anywhere), **Only one tile plays sound**, **Sound
follows the tile I click**, **Hide title bars**, **Use the whole screen**,
and which **monitor** to tile on.

### Seamless full-screen grid

- **No gaps** (always on): Windows gives every window an invisible ~8 px
  border on the left, right and bottom, which shows as gaps between tiles.
  Tiles overlap those borders, so they meet edge to edge.
- **Hide title bars**: each window is made taller by its title bar and
  moved up, so the bar sits outside its cell. Top-row bars go off the top
  of the screen; lower rows' bars sit *behind* the tile above (Tab Grid
  stacks the windows top row in front). Windows always brings a clicked
  window to the front, so when you click a tile below the top row its bar
  shows over the tile above for about a second; then Tab Grid restacks the
  windows and it's hidden again. The sound stays on the tile you clicked.
  Side effect: after the restack a top-row tile has the window focus, so
  clicking *that* tile won't move the sound until you've clicked a
  different tile first (Alt+1–4 and the popup's 🔊 always work). To move or
  close a tile, use the popup (Un-tile) or Alt+F4.
- **Use the whole screen**: tiles cover the full monitor, including the
  taskbar's area. Windows keeps an always-shown taskbar on top of them, so
  also turn on *Settings → Personalization → Taskbar → Taskbar behaviors →
  Automatically hide the taskbar* (the popup reminds you while it's off).

**Fill each tile** removes the black bars you get when a tile isn't the
video's shape (16:9): the picture is zoomed to cover the tile and its edges
are cropped. That can cut off a score bar at the top or bottom, so it's off
by default. It can't reach a player embedded from another site.

Changing either option while tiled re-tiles immediately; tabs don't reload.
With **Hide title bars** on, a window can't be taller than the screen plus
its frame, so a full-height tile (1×2, or Corner's big game without full screen) ends about 19 px
short of the bottom edge. Windows 11 also draws a 1 px outline around each window, which shows as a
hairline between tiles. That can't be removed from Chrome. Only Windows has
been tested; on macOS and Linux the frame sizes are measured the same way,
but the results haven't been checked.

Above 9 tiles the popup warns you: each tile decodes its own stream, and
accounts can have a limit on simultaneous streams.

## First-use test plan (do it in stages)

Stop at the first stage that misbehaves.

1. **No account risk first.** In a Chrome profile that is *not* signed in
   to your streaming account (or a guest window), open 2 ordinary public
   YouTube videos, turn on **No page changes**, tile 1×2. Check the videos
   keep playing and nothing reloads. Un-tile.
2. Same profile: turn **No page changes** off, tile 2×2 with 4 public
   videos. Check video-only looks right, click tiles to move the sound, try
   Alt+1…4, toggle Video only on one tile.
3. Try a 3×3 with a merged 2×2 cell and **Swap into big cell**.
4. **Your account, small:** signed in, one stream plus one ordinary video,
   **No page changes on**, 1×2, for a while.
5. If that's clean, try your usual number of streams, still with **No page
   changes on** for the first full session.
6. Only after a clean session, try video-only mode on your account.

## Caveats (read these)

- **No guarantee.** This only automates what you could do by hand with
  several windows, and it avoids the techniques that make multiview tools
  look like bots. But each service decides what it flags, and nobody outside
  it can promise it will never flag something.
- **If you see "temporarily unavailable, try again later"** (or similar
  errors on videos that should play): stop at once, Un-tile, remove the
  extension at `chrome://extensions`, and go back to ordinary windows.
- During testing, with **9** public 4K/60 YouTube videos playing at once in
  a signed-out test browser, YouTube showed "Something went wrong. Refresh
  or try again later" on two tiles after a couple of minutes, with no
  reload. With **6** videos it did not happen. Keep the count down.
- **YouTube TV, Fox One and Paramount+** video-only CSS is generic (they
  need a subscription to test against). If a tile looks wrong, switch
  **Video only** off for that tile.
- Streaming services may limit how many streams one account plays at once;
  that's their rule and nothing here changes it.
- Sites change their pages; if video-only mode starts looking wrong, turn
  it off (or use **No page changes**). Tiling and sound still work.
- **Closing a tile window closes that tab**, as with any window. Chrome
  gives extensions no way to stop a close, and reopening the stream would
  mean the extension loading a page itself, which it never does. To get a
  stream back as a tab, use **↩ Tab** or the send-back shortcut instead
  of ✕.
- Moving windows with the mouse is fine. Dragging a tile's tab into another
  window takes it out of the grid.
- Un-tile leaves mute as it is, so only the tile that had sound keeps
  playing sound. Unmute others from the tab's right-click menu.
- The grid is forgotten when Chrome restarts (the windows are gone anyway).

## Development

The extension has no build step and no dependencies: the files in this
folder are what Chrome loads. The tests use [Playwright](https://playwright.dev):

```bash
cd tests
npm install
npx playwright install chromium
npm test
```

Each test loads the extension into a throwaway, signed-out Chromium profile
and plays ordinary public YouTube videos. They must run headed (test
windows appear on screen) because `chrome.system.display` crashes headless
Chromium.

- `e2e.mjs` (6 videos): 2×2, 3×3, a custom 2×3, a merged cell, swap,
  video-only on/off, no-page-changes, sound switching, reload handling and
  un-tile, including that no tab reloads when it's moved.
- `seamless.mjs` (4 videos): with the seamless options, every page must
  fill its cell exactly; clicking a lower tile restacks; the plain layout
  must come back without reloads.
- `main-swap.mjs` (4 videos): Main + 3, clicking a strip game to swap.
- `detect.mjs`: player detection on stand-in stream pages (an ad video plus
  the real player two frames deep; a page video next to an ad frame; a
  player widget with its video in its own shadow DOM).
- `frames.mjs`: a site whose whole page is a frame from another address,
  with the player one frame further in; with and without access to it.
- `twitch.mjs`: a live Twitch channel fills its tile and Twitch's own mute
  button works from the bottom edge.
- `link-fill.mjs`: Fill each tile on Twitch; pasting a page link and a
  video file (made with ffmpeg) into tiles.
- `any-site.mjs`: Twitch, Prime Video and a local stand-in stream site
  with an embedded player: listed, tiled, video-only fills the window.
- `corner.mjs` (2 videos): Corner with the helper window, full screen,
  swapping only on a corner click, and clicks never pausing a video.
- `send-back.mjs`, `audio.mjs`, `other-sites.mjs`: those features.
- `make-icons.mjs` redraws the icons.

## License

[MIT](LICENSE)
