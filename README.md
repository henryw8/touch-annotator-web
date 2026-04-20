# Touch Annotator

A single-page, browser-based tool for logging soccer ball touches across **1–4 time-synced video feeds**. Produces a CSV of per-touch frames, times, touch types, and body parts.

**[Live URL](https://henryw8.github.io/touch-annotator-web/)**

---

## Contents

- [What it is](#what-it-is)
- [Running it](#running-it)
- [Workflow](#workflow)
  - [1. Upload](#1-upload)
  - [2. Sync Setup](#2-sync-setup)
  - [3. Annotate](#3-annotate)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [CSV format](#csv-format)
- [Review / reload a prior session](#review--reload-a-prior-session)
- [Optional tools](#optional-tools)
- [Browser requirements](#browser-requirements)
- [Implementation notes](#implementation-notes)
- [Known limitations](#known-limitations)

---

## What it is

A zero-install web app that runs **entirely in the browser** — no server, no upload of video files, no backend. You point it at local MP4s, align them to a common moment, scrub through the synced timeline, and log each ball touch with one keystroke.

Intended for annotators marking ball contacts in multi-camera match footage (e.g. for training datasets, event tagging, or analytics).

## Running it

Two options:

1. **Hosted:** open the [Live URL](https://henryw8.github.io/touch-annotator-web/).
2. **Local:** clone the repo and open `index.html` in a modern browser. The included `start.sh` does this on macOS:
   ```
   ./start.sh
   ```

No build, no dependencies, no install. Source files:
- `index.html` — markup + CSS
- `app.js` — all logic (~1,900 lines, vanilla JS)

---

## Workflow

### 1. Upload

Drag-and-drop or click the drop zone to select **1–4 MP4 files** from the same match. The app detects each video's frame rate automatically by playing it briefly off-screen and measuring `requestVideoFrameCallback` timing.

- Videos can have different framerates; the first video's FPS becomes the master frame counter.
- You can also drop an **exported CSV** alongside the videos to reload a prior annotation session — see [Review / reload a prior session](#review--reload-a-prior-session).
- Remove a file by clicking the `✕` next to it.

Click **Continue to Sync →** once all files are queued.

### 2. Sync Setup

Align every video to the **exact same real-world moment** — e.g. a whistle, a ball bounce, a kick. This moment becomes `masterTime = 0`.

For each video panel:

1. Scrub or frame-step to the shared moment.
2. Click **Set Sync Point**. The footer dot turns green.

Click on a panel to give it keyboard focus (blue outline). Then:

| Control | Action |
|---|---|
| Scrubber | Seek within video |
| `←` / `→` | Step one frame back / forward |
| `Space` | Play / pause the focused video |
| FPS box | Manually override the auto-detected frame rate |

Once all dots are green, click **Annotate →**. With only one video, any frame can be set as "frame 0".

### 3. Annotate

All videos play in sync. The large **frame counter** at the bottom-left is on the master timeline (frame 0 = sync moment).

**To log a touch:**

1. Pause on the contact frame (use `←` / `→` for fine control, or 0.25× playback to spot it).
2. Pick a **Touch Type** — `Bounce`, `Kick`, or `Touch`.
3. If Touch Type is `Touch`, pick a **Body Part** — `Foot`, `Knee`, `Chest`, `Arm`, `Head`.
4. Press `T` or click **Log Touch**. The row appears in the sidebar at the right.

You can also log with no type assigned — the row will show `— assign type →` until you fill it in.

**To edit a logged touch:** click its row. The app seeks to that frame and puts the row in edit mode (blue highlight). Click a new Touch Type / Body Part button to reassign.

**To delete a touch:** hover over its row and click the `✕`.

**To clear everything:** click **Clear** at the bottom of the sidebar.

**To go back to sync:** click **Re-sync** in the transport bar.

**To export:** click **Export CSV**. A file `touches_<timestamp>.csv` downloads. See [CSV format](#csv-format).

---

## Keyboard shortcuts

Active on the Annotate screen (Sync screen has its own reduced set — see above).

| Key | Action |
|---|---|
| `Space` | Play / pause all videos |
| `←` / `→` | Step one frame back / forward |
| `↑` / `↓` | Jump 1 second back / forward |
| `T` | Log touch at current frame |
| `1` / `2` / `3` | Touch type: Bounce / Kick / Touch |
| `4`–`8` | Body part: Foot / Knee / Chest / Arm / Head |
| `0` | Reset zoom on all videos |
| `D` | Toggle drawing overlay |
| `F` / `L` / `E` | (in drawing mode) switch to Freehand / Line / Eraser |
| `Del` / `⌫` | (in drawing mode) delete selected drawing element |
| `Esc` | Cancel line / deselect / exit drawing |
| `H` / `?` | Open help panel |

---

## CSV format

Every export starts with a `#meta` comment line encoding per-video sync metadata, followed by a standard header and one row per touch.

```
#meta {"videos":[{"name":"cam1.mp4","syncOffset":1.234,"fps":30}, ...],"realTimeFactor":1}
frame,time_s,real_time_s,touch_type,body_part,frame_1_cam1,frame_2_cam2,...
142,4.733333,4.733333,touch,foot,284,142,...
...
```

Columns:

| Column | Description |
|---|---|
| `frame` | Master-timeline frame number (0 = sync moment) |
| `time_s` | Master-timeline time in seconds (video time) |
| `real_time_s` | `time_s × realTimeFactor` — scaled real-world time for slow-motion footage |
| `touch_type` | `bounce` / `kick` / `touch`, or empty if unassigned |
| `body_part` | `foot` / `knee` / `chest` / `arm` / `head`, or empty (only set when touch_type = `touch`) |
| `frame_N_<videoname>` | Local frame number in video N at this touch |

The `#meta` line lets the CSV be reloaded to restore the session exactly (sync offsets + FPS + real-time factor). Other tools can safely ignore this line.

---

## Review / reload a prior session

To reopen a previously annotated session:

1. On the Upload screen, drop or select **both** the MP4 files **and** the exported CSV together.
2. Click **Continue**.
3. The app detects the CSV, restores sync offsets and FPS from its `#meta` line, and jumps directly to the Annotate screen with all prior touches loaded and editable.

**Legacy CSVs** (without `#meta`) are also supported: the app re-detects FPS and derives sync offsets from the per-video frame columns (median across rows) using fuzzy video-name matching.

Exporting always creates a new file — a loaded session is effectively a copy on open.

---

## Optional tools

These are available but not required for the core annotation workflow.

### Drawing overlay (`D`)

Toggles a transparent canvas over each video. Tools (in the popup toolbar):

- **Freehand** (`F`) — draw lines with the mouse
- **Line** (`L`) — click-drag for straight segments; optional **angle snap** (0–360°) in the toolbar
- **Eraser** (`E`) — click near an element to delete it
- **Color picker** — 5 swatches (blue / green / red / yellow / white)
- **Clear All** — removes every drawing on every video

Click near a drawn element to select it (glow halo). Press `Del` to remove it.

Drawings persist across frame changes.

### Zoom & pan

- **Scroll wheel** on a video to zoom in / out toward the cursor (1× to 8×).
- **Click-drag** when zoomed to pan (exit drawing mode first).
- **Double-click** to reset zoom on that video.
- **`0`** to reset zoom on every video.

### Playback rate

The **Speed** dropdown in the transport bar chooses between 0.05× · 0.1× · 0.25× · 0.5× · 1× · 2×. Useful for spotting fast contacts at slow speeds.

### Real-time factor

For slow-motion footage (e.g. 240 fps captured, 60 fps file playing at 1/4 speed), the **Real×** input multiplies `time_s` to produce `real_time_s` in the CSV. Set it once; it's saved in the export `#meta` and restored on reload.

---

## Browser requirements

- Modern Chromium-based browser (Chrome, Edge, Brave, Arc) or Safari 16+ / Firefox 115+.
- Uses `requestVideoFrameCallback` for FPS detection — available in Chromium and Safari since 2023; polyfilled fallback is not provided.
- All processing is local: no video is uploaded anywhere.
- A desktop is strongly recommended. Small windows and touch devices are not tested.

---

## Implementation notes

- **No build step.** Vanilla HTML + JS. Open `index.html` directly.
- **State model:**
  - `videoItems[]` — one per video: `{ file, name, objectUrl, el, fps, syncOffset }`
  - `annotations[]` — one per touch: `{ frame, time, touchType, bodyPart }`
  - `masterFPS`, `masterTime`, `masterMin`, `masterMax` — shared clock (first video drives)
  - `syncOffset` per video: seconds into that video corresponding to `masterTime = 0`
- **Playback sync:** the first video is the master clock; secondary videos are re-seeked if they drift more than 80 ms.
- **FPS detection** runs in parallel across videos and samples ~30 frames per video, capped at a few seconds.

---

## Known limitations

- **Single master FPS.** All annotations are frame-counted against the first video's FPS. For very different framerates across feeds, prefer the per-video `frame_N_<name>` columns in the CSV.
- **Duplicate frames blocked.** Logging two touches on the same master frame is rejected with a toast — delete the first if you need to replace it.
- **No autosave.** Export the CSV before closing the tab; annotations are in-memory only. (Reloading the CSV + videos restores the session fully.)
- **No server / no persistence.** Closing the tab discards everything. Each session starts fresh.
- **Browser video codec support.** MP4 (H.264) is universal; other containers are untested.
