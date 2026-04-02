// ═══════════════════════════════════════════════════════════
// Touch Annotator — app.js
// All video processing happens in-browser; no server required.
// ═══════════════════════════════════════════════════════════

'use strict';

// ── DOM helpers ──────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Screens ──────────────────────────────────────────────────
const screens = {
  upload:   $('upload-screen'),
  sync:     $('sync-screen'),
  annotate: $('annotate-screen'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  const crumbs = {
    upload:   '',
    sync:     '› <span class="crumb-active">Sync Setup</span>',
    annotate: '› <span class="crumb-active">Annotate</span>',
  };
  $('header-crumb').innerHTML = crumbs[name] || '';
}

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

// videoItems: { file, name, objectUrl, el, fps, syncOffset }
const videoItems = [];

let pendingCsvFile = null;  // CSV uploaded for review mode

let masterFPS    = 25;   // frames per second used for frame counter
let masterTime   = 0;    // seconds relative to sync point (0 = sync moment)
let masterMin    = 0;    // earliest valid masterTime
let masterMax    = 60;   // latest valid masterTime
let isPlaying    = false;
let rafId        = null;
let frameAccurateTimer = null;
let realTimeFactor = 1;  // real_time_s = video_time_s * realTimeFactor

let annotations          = [];   // { frame, time, touchType, bodyPart }
let selectedTouchType    = null; // 'bounce' | 'kick' | 'touch'
let selectedBodyPart     = null; // 'foot' | 'knee' | 'chest' | 'arm' | 'head'
let editingAnnotationIdx = null; // index in annotations[] being edited post-hoc

// Drawing overlay state
let drawingMode      = false;
let drawToolMode     = 'free'; // 'free' | 'line' | 'erase' | 'calibrate'
const drawingData    = new Map(); // videoIdx → {elements[], selectedIdx, canvas, ctx}
let lineStartPoint   = null;     // {x,y} in 0-1 coords for in-progress line
let lineStartVideoIdx = null;    // which video the in-progress line is on
let drawColor        = '#4a9eff'; // current drawing color
let lineAngle        = null;      // degrees (null = free angle)

// Calibration state
let calibrateMode        = false;     // true when calibration mode is active (separate from draw)
let showCalibrationLines = true;      // toggle visibility of calibration visuals
const calibrations       = new Map(); // videoIdx → { cx, cy, rNorm, diameter }
let calibCircleStart     = null;      // {x,y} normalized — center of circle being drawn
let calibCircleVideoIdx  = null;
let calibPending         = null;      // { cx, cy, rNorm, videoIdx } — adjustable circle before confirm
let calibDragMode        = null;      // 'new' | 'move' | 'resize'
let calibDragOffset      = null;      // { dx, dy } offset for move drag
let pendingCalibration   = null;      // { cx, cy, rNorm, videoIdx } awaiting popover confirm

// Height measurement state
let measureMode          = false;
let measureFirstClick    = null;      // {x, y, videoIdx} normalized — first click (ground)
let measureHoverPt       = null;      // {x, y, videoIdx} normalized — mouse position pre-click-1

// Zoom/pan state per video
const zoomStates = new Map(); // videoIdx → { scale, panX, panY, container }
let activePan    = null;      // { videoIdx, startX, startY, startPanX, startPanY, cell }

// Per-video sync state (parallel to videoItems)
const syncStates = [];  // { isSet: bool }
let lastActiveSyncIdx = 0; // which sync panel receives keyboard events

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

let toastTimer = null;
function showToast(msg, duration = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function fmtBytes(b) {
  return b < 1024 * 1024
    ? (b / 1024).toFixed(0) + ' KB'
    : (b / 1024 / 1024).toFixed(1) + ' MB';
}

// ═══════════════════════════════════════════════════════════
// SCREEN 1 — UPLOAD
// ═══════════════════════════════════════════════════════════

const dropZone       = $('drop-zone');
const fileInput      = $('file-input');
const fileListEl     = $('file-list');
const uploadContinue = $('upload-continue');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});

fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});

function addFiles(files) {
  const csvFiles   = files.filter(f => /\.csv$/i.test(f.name) || f.type === 'text/csv');
  const videoFiles = files.filter(
    f => f.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi)$/i.test(f.name)
  );

  if (csvFiles.length > 0) {
    pendingCsvFile = csvFiles[0];
    if (csvFiles.length > 1) showToast('Only one CSV at a time — loaded first');
  }

  const slots = 4 - videoItems.length;
  const toAdd  = videoFiles.slice(0, slots);
  if (videoFiles.length > slots) {
    showToast(`Max 4 videos — added ${toAdd.length}`);
  }
  toAdd.forEach(file => {
    videoItems.push({ file, name: file.name, objectUrl: null, el: null, fps: null, syncOffset: 0 });
  });
  renderFileList();
}

function renderFileList() {
  fileListEl.innerHTML = '';

  // CSV entry (shown first, if present)
  if (pendingCsvFile) {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `
      <span class="file-item-icon">📊</span>
      <span class="file-item-name" title="${pendingCsvFile.name}">${pendingCsvFile.name}</span>
      <span class="file-item-size">${fmtBytes(pendingCsvFile.size)}</span>
      <button class="file-item-remove" id="csv-remove-btn" title="Remove CSV">✕</button>
    `;
    div.querySelector('#csv-remove-btn').addEventListener('click', () => {
      pendingCsvFile = null;
      renderFileList();
    });
    fileListEl.appendChild(div);
  }

  // Video entries
  videoItems.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `
      <span class="file-item-icon">🎥</span>
      <span class="file-item-name" title="${item.name}">${item.name}</span>
      <span class="file-item-size">${fmtBytes(item.file.size)}</span>
      <button class="file-item-remove" data-i="${i}" title="Remove">✕</button>
    `;
    fileListEl.appendChild(div);
  });

  fileListEl.querySelectorAll('.file-item-remove[data-i]').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.i);
      if (videoItems[i].objectUrl) URL.revokeObjectURL(videoItems[i].objectUrl);
      videoItems.splice(i, 1);
      renderFileList();
    });
  });

  const hasVideos = videoItems.length > 0;
  uploadContinue.disabled = !hasVideos;
  uploadContinue.textContent = (pendingCsvFile && hasVideos)
    ? 'Load Annotations →'
    : 'Continue to Sync →';
}

uploadContinue.addEventListener('click', () => {
  if (pendingCsvFile) startReviewSession();
  else startFpsDetection();
});

// ═══════════════════════════════════════════════════════════
// FPS DETECTION
// ═══════════════════════════════════════════════════════════

async function startFpsDetection() {
  $('fps-overlay').classList.add('show');
  $('fps-status').textContent = 'Initialising…';

  // Create object URLs and video elements
  for (const item of videoItems) {
    if (!item.objectUrl) {
      item.objectUrl = URL.createObjectURL(item.file);
    }
    if (!item.el) {
      const video = document.createElement('video');
      video.src        = item.objectUrl;
      video.preload    = 'auto';
      video.muted      = true;
      video.playsInline = true;
      video.controls   = false;
      item.el = video;
      await waitForMetadata(video);
    }
  }

  // Detect FPS for each video sequentially
  for (let i = 0; i < videoItems.length; i++) {
    const item = videoItems[i];
    $('fps-status').textContent = `Detecting FPS — video ${i + 1} / ${videoItems.length}…`;
    item.fps = await detectFPS(item.el);
    $('fps-status').textContent = `Video ${i + 1}: ${item.fps} fps ✓`;
    await sleep(350);
  }

  // First video drives the master frame counter
  masterFPS = videoItems[0].fps;

  $('fps-overlay').classList.remove('show');
  buildSyncScreen();
  showScreen('sync');
}

function waitForMetadata(video) {
  return new Promise(resolve => {
    if (video.readyState >= 1) { resolve(); return; }
    video.addEventListener('loadedmetadata', resolve, { once: true });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sampleFPS(video, playbackRate, sampleFrames, timeoutMs) {
  return new Promise(resolve => {
    let count = 0;
    let startMedia = null;
    let settled = false;
    const savedTime = video.currentTime;

    const startAt = Math.min(2, (video.duration || 10) * 0.05);
    video.currentTime = startAt;
    video.playbackRate = playbackRate;

    const finish = (fps) => {
      if (settled) return;
      settled = true;
      video.pause();
      video.currentTime = savedTime;
      resolve(fps);
    };

    const onFrame = (now, meta) => {
      if (settled) return;
      if (startMedia === null) {
        startMedia = meta.mediaTime;
        count = 0;
      } else {
        count++;
        if (count >= sampleFrames) {
          const elapsed = meta.mediaTime - startMedia;
          finish(elapsed > 0 ? Math.round(count / elapsed) : 0);
          return;
        }
      }
      video.requestVideoFrameCallback(onFrame);
    };

    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => finish(0));

    setTimeout(() => finish(0), timeoutMs);
  });
}

// Display refresh rates — when Pass 1 returns one of these, it could be
// display-capped (e.g. 60 from a 1000fps video). Otherwise we trust Pass 1.
const DISPLAY_LIKE_FPS = new Set([48, 50, 59, 60, 72, 75, 90, 120, 144, 240]);

async function detectFPS(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    return 25;
  }

  const pass1 = await sampleFPS(video, 1, 60, 10000);
  if (pass1 > 240) {
    return Math.max(10, Math.min(10000, pass1));
  }
  if (!DISPLAY_LIKE_FPS.has(pass1)) {
    // 24, 30, etc. — not a display rate, so Pass 1 is trustworthy
    return Math.max(10, Math.min(10000, pass1));
  }

  // Pass 2: Pass 1 could be display-capped. Slow playback to get true rate.
  const pass2 = await sampleFPS(video, 0.05, 15, 15000);
  if (pass2 > 0) {
    return Math.max(10, Math.min(10000, pass2));
  }

  return pass1 > 0 ? Math.max(10, Math.min(10000, pass1)) : 25;
}

// ═══════════════════════════════════════════════════════════
// SCREEN 2 — SYNC SETUP
// ═══════════════════════════════════════════════════════════

const syncVideosGrid = $('sync-videos-grid');
const syncDots       = $('sync-dots');
const syncFooterHint = $('sync-footer-hint');
const syncContinue   = $('sync-continue');

function buildSyncScreen() {
  syncVideosGrid.innerHTML = '';
  syncDots.innerHTML = '';
  syncStates.length = 0;

  videoItems.forEach((item, i) => {
    syncStates.push({ isSet: false });

    // ── Panel markup ──
    const panel = document.createElement('div');
    panel.className = 'sync-panel';
    panel.innerHTML = `
      <div class="sync-panel-title" title="${item.name}">${item.name}</div>
      <div class="sync-video-wrap"></div>
      <div class="sync-controls">
        <button class="btn btn-sm btn-icon sync-play-btn" title="Play/Pause">▶</button>
        <button class="btn btn-sm btn-icon" data-action="prev" title="−1 frame (←)">◀</button>
        <button class="btn btn-sm btn-icon" data-action="next" title="+1 frame (→)">▶▶</button>
        <input type="range" class="sync-scrubber"
               min="0" max="${item.el.duration || 9999}" step="${(1 / item.fps).toFixed(6)}" value="0">
        <span class="sync-time">0.000 s</span>
      </div>
      <div class="sync-controls" style="flex-wrap:wrap;gap:8px;">
        <button class="sync-set-btn" data-i="${i}">Set Sync Point</button>
        <span class="sync-fps-row">
          <span class="fps-badge">${item.fps} fps</span>
          <input type="number" class="btn btn-sm fps-override"
                 min="1" max="10000" value="${item.fps}"
                 title="Override detected FPS" style="width:72px;text-align:center;">
        </span>
      </div>
      <div class="sync-kbd-hint">← → frame step · Space play/pause</div>
    `;

    // Re-insert the shared video element
    const wrap = panel.querySelector('.sync-video-wrap');
    item.el.style.cssText = 'width:100%;object-fit:contain;display:block;border-radius:6px;background:#000;';
    wrap.appendChild(item.el);

    // Mark this panel as keyboard-active when any control is touched
    const setKbdFocus = () => {
      syncVideosGrid.querySelectorAll('.sync-panel').forEach(p => p.classList.remove('kbd-focus'));
      panel.classList.add('kbd-focus');
      lastActiveSyncIdx = i;
    };
    panel.addEventListener('pointerdown', setKbdFocus, { capture: true });

    // ── Controls wiring ──
    const scrubber  = panel.querySelector('.sync-scrubber');
    const timeSpan  = panel.querySelector('.sync-time');
    const setBtn    = panel.querySelector('.sync-set-btn');
    const fpsBadge  = panel.querySelector('.fps-badge');
    const fpsInput  = panel.querySelector('.fps-override');
    const playBtn   = panel.querySelector('.sync-play-btn');

    // Keep scrubber & time display in sync with video
    item.el.addEventListener('timeupdate', () => {
      const t = item.el.currentTime;
      scrubber.value = t;
      timeSpan.textContent = t.toFixed(3) + ' s';
    });

    item.el.addEventListener('pause', () => { playBtn.textContent = '▶'; });
    item.el.addEventListener('play',  () => { playBtn.textContent = '⏸'; });
    item.el.addEventListener('ended', () => { playBtn.textContent = '▶'; });

    // Scrubber drag
    scrubber.addEventListener('input', () => {
      item.el.pause();
      item.el.currentTime = parseFloat(scrubber.value);
    });

    // Play/pause
    playBtn.addEventListener('click', () => {
      if (item.el.paused) item.el.play().catch(() => {});
      else item.el.pause();
    });

    // Frame step buttons
    panel.querySelector('[data-action=prev]').addEventListener('click', () => {
      item.el.pause();
      item.el.currentTime = Math.max(0, item.el.currentTime - 1 / item.fps);
    });
    panel.querySelector('[data-action=next]').addEventListener('click', () => {
      item.el.pause();
      item.el.currentTime = Math.min(item.el.duration, item.el.currentTime + 1 / item.fps);
    });

    // Set sync point
    setBtn.addEventListener('click', () => {
      item.syncOffset = item.el.currentTime;
      syncStates[i].isSet = true;
      setBtn.classList.add('is-set');
      setBtn.textContent = `✓ ${item.syncOffset.toFixed(3)} s`;
      updateSyncProgress();
    });

    // FPS override
    fpsInput.addEventListener('change', () => {
      const val = parseInt(fpsInput.value);
      if (val >= 1 && val <= 10000) {
        item.fps = val;
        fpsBadge.textContent = val + ' fps';
        scrubber.step = (1 / val).toFixed(6);
        if (i === 0) masterFPS = val;
      }
    });

    // ── Progress dot ──
    const dot = document.createElement('div');
    dot.className = 'sync-dot';
    dot.id = `sync-dot-${i}`;
    syncDots.appendChild(dot);

    syncVideosGrid.appendChild(panel);
  });

  updateSyncProgress();
}

function updateSyncProgress() {
  const total  = syncStates.length;
  const setN   = syncStates.filter(s => s.isSet).length;
  const allSet = setN === total;

  syncStates.forEach((s, i) => {
    const dot = $(`sync-dot-${i}`);
    if (dot) dot.classList.toggle('is-set', s.isSet);
  });

  syncContinue.disabled = !allSet;
  syncFooterHint.textContent = allSet
    ? `All sync points set — ready to annotate!`
    : `${setN} / ${total} sync point${total !== 1 ? 's' : ''} set`;
}

// Keyboard shortcuts for the sync screen
document.addEventListener('keydown', e => {
  if (!$('sync-screen').classList.contains('active')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

  const item = videoItems[lastActiveSyncIdx];
  if (!item) return;

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      item.el.pause();
      item.el.currentTime = Math.max(0, item.el.currentTime - 1 / item.fps);
      break;
    case 'ArrowRight':
      e.preventDefault();
      item.el.pause();
      item.el.currentTime = Math.min(item.el.duration, item.el.currentTime + 1 / item.fps);
      break;
    case ' ':
      e.preventDefault();
      if (item.el.paused) item.el.play().catch(() => {});
      else item.el.pause();
      break;
  }
});

$('sync-back').addEventListener('click', () => {
  videoItems.forEach(item => item.el && item.el.pause());
  showScreen('upload');
});

syncContinue.addEventListener('click', () => {
  videoItems.forEach(item => item.el && item.el.pause());
  buildAnnotateScreen();
  showScreen('annotate');
});

// ═══════════════════════════════════════════════════════════
// SCREEN 3 — ANNOTATE
// ═══════════════════════════════════════════════════════════

const videoGrid     = $('video-grid');
const frameDisplay  = $('frame-display');
const timeDisplay   = $('time-display');
const masterScrubber = $('master-scrubber');
const realTimeFactorInput = $('real-time-factor');
const frameAccurateModeInput = $('frame-accurate-mode');
const btnPlay  = $('btn-play');
const btnPrev  = $('btn-prev');
const btnNext  = $('btn-next');
const btnStart = $('btn-start');
const btnEnd   = $('btn-end');

function toRealTime(videoTime) {
  return videoTime * realTimeFactor;
}

function buildAnnotateScreen() {
  videoGrid.innerHTML = '';
  const count = videoItems.length;
  videoGrid.className = `video-grid count-${count}`;

  drawingData.clear();

  videoItems.forEach((item, idx) => {
    const cell = document.createElement('div');
    cell.className = 'video-cell';

    const label = document.createElement('span');
    label.className = 'video-cell-label';
    label.textContent = item.name.replace(/\.[^.]+$/, '');

    const fpsBadge = document.createElement('span');
    fpsBadge.className = 'video-cell-fps';
    fpsBadge.textContent = item.fps + ' fps';

    // Move video element into this cell
    item.el.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    item.el.controls = false;

    // Drawing canvas overlay
    const canvas = document.createElement('canvas');
    canvas.className = 'draw-overlay';
    drawingData.set(idx, { elements: [], selectedIdx: -1, canvas, ctx: null });

    // Zoom container wraps video + canvas so transforms apply to both
    const zoomContainer = document.createElement('div');
    zoomContainer.className = 'video-zoom-container';
    zoomContainer.appendChild(item.el);
    zoomContainer.appendChild(canvas);

    cell.appendChild(zoomContainer);
    cell.appendChild(label);
    cell.appendChild(fpsBadge);
    videoGrid.appendChild(cell);

    zoomStates.set(idx, { scale: 1, panX: 0, panY: 0, container: zoomContainer });
  });

  // Build drawing toolbar (inserted before video-grid)
  let drawToolbar = document.getElementById('draw-toolbar');
  if (drawToolbar) drawToolbar.remove();
  drawToolbar = document.createElement('div');
  drawToolbar.id = 'draw-toolbar';
  drawToolbar.className = 'draw-toolbar';
  drawToolbar.innerHTML = `
    <button class="btn btn-sm tool-active" data-draw-tool="free">Freehand</button>
    <button class="btn btn-sm" data-draw-tool="line">Line</button>
    <button class="btn btn-sm" data-draw-tool="erase">Eraser</button>
    <div class="draw-sep"></div>
    <span class="draw-colors">
      <span class="draw-swatch active" data-color="#4a9eff" style="background:#4a9eff;" title="Blue"></span>
      <span class="draw-swatch" data-color="#4aff8a" style="background:#4aff8a;" title="Green"></span>
      <span class="draw-swatch" data-color="#ff4a6a" style="background:#ff4a6a;" title="Red"></span>
      <span class="draw-swatch" data-color="#ffcc44" style="background:#ffcc44;" title="Yellow"></span>
      <span class="draw-swatch" data-color="#ffffff" style="background:#ffffff;" title="White"></span>
    </span>
    <div class="draw-sep"></div>
    <span class="draw-angle-wrap" id="draw-angle-wrap" style="display:none;">
      <label style="font-size:11px;color:var(--text-dim);">Angle</label>
      <input type="number" id="draw-angle-input" class="draw-angle-input" placeholder="—" min="0" max="360" step="1">
      <span style="font-size:11px;color:var(--text-dim);">°</span>
      <div class="draw-sep"></div>
    </span>
    <button class="btn btn-sm" id="draw-clear-all">Clear All</button>
    <button class="btn btn-sm" id="draw-close">✕</button>
  `;
  // Place toolbar relative to .annotate-main
  const annotateMain = videoGrid.parentElement;
  annotateMain.style.position = 'relative';
  annotateMain.insertBefore(drawToolbar, videoGrid);

  // Toolbar events
  drawToolbar.querySelectorAll('[data-draw-tool]').forEach(btn => {
    btn.addEventListener('click', () => setDrawTool(btn.dataset.drawTool));
  });
  drawToolbar.querySelectorAll('.draw-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      drawToolbar.querySelectorAll('.draw-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      drawColor = sw.dataset.color;
    });
  });
  document.getElementById('draw-angle-input').addEventListener('input', e => {
    const val = e.target.value.trim();
    lineAngle = val === '' ? null : parseFloat(val);
  });
  document.getElementById('draw-clear-all').addEventListener('click', clearAllDrawings);
  document.getElementById('draw-close').addEventListener('click', () => toggleDrawingMode(false));

  // Calibration popover (placed after toolbar in DOM)
  let calPopover = document.getElementById('calibration-popover');
  if (calPopover) calPopover.remove();
  calPopover = document.createElement('div');
  calPopover.id = 'calibration-popover';
  calPopover.className = 'calibration-popover';
  calPopover.innerHTML = `
    <span style="font-size:12px;color:var(--text-dim);">Ball diameter (m):</span>
    <input type="number" id="cal-height-input" value="0.22" step="0.001" min="0.01"
      style="width:70px;">
    <button class="btn btn-sm btn-primary" id="cal-set-btn">Set</button>
    <button class="btn btn-sm" id="cal-cancel-btn">Cancel</button>
  `;
  annotateMain.insertBefore(calPopover, videoGrid);

  document.getElementById('cal-set-btn').addEventListener('click', () => {
    if (!pendingCalibration) return;
    const val = parseFloat(document.getElementById('cal-height-input').value);
    if (isNaN(val) || val <= 0) {
      showToast('Enter a valid diameter');
      return;
    }
    calibrations.set(pendingCalibration.videoIdx, {
      cx: pendingCalibration.cx,
      cy: pendingCalibration.cy,
      rNorm: pendingCalibration.rNorm,
      diameter: val,
    });
    pendingCalibration = null;
    calPopover.classList.remove('visible');
    redrawAllCanvases();
    showToast(`Calibration set: Ø ${val} m`);
  });

  document.getElementById('cal-cancel-btn').addEventListener('click', () => {
    pendingCalibration = null;
    calPopover.classList.remove('visible');
    redrawAllCanvases();
  });

  document.getElementById('cal-height-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('cal-set-btn').click();
    }
  });

  // Build calibrate toolbar (separate from draw toolbar)
  let calToolbar = document.getElementById('calibrate-toolbar');
  if (calToolbar) calToolbar.remove();
  calToolbar = document.createElement('div');
  calToolbar.id = 'calibrate-toolbar';
  calToolbar.className = 'draw-toolbar';  // reuse draw-toolbar styling
  calToolbar.innerHTML = `
    <span style="font-size:12px;color:var(--text-dim);">Drag a circle around the ball</span>
    <div class="draw-sep"></div>
    <button class="btn btn-sm" id="cal-toggle-lines">${showCalibrationLines ? 'Hide' : 'Show'}</button>
    <button class="btn btn-sm" id="cal-clear-all">Clear All</button>
    <button class="btn btn-sm" id="cal-close">✕</button>
  `;
  annotateMain.insertBefore(calToolbar, videoGrid);

  document.getElementById('cal-toggle-lines').addEventListener('click', () => {
    showCalibrationLines = !showCalibrationLines;
    document.getElementById('cal-toggle-lines').textContent = showCalibrationLines ? 'Hide' : 'Show';
    redrawAllCanvases();
  });
  document.getElementById('cal-clear-all').addEventListener('click', () => {
    if (calibrations.size === 0 && !calibPending) { showToast('Nothing to clear'); return; }
    calibrations.clear();
    calibPending = null;
    redrawAllCanvases();
    showToast('All calibrations cleared');
  });
  document.getElementById('cal-close').addEventListener('click', () => toggleCalibrateMode(false));

  // Init canvases + ResizeObserver
  initDrawingCanvases();

  // Init zoom/pan events
  setupZoomEvents();

  // ── Compute master time range ──
  // masterTime = 0 at sync moment; negatives go back to start of earliest video.
  // For video[i] to show a valid time T+syncOffset[i] >= 0:
  //   T >= -syncOffset[i]  for all i  → masterMin = max(-syncOffset[i]) = -min(syncOffset[i])
  // For video[i] end:
  //   T <= duration[i] - syncOffset[i] for all i → masterMax = min(...)
  masterMin = Math.max(...videoItems.map(item => -item.syncOffset));
  masterMax = Math.min(...videoItems.map(item => item.el.duration - item.syncOffset));

  // Guard against bad values
  if (masterMin >= masterMax) masterMin = 0;

  masterScrubber.min  = masterMin;
  masterScrubber.max  = masterMax;
  masterScrubber.step = (1 / masterFPS).toFixed(6);

  seekToMaster(0);
  $('log-btn').disabled = false;
  renderAnnotations();
}

// ── Seek all videos to a given master time ────────────────

function seekToMaster(t) {
  masterTime = Math.max(masterMin, Math.min(masterMax, t));

  for (const item of videoItems) {
    const target  = masterTime + item.syncOffset;
    const clamped = Math.max(0, Math.min(item.el.duration, target));
    if (Math.abs(item.el.currentTime - clamped) > 0.001) {
      item.el.currentTime = clamped;
    }
  }

  updateTransportUI();
}

function updateTransportUI() {
  const frame = Math.round(masterTime * masterFPS);
  frameDisplay.textContent = `Frame ${frame}`;
  timeDisplay.textContent  = `${masterTime.toFixed(3)} s  (real ${toRealTime(masterTime).toFixed(3)} s)`;
  masterScrubber.value     = masterTime;
  highlightCurrentRow();
}

// ── Playback ─────────────────────────────────────────────

function startPlayback() {
  if (isPlaying) return;
  // Don't start at the very end
  if (masterTime >= masterMax) seekToMaster(masterMin);

  isPlaying = true;
  btnPlay.textContent = '⏸';
  btnPlay.title = 'Pause (Space)';

  const rate = parseFloat($('playback-rate').value);
  const frameAccurateMode = !!(frameAccurateModeInput && frameAccurateModeInput.checked);

  if (frameAccurateMode) {
    // In frame-accurate mode, advance exactly one frame per tick. If the browser
    // cannot sustain the requested rate, playback slows down instead of skipping.
    videoItems.forEach(item => item.el.pause());
    const frameStep = 1 / masterFPS;
    const intervalMs = Math.max(4, 1000 / (masterFPS * rate));
    frameAccurateTimer = setInterval(() => {
      if (!isPlaying) return;
      const nextTime = masterTime + frameStep;
      if (nextTime >= masterMax) {
        pausePlayback();
        seekToMaster(masterMax);
        return;
      }
      seekToMaster(nextTime);
    }, intervalMs);
    return;
  }

  videoItems.forEach(item => {
    const t = Math.max(0, Math.min(item.el.duration, masterTime + item.syncOffset));
    item.el.currentTime    = t;
    item.el.playbackRate   = rate;
    item.el.play().catch(() => {});
  });

  rafId = requestAnimationFrame(playbackLoop);
}

function pausePlayback() {
  if (!isPlaying) return;
  isPlaying = false;
  btnPlay.textContent = '▶';
  btnPlay.title = 'Play (Space)';
  cancelAnimationFrame(rafId);
  rafId = null;
  if (frameAccurateTimer !== null) {
    clearInterval(frameAccurateTimer);
    frameAccurateTimer = null;
  }
  videoItems.forEach(item => item.el.pause());
}

function playbackLoop() {
  if (!isPlaying) return;

  // First video is the master clock
  const master = videoItems[0].el;
  masterTime = master.currentTime - videoItems[0].syncOffset;

  if (masterTime >= masterMax || master.paused || master.ended) {
    pausePlayback();
    seekToMaster(Math.min(masterTime, masterMax));
    return;
  }

  // Sync secondary videos — correct if drifted > 80 ms
  for (let i = 1; i < videoItems.length; i++) {
    const item   = videoItems[i];
    const target = masterTime + item.syncOffset;
    const clamped = Math.max(0, Math.min(item.el.duration, target));
    if (Math.abs(item.el.currentTime - clamped) > 0.08) {
      item.el.currentTime = clamped;
    }
  }

  // Update UI at ~30 fps cadence to avoid janky layout
  updateTransportUI();

  rafId = requestAnimationFrame(playbackLoop);
}

// ── Transport controls ────────────────────────────────────

btnPlay .addEventListener('click', () => isPlaying ? pausePlayback() : startPlayback());

btnPrev.addEventListener('click', () => {
  pausePlayback();
  seekToMaster(masterTime - 1 / masterFPS);
});

btnNext.addEventListener('click', () => {
  pausePlayback();
  seekToMaster(masterTime + 1 / masterFPS);
});

btnStart.addEventListener('click', () => { pausePlayback(); seekToMaster(masterMin); });
btnEnd  .addEventListener('click', () => { pausePlayback(); seekToMaster(masterMax); });

masterScrubber.addEventListener('input', () => {
  pausePlayback();
  seekToMaster(parseFloat(masterScrubber.value));
});

$('playback-rate').addEventListener('change', function () {
  if (isPlaying) {
    const frameAccurateMode = !!(frameAccurateModeInput && frameAccurateModeInput.checked);
    if (frameAccurateMode) {
      // Restart interval to apply new frame cadence.
      pausePlayback();
      startPlayback();
    } else {
      const rate = parseFloat(this.value);
      videoItems.forEach(item => { item.el.playbackRate = rate; });
    }
  }
});

if (frameAccurateModeInput) {
  frameAccurateModeInput.addEventListener('change', () => {
    if (isPlaying) {
      // Switch playback engine immediately when toggled.
      pausePlayback();
      startPlayback();
    }
  });
}

$('btn-re-sync').addEventListener('click', () => {
  pausePlayback();
  // Rebuild sync screen (moves video elements back to sync panels)
  buildSyncScreen();
  showScreen('sync');
});

// ═══════════════════════════════════════════════════════════
// TOUCH SURFACE SELECTION
// ═══════════════════════════════════════════════════════════

$('touch-type-grid').querySelectorAll('.surface-btn').forEach(btn => {
  btn.addEventListener('click', () => selectTouchType(btn.dataset.touchType));
});
$('body-part-grid').querySelectorAll('.surface-btn').forEach(btn => {
  btn.addEventListener('click', () => selectBodyPart(btn.dataset.bodyPart));
});

function selectTouchType(name) {
  $('touch-type-grid').querySelectorAll('.surface-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.touchType === name);
  });
  selectedTouchType = name;

  const needsBodyPart = name === 'touch';
  $('body-part-section').style.display = needsBodyPart ? '' : 'none';
  if (!needsBodyPart) {
    selectedBodyPart = null;
    $('body-part-grid').querySelectorAll('.surface-btn').forEach(b => b.classList.remove('selected'));
  }

  // If editing an existing touch, update immediately
  if (editingAnnotationIdx !== null && annotations[editingAnnotationIdx]) {
    annotations[editingAnnotationIdx].touchType = name;
    if (!needsBodyPart) annotations[editingAnnotationIdx].bodyPart = null;
    renderAnnotations();
    showToast(`Updated: frame ${annotations[editingAnnotationIdx].frame}  ·  ${formatTouchLabel(name, annotations[editingAnnotationIdx].bodyPart)}`);
  }
}

function selectBodyPart(name) {
  $('body-part-grid').querySelectorAll('.surface-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.bodyPart === name);
  });
  selectedBodyPart = name;

  // If editing an existing touch, update immediately
  if (editingAnnotationIdx !== null && annotations[editingAnnotationIdx]) {
    annotations[editingAnnotationIdx].bodyPart = name;
    renderAnnotations();
    showToast(`Updated: frame ${annotations[editingAnnotationIdx].frame}  ·  ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════
// LOGGING TOUCHES
// ═══════════════════════════════════════════════════════════

$('log-btn').addEventListener('click', logTouch);

function logTouch() {
  const frame = Math.round(masterTime * masterFPS);
  const time  = parseFloat(masterTime.toFixed(6));

  // Warn if duplicate frame
  if (annotations.some(a => a.frame === frame)) {
    showToast(`Frame ${frame} already logged — delete it first`);
    return;
  }

  const touchType = selectedTouchType || null;
  const bodyPart  = touchType === 'touch' ? (selectedBodyPart || null) : null;
  annotations.push({ frame, time, touchType, bodyPart, height: null, heightUnit: null });
  annotations.sort((a, b) => a.frame - b.frame);

  // Auto-select the new touch for immediate editing
  editingAnnotationIdx = annotations.findIndex(a => a.frame === frame);

  renderAnnotations();
  const label = touchType ? formatTouchLabel(touchType, bodyPart) : 'select a touch type to assign it';
  showToast(`Logged: frame ${frame}  ·  ${label}`);
}

function formatTouchLabel(touchType, bodyPart) {
  if (!touchType) return '';
  if (touchType === 'bounce') return 'bounce';
  return bodyPart ? `${touchType} · ${bodyPart}` : touchType;
}

// ═══════════════════════════════════════════════════════════
// ANNOTATION LIST
// ═══════════════════════════════════════════════════════════

function renderAnnotations() {
  const list  = $('annotations-list');
  const count = annotations.length;

  $('ann-count').textContent  = count;
  $('export-csv').disabled    = count === 0;

  list.innerHTML = '';

  if (count === 0) {
    const empty = document.createElement('div');
    empty.className = 'ann-empty';
    empty.textContent = 'No touches logged yet';
    list.appendChild(empty);
    return;
  }

  const currentFrame = Math.round(masterTime * masterFPS);

  // Update sidebar heading to reflect edit mode
  const sectionTitle = $('touch-type-section-title');
  if (sectionTitle) {
    sectionTitle.textContent = editingAnnotationIdx !== null
      ? `Editing touch @ frame ${annotations[editingAnnotationIdx]?.frame ?? '?'}`
      : 'Touch Type';
  }

  annotations.forEach((ann, i) => {
    const isEditing = i === editingAnnotationIdx;

    let surfaceLabel;
    if (!ann.touchType) {
      surfaceLabel = '<span class="ann-unassigned">— assign type →</span>';
    } else {
      surfaceLabel = formatTouchLabel(ann.touchType, ann.bodyPart);
    }
    const heightLabel = ann.height != null
      ? ` <span class="ann-comment">${ann.height} ${ann.heightUnit || 'm'}</span>`
      : '';

    const row = document.createElement('div');
    row.className = 'annotation-row'
      + (ann.frame === currentFrame ? ' current' : '')
      + (isEditing ? ' editing' : '');
    row.dataset.frame = ann.frame;
    row.innerHTML = `
      <span class="ann-frame">${ann.frame}</span>
      <span class="ann-time">${ann.time.toFixed(3)}s (real ${toRealTime(ann.time).toFixed(3)}s)</span>
      <span class="ann-surface">${surfaceLabel}${heightLabel}</span>
      <button class="ann-del" title="Delete">✕</button>
    `;

    // Click row → seek to that touch AND select it for editing
    row.addEventListener('click', e => {
      if (e.target.classList.contains('ann-del')) return;
      pausePlayback();
      seekToMaster(ann.time);
      editingAnnotationIdx = i;
      // Reflect touch type in buttons
      $('touch-type-grid').querySelectorAll('.surface-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.touchType === ann.touchType);
      });
      // Reflect body part in buttons and show/hide section
      const needsBodyPart = ann.touchType === 'touch';
      $('body-part-section').style.display = needsBodyPart ? '' : 'none';
      $('body-part-grid').querySelectorAll('.surface-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.bodyPart === ann.bodyPart);
      });
      selectedTouchType = ann.touchType;
      selectedBodyPart  = ann.bodyPart;
      renderAnnotations();
    });

    row.querySelector('.ann-del').addEventListener('click', e => {
      e.stopPropagation();
      annotations.splice(i, 1);
      if (editingAnnotationIdx === i) editingAnnotationIdx = null;
      else if (editingAnnotationIdx > i) editingAnnotationIdx--;
      renderAnnotations();
    });

    list.appendChild(row);
  });

  updateHeightSection();
}

function updateHeightSection() {
  const section = $('height-section');
  if (!section) return;

  if (editingAnnotationIdx === null) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  const ann = annotations[editingAnnotationIdx];
  if (!ann) { section.style.display = 'none'; return; }

  const input = $('height-input');
  const unitLabel = $('height-unit-label');

  input.value = ann.height != null ? ann.height : '';
  unitLabel.textContent = ann.heightUnit || 'm';
}

function highlightCurrentRow() {
  if ($('annotate-screen').classList.contains('active')) {
    const currentFrame = Math.round(masterTime * masterFPS);
    document.querySelectorAll('.annotation-row').forEach(row => {
      row.classList.toggle('current', parseInt(row.dataset.frame) === currentFrame);
    });
  }
}

// ═══════════════════════════════════════════════════════════
// REVIEW MODE — load videos + CSV to restore a session
// ═══════════════════════════════════════════════════════════

// Normalize a filename for fuzzy matching: lowercase, strip extension, collapse separators
function normalizeName(name) {
  return name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[_\s-]+/g, ' ').trim();
}

// Parse a single CSV row, handling double-quoted fields
function parseCsvRow(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// Parse the CSV text into structured data.
// Returns: { meta, videoCols, annotations, perVideoFrames } or null on hard failure.
function parseReviewCsv(text) {
  const lines = text.split(/\r?\n/);

  let meta = null;
  let headers = null;
  const dataLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#meta ')) {
      try { meta = JSON.parse(trimmed.slice(6)); } catch { /* ignore bad meta */ }
    } else if (trimmed.startsWith('#')) {
      continue;  // other comment lines
    } else if (!headers) {
      headers = parseCsvRow(trimmed);
    } else {
      dataLines.push(trimmed);
    }
  }

  if (!headers) return null;

  const colFrame     = headers.indexOf('frame');
  const colTime      = headers.indexOf('time_s');
  const colTouchType = headers.indexOf('touch_type');
  const colBodyPart  = headers.indexOf('body_part');
  const colHeight     = headers.indexOf('height');
  const colHeightUnit = headers.indexOf('height_unit');

  if (colFrame < 0 || colTime < 0) return null;

  // Find per-video frame columns: frame_N_<name>
  const videoCols = headers
    .map((h, idx) => { const m = h.match(/^frame_(\d+)_(.+)$/); return m ? { idx, n: parseInt(m[1]), name: m[2] } : null; })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);

  const annotations   = [];
  const perVideoFrames = [];  // parallel array of per-video frame values for each annotation

  for (const line of dataLines) {
    const cols = parseCsvRow(line);
    const frame   = parseInt(cols[colFrame]);
    const time    = parseFloat(cols[colTime]);
    if (isNaN(frame) || isNaN(time)) continue;

    const touchType = (colTouchType >= 0 ? cols[colTouchType] : '') || null;
    const bodyPart  = (colBodyPart >= 0 ? cols[colBodyPart] : '') || null;
    const rawHeight = colHeight >= 0 ? cols[colHeight] : '';
    const height = rawHeight ? parseFloat(rawHeight) : null;
    const heightUnit = (colHeightUnit >= 0 && cols[colHeightUnit]) ? cols[colHeightUnit] : null;

    annotations.push({ frame, time, touchType, bodyPart, height: isNaN(height) ? null : height, heightUnit });
    perVideoFrames.push(videoCols.map(vc => parseInt(cols[vc.idx])));
  }

  return { meta, videoCols, annotations, perVideoFrames };
}

// Match metaVideos (from #meta) to videoItems by name. Sets fps + syncOffset.
// Returns true on success, false on unrecoverable mismatch.
function applyMetaToVideos(metaVideos) {
  for (const mv of metaVideos) {
    const mvNorm = normalizeName(mv.name);
    let match = videoItems.find(v => normalizeName(v.name) === mvNorm);
    if (!match) {
      match = videoItems.find(v => {
        const vn = normalizeName(v.name);
        return vn.includes(mvNorm) || mvNorm.includes(vn);
      });
    }
    if (!match) {
      showToast(`Could not match "${mv.name}" from CSV to any uploaded video`);
      return false;
    }
    match.fps        = mv.fps;
    match.syncOffset = mv.syncOffset;
  }

  // Any videoItem not matched gets a fallback (0 offset, 25 fps)
  for (const item of videoItems) {
    if (item.fps === null) {
      item.fps        = 25;
      item.syncOffset = 0;
      showToast(`No sync info for "${item.name}" — defaulting to offset 0`);
    }
  }
  return true;
}

// Fallback for CSVs without #meta: derive sync offsets from per-video frame columns.
// Requires fps to already be detected and stored on each videoItem.
function deriveSyncOffsetsFromCsv(parsed) {
  if (parsed.videoCols.length === 0) {
    // No per-video columns — assume all offsets are 0
    videoItems.forEach(v => { v.syncOffset = 0; });
    return true;
  }

  if (parsed.videoCols.length !== videoItems.length) {
    showToast(`CSV has ${parsed.videoCols.length} video column(s) but ${videoItems.length} video(s) uploaded`);
    return false;
  }

  // Match CSV column names to videoItems (by fuzzy name)
  const mapping = [];  // mapping[csvColArrayIdx] = videoItemIdx
  for (let ci = 0; ci < parsed.videoCols.length; ci++) {
    const colNorm = normalizeName(parsed.videoCols[ci].name);
    let idx = videoItems.findIndex(v => normalizeName(v.name) === colNorm);
    if (idx < 0) idx = videoItems.findIndex(v => { const vn = normalizeName(v.name); return vn.includes(colNorm) || colNorm.includes(vn); });
    if (idx < 0) {
      showToast(`Could not match video column "${parsed.videoCols[ci].name}" — upload files with matching names`);
      return false;
    }
    mapping[ci] = idx;
  }

  // Accumulate offset estimates across all annotations, then take the median
  const offsetBuckets = videoItems.map(() => []);
  for (let r = 0; r < parsed.annotations.length; r++) {
    const ann    = parsed.annotations[r];
    const frames = parsed.perVideoFrames[r];
    for (let ci = 0; ci < parsed.videoCols.length; ci++) {
      const fv  = frames[ci];
      const vi  = mapping[ci];
      const fps = videoItems[vi].fps;
      if (!isNaN(fv) && fps > 0) {
        offsetBuckets[vi].push(fv / fps - ann.time);
      }
    }
  }

  for (let i = 0; i < videoItems.length; i++) {
    const vals = offsetBuckets[i].sort((a, b) => a - b);
    videoItems[i].syncOffset = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }
  return true;
}

async function startReviewSession() {
  let csvText;
  try {
    csvText = await pendingCsvFile.text();
  } catch {
    showToast('Could not read CSV file');
    return;
  }

  const parsed = parseReviewCsv(csvText);
  if (!parsed) {
    showToast('Could not parse CSV — check the file format');
    return;
  }
  if (parsed.annotations.length === 0) {
    showToast('CSV contains no annotation rows');
    return;
  }

  $('fps-overlay').classList.add('show');
  $('fps-status').textContent = 'Preparing videos…';

  // Create video elements + wait for metadata (duration etc.)
  for (const item of videoItems) {
    if (!item.objectUrl) item.objectUrl = URL.createObjectURL(item.file);
    if (!item.el) {
      const video = document.createElement('video');
      video.src        = item.objectUrl;
      video.preload    = 'auto';
      video.muted      = true;
      video.playsInline = true;
      video.controls   = false;
      item.el = video;
      await waitForMetadata(video);
    }
  }

  let ok;
  if (parsed.meta && Array.isArray(parsed.meta.videos)) {
    // New-format CSV: sync info embedded — no FPS detection needed
    $('fps-status').textContent = 'Restoring sync from CSV…';
    ok = applyMetaToVideos(parsed.meta.videos);
  } else {
    // Old-format CSV: detect FPS then derive offsets from per-video frame columns
    showToast('CSV has no sync metadata — detecting FPS to approximate sync');
    for (let i = 0; i < videoItems.length; i++) {
      $('fps-status').textContent = `Detecting FPS — video ${i + 1} / ${videoItems.length}…`;
      videoItems[i].fps = await detectFPS(videoItems[i].el);
      $('fps-status').textContent = `Video ${i + 1}: ${videoItems[i].fps} fps ✓`;
      await sleep(350);
    }
    ok = deriveSyncOffsetsFromCsv(parsed);
  }

  $('fps-overlay').classList.remove('show');
  if (!ok) return;

  const metaFactor = parsed.meta ? parseFloat(parsed.meta.realTimeFactor) : NaN;
  if (Number.isFinite(metaFactor) && metaFactor > 0) {
    realTimeFactor = metaFactor;
  } else {
    realTimeFactor = 1;
  }
  if (realTimeFactorInput) {
    realTimeFactorInput.value = String(realTimeFactor);
  }

  masterFPS   = videoItems[0].fps;
  annotations = parsed.annotations;

  buildAnnotateScreen();
  showScreen('annotate');
  showToast(`Loaded ${annotations.length} touch${annotations.length !== 1 ? 'es' : ''} from CSV`);
}

// ═══════════════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════════════

$('export-csv').addEventListener('click', () => {
  if (annotations.length === 0) return;

  // Per-video header names: strip extension, deduplicate if needed
  const videoHeaders = videoItems.map((item, i) => {
    const base = item.name.replace(/\.[^.]+$/, '').replace(/,/g, ';');
    return `frame_${i + 1}_${base}`;
  });

  const headers = ['frame', 'time_s', 'real_time_s', 'touch_type', 'body_part', 'height', 'height_unit', ...videoHeaders];

  const dataRows = annotations.map(a => {
    const perVideoFrames = videoItems.map(item => {
      const localTime = a.time + item.syncOffset;
      return Math.round(localTime * item.fps);
    });

    return [
      a.frame,
      a.time.toFixed(6),
      toRealTime(a.time).toFixed(6),
      a.touchType ?? '',
      a.bodyPart ?? '',
      a.height ?? '',
      a.heightUnit ?? '',
      ...perVideoFrames,
    ];
  });

  // Prepend sync metadata so the CSV can be reloaded to restore the session
  const metaObj = {
    videos: videoItems.map(item => ({
      name: item.name,
      syncOffset: item.syncOffset,
      fps: item.fps,
    })),
    realTimeFactor,
  };
  const metaLine = '#meta ' + JSON.stringify(metaObj);

  const rows = [headers, ...dataRows];
  const csv  = metaLine + '\r\n' + rows.map(r => r.join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href     = url;
  a.download = `touches_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${annotations.length} touch${annotations.length !== 1 ? 'es' : ''}`);
});

if (realTimeFactorInput) {
  realTimeFactorInput.addEventListener('change', () => {
    const val = parseFloat(realTimeFactorInput.value);
    if (Number.isFinite(val) && val > 0) {
      realTimeFactor = val;
    } else {
      realTimeFactor = 1;
      realTimeFactorInput.value = '1';
    }
    updateTransportUI();
    renderAnnotations();
  });
}

$('clear-all').addEventListener('click', () => {
  if (annotations.length === 0) return;
  if (confirm(`Delete all ${annotations.length} annotation${annotations.length !== 1 ? 's' : ''}?`)) {
    annotations = [];
    renderAnnotations();
  }
});

// ═══════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS  (only active in Annotate screen)
// ═══════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  if (!$('annotate-screen').classList.contains('active')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      isPlaying ? pausePlayback() : startPlayback();
      break;

    case 'ArrowLeft':
      e.preventDefault();
      pausePlayback();
      seekToMaster(masterTime - 1 / masterFPS);
      break;

    case 'ArrowRight':
      e.preventDefault();
      pausePlayback();
      seekToMaster(masterTime + 1 / masterFPS);
      break;

    // Jump 1 second
    case 'ArrowUp':
      e.preventDefault();
      pausePlayback();
      seekToMaster(masterTime - 1);
      break;

    case 'ArrowDown':
      e.preventDefault();
      pausePlayback();
      seekToMaster(masterTime + 1);
      break;

    case 't':
    case 'T':
      logTouch();
      break;

    // Touch type shortcuts: 1–3, Body part: 4–8
    case '1': selectTouchType('bounce');  break;
    case '2': selectTouchType('kick');    break;
    case '3': selectTouchType('touch');   break;
    case '4': selectBodyPart('foot');     break;
    case '5': selectBodyPart('knee');     break;
    case '6': selectBodyPart('chest');    break;
    case '7': selectBodyPart('arm');      break;
    case '8': selectBodyPart('head');     break;
    case '0': resetAllZoom();         break;
    case '?':
    case 'h':
    case 'H':
      openHelp('annotate');
      break;

    // Drawing mode shortcuts
    case 'd':
    case 'D':
      toggleDrawingMode();
      break;
    case 'f':
    case 'F':
      if (drawingMode) setDrawTool('free');
      break;
    case 'l':
    case 'L':
      if (drawingMode) setDrawTool('line');
      break;
    case 'e':
    case 'E':
      if (drawingMode) setDrawTool('erase');
      break;
    case 'c':
    case 'C':
      toggleCalibrateMode();
      break;
    case 'Delete':
    case 'Backspace':
      if (drawingMode) deleteSelectedDrawing();
      break;
    case 'Enter':
      if (calibrateMode && calibPending &&
          !document.getElementById('calibration-popover')?.classList.contains('visible')) {
        e.preventDefault();
        pendingCalibration = { cx: calibPending.cx, cy: calibPending.cy,
                               rNorm: calibPending.rNorm, videoIdx: calibPending.videoIdx };
        calibPending = null;
        showCalibrationPopover();
      }
      break;
    case 'Escape':
      if (measureMode) {
        e.preventDefault();
        exitMeasureMode();
      } else if (pendingCalibration) {
        e.preventDefault();
        pendingCalibration = null;
        const calPop = document.getElementById('calibration-popover');
        if (calPop) calPop.classList.remove('visible');
        redrawAllCanvases();
      } else if (calibrateMode) {
        e.preventDefault();
        if (calibPending) {
          calibPending = null;
          redrawAllCanvases();
        } else {
          toggleCalibrateMode(false);
        }
      } else if (drawingMode) {
        e.preventDefault();
        if (lineStartPoint) {
          lineStartPoint = null;
          lineStartVideoIdx = null;
          redrawAllCanvases();
        } else if (deselectAllDrawings()) {
          // Deselected something
        } else {
          toggleDrawingMode(false);
        }
      }
      break;
  }
});

// ═══════════════════════════════════════════════════════════
// DRAWING OVERLAY
// ═══════════════════════════════════════════════════════════

function initDrawingCanvases() {
  drawingData.forEach((data, idx) => {
    const canvas = data.canvas;
    data.ctx = canvas.getContext('2d');
    sizeCanvas(canvas);
    setupCanvasEvents(canvas, idx);
  });

  // ResizeObserver to keep canvas pixel size in sync
  const ro = new ResizeObserver(() => {
    drawingData.forEach(data => {
      sizeCanvas(data.canvas);
    });
    redrawAllCanvases();
  });
  ro.observe(document.getElementById('video-grid'));
}

function sizeCanvas(canvas) {
  const cell = canvas.closest('.video-cell');
  canvas.width = cell.clientWidth;
  canvas.height = cell.clientHeight;
}

function toggleDrawingMode(forceState) {
  drawingMode = forceState !== undefined ? forceState : !drawingMode;

  // Toggle button state
  const btn = document.getElementById('btn-draw');
  if (drawingMode) {
    btn.classList.add('btn-primary');
    // Exit calibrate mode if active (mutually exclusive)
    if (calibrateMode) toggleCalibrateMode(false);
  } else {
    btn.classList.remove('btn-primary');
    lineStartPoint = null;
    lineStartVideoIdx = null;
    deselectAllDrawings();
  }

  // Toggle toolbar visibility
  const toolbar = document.getElementById('draw-toolbar');
  if (toolbar) toolbar.classList.toggle('visible', drawingMode);

  // Toggle canvas pointer events
  drawingData.forEach(data => {
    data.canvas.classList.toggle('active', drawingMode);
  });

  // Update zoom cursors
  zoomStates.forEach(state => {
    const cell = state.container.parentElement;
    cell.style.cursor = (!drawingMode && !calibrateMode && state.scale > 1) ? 'grab' : '';
  });

  redrawAllCanvases();
}

function toggleCalibrateMode(forceState) {
  calibrateMode = forceState !== undefined ? forceState : !calibrateMode;

  const btn = document.getElementById('btn-calibrate');
  if (calibrateMode) {
    btn.classList.add('btn-primary');
    // Exit draw mode if active (mutually exclusive)
    if (drawingMode) toggleDrawingMode(false);
  } else {
    btn.classList.remove('btn-primary');
    calibCircleStart = null;
    calibCircleVideoIdx = null;
    calibPending = null;
    calibDragMode = null;
    pendingCalibration = null;
    const calPopover = document.getElementById('calibration-popover');
    if (calPopover) calPopover.classList.remove('visible');
  }

  // Toggle calibrate toolbar visibility
  const calToolbar = document.getElementById('calibrate-toolbar');
  if (calToolbar) calToolbar.classList.toggle('visible', calibrateMode);

  // Toggle canvas pointer events
  drawingData.forEach(data => {
    if (calibrateMode) {
      data.canvas.classList.add('active');
    } else if (!drawingMode) {
      data.canvas.classList.remove('active');
    }
  });

  // Update zoom cursors
  zoomStates.forEach(state => {
    const cell = state.container.parentElement;
    cell.style.cursor = (!drawingMode && !calibrateMode && state.scale > 1) ? 'grab' : '';
  });

  redrawAllCanvases();
}

function setDrawTool(tool) {
  drawToolMode = tool;
  // Cancel any in-progress line when switching tools
  lineStartPoint = null;
  lineStartVideoIdx = null;

  const toolbar = document.getElementById('draw-toolbar');
  if (!toolbar) return;
  toolbar.querySelectorAll('[data-draw-tool]').forEach(btn => {
    btn.classList.toggle('tool-active', btn.dataset.drawTool === tool);
  });

  // Update cursor style on canvases
  drawingData.forEach(data => {
    data.canvas.classList.toggle('erase', tool === 'erase');
  });

  // Show angle input only for line tool
  const angleWrap = document.getElementById('draw-angle-wrap');
  if (angleWrap) angleWrap.style.display = tool === 'line' ? '' : 'none';

  redrawAllCanvases();
}

function clearAllDrawings() {
  drawingData.forEach(data => {
    data.elements = [];
    data.selectedIdx = -1;
  });
  lineStartPoint = null;
  lineStartVideoIdx = null;
  redrawAllCanvases();
  showToast('All drawings cleared');
}

function deleteSelectedDrawing() {
  for (const [, data] of drawingData) {
    if (data.selectedIdx >= 0 && data.selectedIdx < data.elements.length) {
      data.elements.splice(data.selectedIdx, 1);
      data.selectedIdx = -1;
      redrawAllCanvases();
      return;
    }
  }
}

function deselectAllDrawings() {
  let hadSelection = false;
  drawingData.forEach(data => {
    if (data.selectedIdx >= 0) hadSelection = true;
    data.selectedIdx = -1;
  });
  if (hadSelection) redrawAllCanvases();
  return hadSelection;
}

// ── Canvas mouse/pointer events ──

function setupCanvasEvents(canvas, videoIdx) {
  let isDragging = false;
  let dragStartPx = null; // {x,y} in pixels
  let currentStroke = null; // freehand points being drawn

  canvas.addEventListener('mousedown', e => {
    if (!drawingMode && !measureMode && !calibrateMode) return;
    const rect = canvas.getBoundingClientRect();
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const norm = { x: px.x / rect.width, y: px.y / rect.height };

    dragStartPx = px;
    isDragging = false;
    currentStroke = null;

    // Calibrate mode: determine interaction with pending circle or start new
    if (calibrateMode) {
      if (calibPending && calibPending.videoIdx === videoIdx) {
        const cW = canvas.width, cH = canvas.height;
        const dx = (norm.x - calibPending.cx) * cW;
        const dy = (norm.y - calibPending.cy) * cH;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const rPx = calibPending.rNorm * cH;
        if (dist < rPx * 0.7) {
          calibDragMode = 'move';
          calibDragOffset = { dx: norm.x - calibPending.cx, dy: norm.y - calibPending.cy };
        } else if (dist < rPx * 1.5) {
          calibDragMode = 'resize';
        } else {
          calibDragMode = 'new';
          calibCircleStart = norm;
          calibCircleVideoIdx = videoIdx;
        }
      } else {
        calibDragMode = 'new';
        calibCircleStart = norm;
        calibCircleVideoIdx = videoIdx;
      }
    }

    if (drawingMode && drawToolMode === 'free') {
      currentStroke = [norm];
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!drawingMode && !measureMode && !calibrateMode) return;
    const rect = canvas.getBoundingClientRect();
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const norm = { x: px.x / rect.width, y: px.y / rect.height };

    // Check if we've moved enough to count as a drag
    if (dragStartPx) {
      const dx = px.x - dragStartPx.x;
      const dy = px.y - dragStartPx.y;
      if (Math.sqrt(dx * dx + dy * dy) > 5) {
        isDragging = true;
      }
    }

    // Measurement mode
    if (measureMode) {
      if (measureFirstClick && measureFirstClick.videoIdx === videoIdx) {
        // Post-click-1: rubber-band line from ground point to cursor
        redrawCanvas(videoIdx);  // draws perpendicular + ground dot
        const mCtx = drawingData.get(videoIdx).ctx;
        mCtx.save();
        mCtx.strokeStyle = '#4aff8a';
        mCtx.lineWidth = 2;
        mCtx.setLineDash([4, 3]);
        mCtx.beginPath();
        mCtx.moveTo(measureFirstClick.x * canvas.width, measureFirstClick.y * canvas.height);
        mCtx.lineTo(norm.x * canvas.width, norm.y * canvas.height);
        mCtx.stroke();
        mCtx.restore();
        return;
      } else if (!measureFirstClick && calibrations.has(videoIdx)) {
        // Pre-click-1: float the perpendicular line with the cursor
        measureHoverPt = { x: norm.x, y: norm.y, videoIdx };
        redrawCanvas(videoIdx);
        return;
      }
    }

    // Calibrate mode: move / resize / draw new circle
    if (calibrateMode && isDragging && calibDragMode) {
      const cCtx = drawingData.get(videoIdx).ctx;
      const W = canvas.width, H = canvas.height;

      if (calibDragMode === 'move' && calibPending) {
        calibPending.cx = norm.x - calibDragOffset.dx;
        calibPending.cy = norm.y - calibDragOffset.dy;
        redrawCanvas(videoIdx);
        return;
      }
      if (calibDragMode === 'resize' && calibPending) {
        const dx = norm.x * W - calibPending.cx * W;
        const dy = norm.y * H - calibPending.cy * H;
        calibPending.rNorm = Math.max(5 / H, Math.sqrt(dx * dx + dy * dy) / H);
        redrawCanvas(videoIdx);
        return;
      }
      if (calibDragMode === 'new' && calibCircleStart && calibCircleVideoIdx === videoIdx) {
        redrawCanvas(videoIdx);
        const cx = calibCircleStart.x * W, cy = calibCircleStart.y * H;
        const r = Math.sqrt((norm.x * W - cx) ** 2 + (norm.y * H - cy) ** 2);
        if (r > 3) {
          cCtx.save();
          cCtx.strokeStyle = '#4aff8a';
          cCtx.lineWidth = 2;
          cCtx.beginPath();
          cCtx.arc(cx, cy, r, 0, Math.PI * 2);
          cCtx.stroke();
          cCtx.fillStyle = '#4aff8a';
          cCtx.beginPath();
          cCtx.arc(cx, cy, 3, 0, Math.PI * 2);
          cCtx.fill();
          cCtx.restore();
        }
        return;
      }
    }

    if (!drawingMode) return;

    if (drawToolMode === 'free' && isDragging && currentStroke) {
      currentStroke.push(norm);
      // Draw preview
      redrawCanvas(videoIdx);
      drawFreehandPreview(drawingData.get(videoIdx).ctx, canvas, currentStroke);
    }

    // Rubber-band preview for line tool
    if (drawToolMode === 'line' && lineStartPoint && lineStartVideoIdx === videoIdx) {
      redrawCanvas(videoIdx);
      drawLinePreview(drawingData.get(videoIdx).ctx, canvas, lineStartPoint, snapLineEnd(lineStartPoint, norm));
    }
  });

  canvas.addEventListener('mouseup', e => {
    if (!drawingMode && !measureMode && !calibrateMode) return;
    const rect = canvas.getBoundingClientRect();
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const norm = { x: px.x / rect.width, y: px.y / rect.height };

    // Handle measurement clicks first
    if (measureMode && !isDragging) {
      handleMeasureClick(videoIdx, norm);
      currentStroke = null;
      dragStartPx = null;
      isDragging = false;
      return;
    }

    // Handle calibration: store adjustable circle (popover on Enter)
    if (calibrateMode) {
      if (calibDragMode === 'new' && isDragging && calibCircleStart && calibCircleVideoIdx === videoIdx) {
        const W = canvas.width, H = canvas.height;
        const rPx = Math.sqrt(
          (norm.x * W - calibCircleStart.x * W) ** 2 +
          (norm.y * H - calibCircleStart.y * H) ** 2
        );
        if (rPx > 5) {
          calibPending = {
            cx: calibCircleStart.x,
            cy: calibCircleStart.y,
            rNorm: rPx / H,
            videoIdx,
          };
          showToast('Drag inside to move, edge to resize — Enter to confirm');
        }
      }
      // move / resize already updated during mousemove
      calibDragMode = null;
      calibDragOffset = null;
      calibCircleStart = null;
      calibCircleVideoIdx = null;
      currentStroke = null;
      dragStartPx = null;
      isDragging = false;
      redrawAllCanvases();
      return;
    }

    if (!drawingMode) {
      currentStroke = null;
      dragStartPx = null;
      isDragging = false;
      return;
    }

    const data = drawingData.get(videoIdx);

    if (drawToolMode === 'free') {
      if (isDragging && currentStroke && currentStroke.length > 1) {
        // Finalize freehand stroke
        data.elements.push({ type: 'freehand', points: currentStroke, color: drawColor });
        data.selectedIdx = -1;
      } else if (!isDragging) {
        // Click — try to select
        trySelectElement(videoIdx, norm);
      }
    }

    if (drawToolMode === 'erase' && !isDragging) {
      // Click near an element to erase it
      const threshold = 0.02;
      let bestIdx = -1, bestDist = Infinity;
      data.elements.forEach((el, i) => {
        const d = distToElement(el, norm);
        if (d < threshold && d < bestDist) { bestDist = d; bestIdx = i; }
      });
      if (bestIdx >= 0) data.elements.splice(bestIdx, 1);
    }

    if (drawToolMode === 'line' && !isDragging) {
      if (!lineStartPoint || lineStartVideoIdx !== videoIdx) {
        // First click — set start
        lineStartPoint = norm;
        lineStartVideoIdx = videoIdx;
      } else {
        // Second click — finalize line (snap angle if set)
        const endPt = snapLineEnd(lineStartPoint, norm);
        data.elements.push({ type: 'line', start: lineStartPoint, end: endPt, color: drawColor });
        data.selectedIdx = -1;
        lineStartPoint = null;
        lineStartVideoIdx = null;
      }
    }

    currentStroke = null;
    dragStartPx = null;
    isDragging = false;
    redrawAllCanvases();
  });

  canvas.addEventListener('mouseleave', () => {
    if (currentStroke && isDragging && drawToolMode === 'free') {
      // Finalize stroke on leave
      const data = drawingData.get(videoIdx);
      if (currentStroke.length > 1) {
        data.elements.push({ type: 'freehand', points: currentStroke, color: drawColor });
        data.selectedIdx = -1;
      }
      currentStroke = null;
      dragStartPx = null;
      isDragging = false;
      redrawAllCanvases();
    }
  });
}

function trySelectElement(videoIdx, clickNorm) {
  const data = drawingData.get(videoIdx);
  const threshold = 0.02; // 2% of canvas dimension
  let bestIdx = -1;
  let bestDist = Infinity;

  data.elements.forEach((el, i) => {
    const dist = distToElement(el, clickNorm);
    if (dist < threshold && dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  });

  // Deselect all first
  drawingData.forEach(d => d.selectedIdx = -1);
  data.selectedIdx = bestIdx;
}

function distToElement(el, pt) {
  if (el.type === 'line') {
    return distPointToSegment(pt, el.start, el.end);
  }
  // Freehand: min distance to any segment
  let minD = Infinity;
  for (let i = 0; i < el.points.length - 1; i++) {
    const d = distPointToSegment(pt, el.points[i], el.points[i + 1]);
    if (d < minD) minD = d;
  }
  return minD;
}

function distPointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.sqrt((p.x - proj.x) ** 2 + (p.y - proj.y) ** 2);
}

// ── Rendering ──

function redrawAllCanvases() {
  drawingData.forEach((_, idx) => redrawCanvas(idx));
}

function redrawCanvas(videoIdx) {
  const data = drawingData.get(videoIdx);
  if (!data) return;
  const { ctx, canvas, elements, selectedIdx } = data;

  const cal = calibrations.get(videoIdx);
  const hasMeasureState = measureFirstClick && measureFirstClick.videoIdx === videoIdx;

  // Hide canvas when not needed — avoids browser compositing issues with video
  const hasContent = elements.length > 0
    || (lineStartPoint && lineStartVideoIdx === videoIdx)
    || (calibCircleStart && calibCircleVideoIdx === videoIdx)
    || (cal && showCalibrationLines) || hasMeasureState;
  const needsCanvas = drawingMode || measureMode || calibrateMode || hasContent;
  canvas.style.display = needsCanvas ? '' : 'none';
  if (!needsCanvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw calibration circle (underneath drawings)
  if (cal && showCalibrationLines) {
    const opacity = (drawingMode || calibrateMode) ? 1.0 : 0.4;
    drawCalibrationCircle(ctx, canvas, cal, opacity);
  }

  elements.forEach((el, i) => {
    const isSelected = i === selectedIdx;
    const color = el.color || '#4a9eff';
    if (el.type === 'freehand') {
      drawFreehandElement(ctx, canvas, el.points, isSelected, color);
    } else if (el.type === 'line') {
      drawLineElement(ctx, canvas, el.start, el.end, isSelected, color);
    }
  });

  // Draw start-point dot for in-progress line
  if (lineStartPoint && lineStartVideoIdx === videoIdx) {
    ctx.fillStyle = drawColor;
    ctx.beginPath();
    ctx.arc(lineStartPoint.x * canvas.width, lineStartPoint.y * canvas.height, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw adjustable pending calibration circle (green, before Enter confirm)
  if (calibPending && calibPending.videoIdx === videoIdx) {
    const cpx = calibPending.cx * canvas.width;
    const cpy = calibPending.cy * canvas.height;
    const rPx = calibPending.rNorm * canvas.height;
    ctx.save();
    ctx.strokeStyle = '#4aff8a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cpx, cpy, rPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#4aff8a';
    ctx.beginPath();
    ctx.arc(cpx, cpy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Draw perpendicular ground-reference line
  if (measureMode && cal) {
    const perpPt = hasMeasureState ? measureFirstClick
                 : (measureHoverPt && measureHoverPt.videoIdx === videoIdx) ? measureHoverPt
                 : null;
    if (perpPt) drawMeasurePerp(ctx, canvas, cal, perpPt, hasMeasureState);
  }

  // Draw measurement ground-point dot (after click 1)
  if (hasMeasureState) {
    ctx.fillStyle = '#4aff8a';
    ctx.beginPath();
    ctx.arc(measureFirstClick.x * canvas.width, measureFirstClick.y * canvas.height, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Draw a horizontal dashed ground-reference line through `pt`.
 * Height direction is vertical, so the perpendicular is horizontal.
 */
function drawMeasurePerp(ctx, canvas, cal, pt, fixed) {
  const W = canvas.width, H = canvas.height;
  const py = pt.y * H;

  ctx.save();
  ctx.strokeStyle = fixed ? 'rgba(74, 255, 138, 0.7)' : 'rgba(74, 255, 138, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(0, py);
  ctx.lineTo(W, py);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawFreehandElement(ctx, canvas, points, selected, color) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 4 : 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (selected) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLineElement(ctx, canvas, start, end, selected, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 4 : 2;
  ctx.lineCap = 'round';
  if (selected) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
  }
  ctx.beginPath();
  ctx.moveTo(start.x * canvas.width, start.y * canvas.height);
  ctx.lineTo(end.x * canvas.width, end.y * canvas.height);
  ctx.stroke();
  ctx.restore();
}

function drawFreehandPreview(ctx, canvas, points) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = drawColor;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLinePreview(ctx, canvas, start, end) {
  ctx.save();
  ctx.strokeStyle = drawColor;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(start.x * canvas.width, start.y * canvas.height);
  ctx.lineTo(end.x * canvas.width, end.y * canvas.height);
  ctx.stroke();
  ctx.restore();
}

function snapLineEnd(start, end) {
  if (lineAngle === null) return end;
  const rad = lineAngle * Math.PI / 180;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return end;
  return { x: start.x + Math.cos(rad) * len, y: start.y + Math.sin(rad) * len };
}

// ── Calibration & height measurement ──

function drawCalibrationCircle(ctx, canvas, cal, opacity) {
  const W = canvas.width, H = canvas.height;
  const cx = cal.cx * W, cy = cal.cy * H;
  const r  = cal.rNorm * H;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Circle outline
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Center dot
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();

  // Label above circle
  const label = `Ø ${cal.diameter} m`;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const metrics = ctx.measureText(label);
  const pad = 4;
  const ly = cy - r - 6;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(cx - metrics.width / 2 - pad, ly - 14, metrics.width + pad * 2, 16 + pad);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, ly + pad);
  ctx.restore();
}

function showCalibrationPopover() {
  const popover = document.getElementById('calibration-popover');
  if (!popover) return;
  const existing = pendingCalibration ? calibrations.get(pendingCalibration.videoIdx) : null;
  document.getElementById('cal-height-input').value = existing ? existing.diameter : '0.22';
  popover.classList.add('visible');
  document.getElementById('cal-height-input').focus();
}

function computeHeight(videoIdx, pt1, pt2) {
  const cal = calibrations.get(videoIdx);
  if (!cal || !cal.rNorm || cal.rNorm <= 0) return null;
  // Scale: diameter / (2 × rNorm) gives metres per unit of normY.
  // Height = vertical displacement × scale.
  return Math.abs(pt1.y - pt2.y) * cal.diameter / (2 * cal.rNorm);
}

function enterMeasureMode() {
  measureMode = true;
  measureFirstClick = null;
  measureHoverPt = null;

  // Enable canvases on calibrated videos
  drawingData.forEach((data, idx) => {
    if (calibrations.has(idx)) {
      data.canvas.classList.add('measure-active');
    }
  });

  showToast('Click ground level, then ball position on a calibrated video');
}

function exitMeasureMode() {
  measureMode = false;
  measureFirstClick = null;
  measureHoverPt = null;

  drawingData.forEach(data => {
    data.canvas.classList.remove('measure-active');
  });

  redrawAllCanvases();
}

function handleMeasureClick(videoIdx, norm) {
  if (!calibrations.has(videoIdx)) {
    showToast('This video is not calibrated');
    return;
  }

  if (!measureFirstClick) {
    measureFirstClick = { x: norm.x, y: norm.y, videoIdx };
    redrawAllCanvases();
  } else {
    if (measureFirstClick.videoIdx !== videoIdx) {
      showToast('Measure both points on the same video');
      return;
    }

    const height = computeHeight(videoIdx, measureFirstClick, norm);

    if (editingAnnotationIdx !== null && annotations[editingAnnotationIdx]) {
      annotations[editingAnnotationIdx].height = parseFloat(height.toFixed(2));
      annotations[editingAnnotationIdx].heightUnit = 'm';
      updateHeightSection();
      renderAnnotations();
      showToast(`Height: ${height.toFixed(2)} m`);
    }

    exitMeasureMode();
  }
}

// Draw button event
$('btn-draw').addEventListener('click', () => toggleDrawingMode());
$('btn-calibrate').addEventListener('click', () => toggleCalibrateMode());

// Height section event listeners
$('btn-measure').addEventListener('click', () => {
  if (calibrations.size === 0) {
    showToast('No videos calibrated — use Calibrate tool in Draw mode first');
    return;
  }
  if (editingAnnotationIdx === null) {
    showToast('Select a touch to edit first');
    return;
  }
  enterMeasureMode();
});

$('height-input').addEventListener('change', e => {
  if (editingAnnotationIdx === null) return;
  const val = e.target.value.trim();
  if (val === '') {
    annotations[editingAnnotationIdx].height = null;
    annotations[editingAnnotationIdx].heightUnit = null;
  } else {
    annotations[editingAnnotationIdx].height = parseFloat(val);
    if (!annotations[editingAnnotationIdx].heightUnit) {
      annotations[editingAnnotationIdx].heightUnit = 'm';
    }
  }
  renderAnnotations();
});

// ═══════════════════════════════════════════════════════════
// ZOOM & PAN
// ═══════════════════════════════════════════════════════════

function setupZoomEvents() {
  const cells = document.querySelectorAll('#video-grid .video-cell');
  cells.forEach((cell, idx) => {
    // Scroll wheel to zoom toward cursor
    cell.addEventListener('wheel', e => {
      e.preventDefault();
      const state = zoomStates.get(idx);
      if (!state) return;

      const cellRect = cell.getBoundingClientRect();
      const mx = e.clientX - cellRect.left;
      const my = e.clientY - cellRect.top;

      const oldScale = state.scale;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(1, Math.min(8, oldScale * factor));
      if (newScale === oldScale) return;

      // Keep point under cursor fixed
      const cx = (mx - state.panX) / oldScale;
      const cy = (my - state.panY) / oldScale;
      state.panX = mx - cx * newScale;
      state.panY = my - cy * newScale;
      state.scale = newScale;

      clampPan(state, cellRect.width, cellRect.height);
      applyZoom(idx);
    }, { passive: false });

    // Mousedown to start pan (only when zoomed and not drawing)
    cell.addEventListener('mousedown', e => {
      if (drawingMode) return;
      const state = zoomStates.get(idx);
      if (!state || state.scale <= 1) return;

      activePan = {
        videoIdx: idx,
        startX: e.clientX,
        startY: e.clientY,
        startPanX: state.panX,
        startPanY: state.panY,
        cell
      };
      cell.style.cursor = 'grabbing';
      e.preventDefault();
    });

    // Double-click to reset zoom
    cell.addEventListener('dblclick', e => {
      if (drawingMode) return;
      const state = zoomStates.get(idx);
      if (!state || state.scale === 1) return;
      state.scale = 1;
      state.panX = 0;
      state.panY = 0;
      applyZoom(idx);
      e.preventDefault();
    });
  });
}

// Global pan move/up handlers (always present, no-op when activePan is null)
document.addEventListener('mousemove', e => {
  if (!activePan) return;
  const state = zoomStates.get(activePan.videoIdx);
  if (!state) return;

  state.panX = activePan.startPanX + (e.clientX - activePan.startX);
  state.panY = activePan.startPanY + (e.clientY - activePan.startY);

  const cellRect = activePan.cell.getBoundingClientRect();
  clampPan(state, cellRect.width, cellRect.height);
  applyZoom(activePan.videoIdx);
});

document.addEventListener('mouseup', () => {
  if (!activePan) return;
  const state = zoomStates.get(activePan.videoIdx);
  activePan.cell.style.cursor = (state && state.scale > 1) ? 'grab' : '';
  activePan = null;
});

function clampPan(state, cellW, cellH) {
  state.panX = Math.max(cellW * (1 - state.scale), Math.min(0, state.panX));
  state.panY = Math.max(cellH * (1 - state.scale), Math.min(0, state.panY));
}

function applyZoom(videoIdx) {
  const state = zoomStates.get(videoIdx);
  if (!state) return;
  state.container.style.transform = state.scale === 1
    ? ''
    : `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;

  // Cursor: grab when zoomed and not drawing
  const cell = state.container.parentElement;
  if (!activePan || activePan.videoIdx !== videoIdx) {
    cell.style.cursor = (!drawingMode && state.scale > 1) ? 'grab' : '';
  }
}

function resetAllZoom() {
  zoomStates.forEach((state, idx) => {
    state.scale = 1;
    state.panX = 0;
    state.panY = 0;
    applyZoom(idx);
  });
}

// ═══════════════════════════════════════════════════════════
// HELP MODAL
// ═══════════════════════════════════════════════════════════

const HELP_CONTENT = {
  sync: {
    title: 'Sync Setup — How it works',
    body: `
      <div class="help-section">
        <h3>Goal</h3>
        <p>Align all your videos to the <strong>same real-world moment</strong> so the frame counter stays in sync across every camera angle.</p>
      </div>
      <div class="help-section">
        <h3>Steps</h3>
        <ol class="help-steps">
          <li data-n="1">Pick a clear, unambiguous event visible in all videos, such as a ball bounce.</li>
          <li data-n="2">Scrub each video panel independently to that exact moment using the scrubber or frame-step buttons.</li>
          <li data-n="3">Click <strong>Set Sync Point</strong> in each panel. The dot in the footer turns green when set.</li>
          <li data-n="4">Once all dots are green, click <strong>Annotate →</strong> to begin logging touches.</li>
        </ol>
      </div>
      <div class="help-section">
        <h3>Controls (click a panel first to focus it)</h3>
        <table class="help-keys">
          <tr><td><span class="kbd">←</span> <span class="kbd">→</span></td><td>Step one frame back / forward</td></tr>
          <tr><td><span class="kbd">Space</span></td><td>Play / Pause</td></tr>
          <tr><td>Scrubber</td><td>Drag to any position in the video</td></tr>
          <tr><td>FPS box</td><td>Override the auto-detected frame rate</td></tr>
        </table>
      </div>
      <div class="help-tip">
        <strong>Tip:</strong> The sharper the sync event the better. A discrete ball contact or a visible clap gives you sub-frame accuracy.
      </div>
    `,
  },
  annotate: {
    title: 'Annotate — How it works',
    body: `
      <div class="help-section">
        <h3>Goal</h3>
        <p>Scrub or play through the synced videos and log every ball touch with its type and body part. The frame counter at the bottom-left shows the synced frame across all cameras.</p>
      </div>
      <div class="help-section">
        <h3>Logging a touch</h3>
        <ol class="help-steps">
          <li data-n="1">Pause on the frame of contact (use <strong>← →</strong> for fine control).</li>
          <li data-n="2">Select a touch type (Bounce / Kick / Touch) and body part (Foot / Knee / Chest / Arm / Head) — or skip and assign later.</li>
          <li data-n="3">Press <strong>T</strong> or click <strong>Log Touch</strong>. The touch appears in the list on the right.</li>
        </ol>
      </div>
      <div class="help-section">
        <h3>Editing a logged touch</h3>
        <p>Click any row in the touch list to <strong>seek to that frame</strong> and select it for editing. Then click a touch type / body part button to assign or change it. The row is highlighted in blue while selected.</p>
      </div>
      <div class="help-section">
        <h3>Keyboard shortcuts</h3>
        <table class="help-keys">
          <tr><td><span class="kbd">Space</span></td><td>Play / Pause</td></tr>
          <tr><td><span class="kbd">←</span> <span class="kbd">→</span></td><td>Step one frame back / forward</td></tr>
          <tr><td><span class="kbd">↑</span> <span class="kbd">↓</span></td><td>Jump 1 second back / forward</td></tr>
          <tr><td><span class="kbd">T</span></td><td>Log touch at current frame</td></tr>
          <tr><td><span class="kbd">1</span>–<span class="kbd">3</span></td><td>Touch type: Bounce · Kick · Touch</td></tr>
          <tr><td><span class="kbd">4</span>–<span class="kbd">8</span></td><td>Body part: Foot · Knee · Chest · Arm · Head</td></tr>
          <tr><td><span class="kbd">H</span> or <span class="kbd">?</span></td><td>Open this help panel</td></tr>
        </table>
      </div>
      <div class="help-section">
        <h3>Drawing overlay</h3>
        <table class="help-keys">
          <tr><td><span class="kbd">D</span></td><td>Toggle drawing mode on/off</td></tr>
          <tr><td><span class="kbd">F</span></td><td>Switch to freehand tool</td></tr>
          <tr><td><span class="kbd">L</span></td><td>Switch to straight line tool</td></tr>
          <tr><td><span class="kbd">E</span></td><td>Switch to eraser tool (click elements to erase)</td></tr>
          <tr><td><span class="kbd">C</span></td><td>Toggle calibration mode (separate from draw)</td></tr>
          <tr><td><span class="kbd">Del</span> / <span class="kbd">⌫</span></td><td>Delete selected drawing</td></tr>
          <tr><td><span class="kbd">Esc</span></td><td>Cancel line / deselect / exit drawing / cancel measurement</td></tr>
        </table>
        <p style="margin-top:6px;">Click near a drawn element to select it (highlighted with glow). Drawings persist across frame changes.</p>
      </div>
      <div class="help-section">
        <h3>Height calibration &amp; measurement</h3>
        <ol class="help-steps">
          <li data-n="1">Press <strong>C</strong> or click <strong>⊿ Calibrate</strong> to enter calibration mode.</li>
          <li data-n="2">Click two points on a video to draw a reference line of known height (e.g. a goalpost = 2.44 m).</li>
          <li data-n="3">Enter the real-world height and unit in the popover, then click <strong>Set</strong>.</li>
          <li data-n="4">Log a touch, click it in the list to edit, then click <strong>Measure ▲</strong> in the Height section.</li>
          <li data-n="5">Click the ground level, then the ball position on the calibrated video. The height is computed automatically.</li>
        </ol>
        <p style="margin-top:6px;">You can also type a height value manually. One calibration per video (new calibration replaces old). Use <strong>Hide Lines</strong> / <strong>Clear All</strong> in the calibrate toolbar to manage calibration visuals.</p>
      </div>
      <div class="help-section">
        <h3>Zoom &amp; Pan</h3>
        <table class="help-keys">
          <tr><td>Scroll wheel</td><td>Zoom in/out on video (zooms toward cursor)</td></tr>
          <tr><td>Drag</td><td>Pan when zoomed in (exit draw mode first)</td></tr>
          <tr><td>Double-click</td><td>Reset zoom on that video</td></tr>
          <tr><td><span class="kbd">0</span></td><td>Reset zoom on all videos</td></tr>
        </table>
      </div>
      <div class="help-section">
        <h3>Exporting</h3>
        <p>Click <strong>Export CSV</strong> when done. Columns: <code>frame</code>, <code>time_s</code>, <code>touch_type</code>, <code>body_part</code>, <code>height</code>, <code>height_unit</code>, plus one column per video showing that touch's local frame number.</p>
      </div>
      <div class="help-tip">
        <strong>Tip:</strong> Use slow playback (0.25×) to spot contacts. Log first, assign surfaces after — it's faster than stopping for each one.
      </div>
    `,
  },
};

function openHelp(page) {
  const content = HELP_CONTENT[page];
  $('help-title').textContent = content.title;
  $('help-body').innerHTML    = content.body;
  $('help-overlay').classList.add('show');
}

function closeHelp() {
  $('help-overlay').classList.remove('show');
}

$('help-close').addEventListener('click', closeHelp);
$('help-overlay').addEventListener('click', e => {
  if (e.target === $('help-overlay')) closeHelp();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('help-overlay').classList.contains('show')) closeHelp();
});

$('sync-help-btn').addEventListener('click', () => openHelp('sync'));
$('annotate-help-btn').addEventListener('click', () => openHelp('annotate'));
