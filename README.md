# Touch Annotator

A browser-based tool for logging soccer ball touch timestamps across 1–4 synchronized video feeds.

**[Live URL](https://henryw8.github.io/touch-annotator-web/)**

---

## Workflow

### 1. Upload
Drag or select 1–4 MP4 files. FPS is auto-detected per video.

### 2. Sync
Scrub each video to a common reference frame (e.g. a kick or whistle), then click **Set Sync Point** for each. This aligns all feeds to a shared timeline.

| Control | Action |
|---|---|
| Scrubber | Seek within video |
| `←` / `→` | Step one frame back/forward |
| `Space` | Play/pause the active video |
| `?` | Open help |

### 3. Annotate
All videos play in sync. Click a surface button to label the next touch, then press **Log Touch** (or `Enter`).

| Control | Action |
|---|---|
| `Space` | Play/pause all |
| `←` / `→` | Step one frame |
| `[` / `]` | Step 1 second |
| `Enter` | Log touch |
| `H` / `?` | Open help |

**Post-hoc editing:** Click any logged row to seek to it and change its surface label.

---

## Output CSV

| Column | Description |
|---|---|
| `frame` | Master timeline frame number |
| `time_s` | Master time in seconds |
| `surface` | Body surface used |
| `comment` | Required for "Other" surface |
| `frame_N_<name>` | Local frame number for each video |

