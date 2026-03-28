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

let annotations          = [];   // { frame, time, surface }
let selectedSurface      = null;
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
const calibrations       = new Map(); // videoIdx → { start, end, realHeight, unit }
let calibStartPoint      = null;      // {x,y} normalized for in-progress calibration line
let calibStartVideoIdx   = null;
let pendingCalibration   = null;      // { start, end, videoIdx } awaiting popover confirm

// Height measurement state
let measureMode          = false;
let measureFirstClick    = null;      // {x, y, videoIdx} normalized

// Ball trajectory tracking state
let trackMode            = false;
let trackVideoIdx        = null;       // which video is being tracked
let trackTemplate        = null;       // { data: Float32Array, w, h } grayscale template patch
let trackTemplateSize    = 40;         // half-size of template in pixels (80×80 patch)
let trackSearchRadius    = 60;         // search window radius beyond template
let trackGroundY         = null;       // normalized Y coordinate of ground plane
let trajectory           = [];         // [{ frame, masterTime, normX, normY, heightM }]
let trackBusy            = false;      // true during auto-tracking
let selectingGround      = false;      // true when waiting for ground click
let trackScratchCanvas   = null;       // OffscreenCanvas for pixel extraction

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
    <span style="font-size:12px;color:var(--text-dim);">Height:</span>
    <input type="number" id="cal-height-input" placeholder="2.44" step="0.01" min="0">
    <select id="cal-unit-select">
      <option value="m">m</option>
      <option value="cm">cm</option>
      <option value="ft">ft</option>
      <option value="in">in</option>
    </select>
    <button class="btn btn-sm btn-primary" id="cal-set-btn">Set</button>
    <button class="btn btn-sm" id="cal-cancel-btn">Cancel</button>
  `;
  annotateMain.insertBefore(calPopover, videoGrid);

  document.getElementById('cal-set-btn').addEventListener('click', () => {
    if (!pendingCalibration) return;
    const val = parseFloat(document.getElementById('cal-height-input').value);
    const unit = document.getElementById('cal-unit-select').value;
    if (isNaN(val) || val <= 0) {
      showToast('Enter a valid height value');
      return;
    }
    calibrations.set(pendingCalibration.videoIdx, {
      start: pendingCalibration.start,
      end: pendingCalibration.end,
      realHeight: val,
      unit,
    });
    pendingCalibration = null;
    calPopover.classList.remove('visible');
    redrawAllCanvases();
    showToast(`Calibration set: ${val} ${unit}`);
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
    <span style="font-size:12px;color:var(--text-dim);">Click two points to set a reference height</span>
    <div class="draw-sep"></div>
    <button class="btn btn-sm" id="cal-toggle-lines">${showCalibrationLines ? 'Hide Lines' : 'Show Lines'}</button>
    <button class="btn btn-sm" id="cal-clear-all">Clear All</button>
    <button class="btn btn-sm" id="cal-close">✕</button>
  `;
  annotateMain.insertBefore(calToolbar, videoGrid);

  document.getElementById('cal-toggle-lines').addEventListener('click', () => {
    showCalibrationLines = !showCalibrationLines;
    document.getElementById('cal-toggle-lines').textContent = showCalibrationLines ? 'Hide Lines' : 'Show Lines';
    redrawAllCanvases();
  });
  document.getElementById('cal-clear-all').addEventListener('click', () => {
    if (calibrations.size === 0) { showToast('No calibrations to clear'); return; }
    calibrations.clear();
    redrawAllCanvases();
    showToast('All calibrations cleared');
  });
  document.getElementById('cal-close').addEventListener('click', () => toggleCalibrateMode(false));

  // Build track toolbar (separate from draw/calibrate)
  let trackToolbar = document.getElementById('track-toolbar');
  if (trackToolbar) trackToolbar.remove();
  trackToolbar = document.createElement('div');
  trackToolbar.id = 'track-toolbar';
  trackToolbar.className = 'draw-toolbar';  // reuse draw-toolbar styling
  trackToolbar.innerHTML = `
    <span id="track-status" style="font-size:12px;color:var(--text-dim);">Click ball to set template</span>
    <div class="draw-sep"></div>
    <label style="font-size:11px;color:var(--text-dim);display:flex;align-items:center;gap:3px;">
      Size <input type="number" id="track-tpl-size" value="${trackTemplateSize}" min="10" max="200" step="5"
             style="width:48px;padding:3px 5px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;">
    </label>
    <label style="font-size:11px;color:var(--text-dim);display:flex;align-items:center;gap:3px;">
      Search <input type="number" id="track-search-radius" value="${trackSearchRadius}" min="20" max="300" step="10"
               style="width:48px;padding:3px 5px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;">
    </label>
    <div class="draw-sep"></div>
    <button class="btn btn-sm" id="track-set-ground" title="Click ground level on video (G)">Set Ground</button>
    <button class="btn btn-sm" id="track-forward" title="Track ball forward (F)">▶ Forward</button>
    <button class="btn btn-sm" id="track-backward" title="Track ball backward (R)">◀ Backward</button>
    <div class="draw-sep"></div>
    <div class="track-progress" id="track-progress" style="display:none;">
      <div class="track-progress-bar" id="track-progress-bar"></div>
    </div>
    <button class="btn btn-sm" id="track-stop" style="display:none;">Stop</button>
    <button class="btn btn-sm" id="track-export">Export Traj.</button>
    <button class="btn btn-sm" id="track-clear">Clear</button>
    <button class="btn btn-sm" id="track-close">✕</button>
  `;
  annotateMain.insertBefore(trackToolbar, videoGrid);

  document.getElementById('track-tpl-size').addEventListener('change', e => {
    const val = parseInt(e.target.value);
    if (val > 0) trackTemplateSize = val;
  });
  document.getElementById('track-search-radius').addEventListener('change', e => {
    const val = parseInt(e.target.value);
    if (val > 0) trackSearchRadius = val;
  });
  document.getElementById('track-set-ground').addEventListener('click', () => {
    selectingGround = true;
    showToast('Click the ground level on the video');
  });
  document.getElementById('track-forward').addEventListener('click', () => trackInDirection('forward'));
  document.getElementById('track-backward').addEventListener('click', () => trackInDirection('backward'));
  document.getElementById('track-stop').addEventListener('click', () => { trackBusy = false; });
  document.getElementById('track-export').addEventListener('click', exportTrajectory);
  document.getElementById('track-clear').addEventListener('click', () => {
    if (trajectory.length === 0) { showToast('No trajectory to clear'); return; }
    trajectory = [];
    trackTemplate = null;
    trackGroundY = null;
    trackVideoIdx = null;
    updateTrackStatus();
    redrawAllCanvases();
    showToast('Trajectory cleared');
  });
  document.getElementById('track-close').addEventListener('click', () => toggleTrackMode(false));

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
  if (trajectory.length > 0 && !isPlaying) redrawAllCanvases();
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

$('surface-grid').querySelectorAll('.surface-btn').forEach(btn => {
  btn.addEventListener('click', () => selectSurface(btn.dataset.surface));
});

function selectSurface(name) {
  $('surface-grid').querySelectorAll('.surface-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.surface === name);
  });
  selectedSurface = name;

  // Show/hide comment input for "other"
  const wrap    = $('other-comment-wrap');
  const input   = $('other-comment');
  const isOther = name === 'other';
  wrap.style.display = isOther ? '' : 'none';
  input.classList.remove('required');
  if (isOther) {
    // Pre-fill comment if editing a touch that already has one
    if (editingAnnotationIdx !== null && annotations[editingAnnotationIdx]) {
      input.value = annotations[editingAnnotationIdx].comment || '';
    } else {
      input.value = '';
    }
    input.focus();
  }

  // If a logged touch is selected for editing, update its surface immediately
  if (editingAnnotationIdx !== null && annotations[editingAnnotationIdx]) {
    // For "other" we wait for the user to fill the comment before committing
    if (!isOther) {
      annotations[editingAnnotationIdx].surface = name;
      annotations[editingAnnotationIdx].comment = '';
      renderAnnotations();
      showToast(`Updated: frame ${annotations[editingAnnotationIdx].frame}  ·  ${name}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// LOGGING TOUCHES
// ═══════════════════════════════════════════════════════════

$('log-btn').addEventListener('click', logTouch);

// Commit "other + comment" edit when Enter is pressed in the comment box
$('other-comment').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    // If editing an existing touch, commit immediately
    if (editingAnnotationIdx !== null && annotations[editingAnnotationIdx]) {
      const comment = $('other-comment').value.trim();
      if (!comment) { flashCommentRequired(); return; }
      annotations[editingAnnotationIdx].surface = 'other';
      annotations[editingAnnotationIdx].comment = comment;
      renderAnnotations();
      showToast(`Updated: frame ${annotations[editingAnnotationIdx].frame}  ·  other — ${comment}`);
    } else {
      // Otherwise treat Enter as "log touch"
      logTouch();
    }
  }
});

function flashCommentRequired() {
  const input = $('other-comment');
  input.classList.add('required');
  input.focus();
  setTimeout(() => input.classList.remove('required'), 1200);
}

function logTouch() {
  const frame = Math.round(masterTime * masterFPS);
  const time  = parseFloat(masterTime.toFixed(6));

  // Warn if duplicate frame
  if (annotations.some(a => a.frame === frame)) {
    showToast(`Frame ${frame} already logged — delete it first`);
    return;
  }

  // "other" requires a comment
  if (selectedSurface === 'other') {
    const comment = $('other-comment').value.trim();
    if (!comment) { flashCommentRequired(); return; }
    annotations.push({ frame, time, surface: 'other', comment, height: null, heightUnit: null });
    annotations.sort((a, b) => a.frame - b.frame);
    editingAnnotationIdx = annotations.findIndex(a => a.frame === frame);
    renderAnnotations();
    showToast(`Logged: frame ${frame}  ·  other — ${comment}`);
    return;
  }

  const surface = selectedSurface || null;
  annotations.push({ frame, time, surface, comment: '', height: null, heightUnit: null });
  annotations.sort((a, b) => a.frame - b.frame);

  // Auto-select the new touch for immediate surface editing
  editingAnnotationIdx = annotations.findIndex(a => a.frame === frame);

  renderAnnotations();
  showToast(surface
    ? `Logged: frame ${frame}  ·  ${surface}`
    : `Logged: frame ${frame}  ·  select a surface to assign it`
  );
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
  const sectionTitle = $('surface-section-title');
  if (sectionTitle) {
    sectionTitle.textContent = editingAnnotationIdx !== null
      ? `Editing touch @ frame ${annotations[editingAnnotationIdx]?.frame ?? '?'}`
      : 'Touch Surface';
  }

  annotations.forEach((ann, i) => {
    const isEditing = i === editingAnnotationIdx;

    let surfaceLabel;
    if (!ann.surface) {
      surfaceLabel = '<span class="ann-unassigned">— assign surface →</span>';
    } else if (ann.surface === 'other' && ann.comment) {
      surfaceLabel = `other <span class="ann-comment">${ann.comment}</span>`;
    } else {
      surfaceLabel = ann.surface;
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

    // Click row → seek to that touch AND select it for surface editing
    row.addEventListener('click', e => {
      if (e.target.classList.contains('ann-del')) return;
      pausePlayback();
      seekToMaster(ann.time);
      editingAnnotationIdx = i;
      // Reflect surface in buttons
      $('surface-grid').querySelectorAll('.surface-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.surface === ann.surface);
      });
      // Show/pre-fill comment box for "other"
      const wrap  = $('other-comment-wrap');
      const input = $('other-comment');
      if (ann.surface === 'other') {
        wrap.style.display = '';
        input.value = ann.comment || '';
        input.focus();
      } else {
        wrap.style.display = 'none';
        input.value = '';
      }
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

  const colFrame   = headers.indexOf('frame');
  const colTime    = headers.indexOf('time_s');
  const colSurface = headers.indexOf('surface');
  const colComment    = headers.indexOf('comment');
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

    const surface = (colSurface >= 0 ? cols[colSurface] : '') || null;
    const comment = (colComment >= 0 ? cols[colComment] : '') || '';
    const rawHeight = colHeight >= 0 ? cols[colHeight] : '';
    const height = rawHeight ? parseFloat(rawHeight) : null;
    const heightUnit = (colHeightUnit >= 0 && cols[colHeightUnit]) ? cols[colHeightUnit] : null;

    annotations.push({ frame, time, surface, comment, height: isNaN(height) ? null : height, heightUnit });
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

  const headers = ['frame', 'time_s', 'real_time_s', 'surface', 'comment', 'height', 'height_unit', ...videoHeaders];

  const dataRows = annotations.map(a => {
    const comment = (a.comment && a.comment.includes(','))
      ? `"${a.comment}"`
      : (a.comment || '');

    const perVideoFrames = videoItems.map(item => {
      const localTime = a.time + item.syncOffset;
      return Math.round(localTime * item.fps);
    });

    return [
      a.frame,
      a.time.toFixed(6),
      toRealTime(a.time).toFixed(6),
      a.surface ?? '',
      comment,
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

    // Surface shortcuts: 1–5
    case '1': selectSurface('foot');  break;
    case '2': selectSurface('head');  break;
    case '3': selectSurface('arm');   break;
    case '4': selectSurface('torso'); break;
    case '5': selectSurface('other'); break;
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
    case 'b':
    case 'B':
      toggleTrackMode();
      break;
    case 'f':
    case 'F':
      if (trackMode && trackTemplate && !trackBusy) { trackInDirection('forward'); break; }
      if (drawingMode) setDrawTool('free');
      break;
    case 'r':
    case 'R':
      if (trackMode && trackTemplate && !trackBusy) trackInDirection('backward');
      break;
    case 'g':
    case 'G':
      if (trackMode) {
        selectingGround = true;
        showToast('Click the ground level on the video');
      }
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
    case 'Escape':
      if (trackMode && trackBusy) {
        e.preventDefault();
        trackBusy = false;
      } else if (trackMode) {
        e.preventDefault();
        if (selectingGround) {
          selectingGround = false;
        } else {
          toggleTrackMode(false);
        }
      } else if (measureMode) {
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
        if (calibStartPoint) {
          calibStartPoint = null;
          calibStartVideoIdx = null;
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
    // Exit other modes if active (mutually exclusive)
    if (calibrateMode) toggleCalibrateMode(false);
    if (trackMode) toggleTrackMode(false);
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
    cell.style.cursor = (!drawingMode && !calibrateMode && !trackMode && state.scale > 1) ? 'grab' : '';
  });

  redrawAllCanvases();
}

function toggleCalibrateMode(forceState) {
  calibrateMode = forceState !== undefined ? forceState : !calibrateMode;

  const btn = document.getElementById('btn-calibrate');
  if (calibrateMode) {
    btn.classList.add('btn-primary');
    // Exit other modes if active (mutually exclusive)
    if (drawingMode) toggleDrawingMode(false);
    if (trackMode) toggleTrackMode(false);
  } else {
    btn.classList.remove('btn-primary');
    calibStartPoint = null;
    calibStartVideoIdx = null;
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
    cell.style.cursor = (!drawingMode && !calibrateMode && !trackMode && state.scale > 1) ? 'grab' : '';
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
    if (!drawingMode && !measureMode && !calibrateMode && !trackMode) return;
    const rect = canvas.getBoundingClientRect();
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const norm = { x: px.x / rect.width, y: px.y / rect.height };

    dragStartPx = px;
    isDragging = false;
    currentStroke = null;

    if (drawingMode && drawToolMode === 'free') {
      currentStroke = [norm];
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!drawingMode && !measureMode && !calibrateMode && !trackMode) return;
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

    // Measurement mode rubber-band
    if (measureMode && measureFirstClick && measureFirstClick.videoIdx === videoIdx) {
      redrawCanvas(videoIdx);
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
    }

    // Calibrate mode rubber-band
    if (calibrateMode && calibStartPoint && calibStartVideoIdx === videoIdx) {
      redrawCanvas(videoIdx);
      drawLinePreview(drawingData.get(videoIdx).ctx, canvas, calibStartPoint, norm);
      return;
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
    if (!drawingMode && !measureMode && !calibrateMode && !trackMode) return;
    const rect = canvas.getBoundingClientRect();
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const norm = { x: px.x / rect.width, y: px.y / rect.height };

    // Handle tracking clicks
    if (trackMode && !isDragging) {
      handleTrackClick(videoIdx, norm);
      currentStroke = null;
      dragStartPx = null;
      isDragging = false;
      return;
    }

    // Handle measurement clicks first
    if (measureMode && !isDragging) {
      handleMeasureClick(videoIdx, norm);
      currentStroke = null;
      dragStartPx = null;
      isDragging = false;
      return;
    }

    // Handle calibration clicks (separate mode from drawing)
    if (calibrateMode && !isDragging) {
      if (!calibStartPoint || calibStartVideoIdx !== videoIdx) {
        calibStartPoint = norm;
        calibStartVideoIdx = videoIdx;
      } else {
        pendingCalibration = { start: calibStartPoint, end: norm, videoIdx };
        calibStartPoint = null;
        calibStartVideoIdx = null;
        showCalibrationPopover();
      }
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
  const hasTrajectory = trajectory.length > 0 && trackVideoIdx === videoIdx;
  const hasContent = elements.length > 0
    || (lineStartPoint && lineStartVideoIdx === videoIdx)
    || (calibStartPoint && calibStartVideoIdx === videoIdx)
    || (cal && showCalibrationLines) || hasMeasureState || hasTrajectory;
  const needsCanvas = drawingMode || measureMode || calibrateMode || trackMode || hasContent;
  canvas.style.display = needsCanvas ? '' : 'none';
  if (!needsCanvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw calibration line first (underneath drawings)
  if (cal && showCalibrationLines) {
    const opacity = (drawingMode || calibrateMode) ? 1.0 : 0.4;
    drawCalibrationLine(ctx, canvas, cal, opacity);
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

  // Draw start-point dot for in-progress calibration line
  if (calibStartPoint && calibStartVideoIdx === videoIdx) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(calibStartPoint.x * canvas.width, calibStartPoint.y * canvas.height, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw measurement ground-point dot
  if (hasMeasureState) {
    ctx.fillStyle = '#4aff8a';
    ctx.beginPath();
    ctx.arc(measureFirstClick.x * canvas.width, measureFirstClick.y * canvas.height, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw trajectory overlay
  if (hasTrajectory) {
    drawTrajectory(ctx, canvas, trajectory);
  }
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

function drawCalibrationLine(ctx, canvas, cal, opacity) {
  const W = canvas.width, H = canvas.height;
  const x1 = cal.start.x * W, y1 = cal.start.y * H;
  const x2 = cal.end.x * W, y2 = cal.end.y * H;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Label at midpoint
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
  const label = `${cal.realHeight} ${cal.unit}`;
  ctx.setLineDash([]);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const metrics = ctx.measureText(label);
  const pad = 4;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(midX - metrics.width / 2 - pad, midY - 16 - pad, metrics.width + pad * 2, 16 + pad);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, midX, midY - pad);
  ctx.restore();
}

function showCalibrationPopover() {
  const popover = document.getElementById('calibration-popover');
  if (!popover) return;
  // Pre-fill with existing calibration value if replacing
  const existing = pendingCalibration ? calibrations.get(pendingCalibration.videoIdx) : null;
  document.getElementById('cal-height-input').value = existing ? existing.realHeight : '';
  document.getElementById('cal-unit-select').value = existing ? existing.unit : 'm';
  popover.classList.add('visible');
  document.getElementById('cal-height-input').focus();
}

function computeHeight(videoIdx, pt1, pt2) {
  const cal = calibrations.get(videoIdx);
  if (!cal) return null;
  const canvas = drawingData.get(videoIdx).canvas;
  const W = canvas.width, H = canvas.height;

  const calPxLen = Math.sqrt(
    ((cal.end.x - cal.start.x) * W) ** 2 +
    ((cal.end.y - cal.start.y) * H) ** 2
  );
  const measPxLen = Math.sqrt(
    ((pt2.x - pt1.x) * W) ** 2 +
    ((pt2.y - pt1.y) * H) ** 2
  );

  return (measPxLen / calPxLen) * cal.realHeight;
}

function enterMeasureMode() {
  measureMode = true;
  measureFirstClick = null;

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
    const cal = calibrations.get(videoIdx);

    if (editingAnnotationIdx !== null && annotations[editingAnnotationIdx]) {
      annotations[editingAnnotationIdx].height = parseFloat(height.toFixed(2));
      annotations[editingAnnotationIdx].heightUnit = cal.unit;
      updateHeightSection();
      renderAnnotations();
      showToast(`Height: ${height.toFixed(2)} ${cal.unit}`);
    }

    exitMeasureMode();
  }
}

// ═══════════════════════════════════════════════════════════
// BALL TRAJECTORY TRACKING
// ═══════════════════════════════════════════════════════════

function toggleTrackMode(forceState) {
  trackMode = forceState !== undefined ? forceState : !trackMode;

  const btn = document.getElementById('btn-track');
  if (trackMode) {
    btn.classList.add('btn-primary');
    if (drawingMode) toggleDrawingMode(false);
    if (calibrateMode) toggleCalibrateMode(false);
  } else {
    btn.classList.remove('btn-primary');
    selectingGround = false;
  }

  const toolbar = document.getElementById('track-toolbar');
  if (toolbar) toolbar.classList.toggle('visible', trackMode);

  drawingData.forEach(data => {
    if (trackMode) {
      data.canvas.classList.add('track-active');
    } else {
      data.canvas.classList.remove('track-active');
      if (!drawingMode && !calibrateMode) data.canvas.classList.remove('active');
    }
  });

  zoomStates.forEach(state => {
    const cell = state.container.parentElement;
    cell.style.cursor = (!drawingMode && !calibrateMode && !trackMode && state.scale > 1) ? 'grab' : '';
  });

  redrawAllCanvases();
}

function updateTrackStatus() {
  const el = document.getElementById('track-status');
  if (!el) return;
  if (trackBusy) return; // status updated by tracking loop
  if (trajectory.length === 0) {
    el.textContent = trackTemplate ? 'Template set — click Forward/Backward' : 'Click ball to set template';
  } else {
    el.textContent = `${trajectory.length} points tracked`;
  }
}

function ensureScratchCanvas(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!trackScratchCanvas || trackScratchCanvas.width !== vw || trackScratchCanvas.height !== vh) {
    trackScratchCanvas = new OffscreenCanvas(vw, vh);
  }
  return trackScratchCanvas;
}

function extractGrayscalePatch(scratchCtx, cx, cy, halfSize, vw, vh) {
  const x0 = Math.max(0, Math.round(cx - halfSize));
  const y0 = Math.max(0, Math.round(cy - halfSize));
  const x1 = Math.min(vw, Math.round(cx + halfSize));
  const y1 = Math.min(vh, Math.round(cy + halfSize));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const imageData = scratchCtx.getImageData(x0, y0, w, h);
  const pixels = imageData.data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = pixels[i * 4]; // BW video: R channel is sufficient
  }
  return { data: gray, w, h, ox: x0, oy: y0 };
}

function computeNCC(template, tW, tH, search, sW, sH) {
  // Pre-compute template stats
  let tMean = 0;
  for (let i = 0; i < template.length; i++) tMean += template[i];
  tMean /= template.length;

  let tVar = 0;
  for (let i = 0; i < template.length; i++) {
    const d = template[i] - tMean;
    tVar += d * d;
  }
  if (tVar < 1e-6) return { bestX: 0, bestY: 0, bestScore: 0 };
  const tStd = Math.sqrt(tVar);

  let bestScore = -2;
  let bestX = 0, bestY = 0;

  const maxTy = sH - tH;
  const maxTx = sW - tW;

  for (let sy = 0; sy <= maxTy; sy++) {
    for (let sx = 0; sx <= maxTx; sx++) {
      // Compute patch mean
      let pMean = 0;
      for (let ty = 0; ty < tH; ty++) {
        const sRow = (sy + ty) * sW + sx;
        for (let tx = 0; tx < tW; tx++) {
          pMean += search[sRow + tx];
        }
      }
      pMean /= template.length;

      // Compute NCC
      let num = 0, pVar = 0;
      for (let ty = 0; ty < tH; ty++) {
        const sRow = (sy + ty) * sW + sx;
        const tRow = ty * tW;
        for (let tx = 0; tx < tW; tx++) {
          const td = template[tRow + tx] - tMean;
          const pd = search[sRow + tx] - pMean;
          num += td * pd;
          pVar += pd * pd;
        }
      }

      if (pVar < 1e-6) continue;
      const score = num / (tStd * Math.sqrt(pVar));

      if (score > bestScore) {
        bestScore = score;
        bestX = sx;
        bestY = sy;
      }
    }
  }

  return { bestX, bestY, bestScore };
}

function seekAndCapture(videoEl, targetTime) {
  return new Promise(resolve => {
    if (Math.abs(videoEl.currentTime - targetTime) < 0.0001) {
      resolve();
      return;
    }
    videoEl.addEventListener('seeked', () => resolve(), { once: true });
    videoEl.currentTime = targetTime;
  });
}

function handleTrackClick(videoIdx, norm) {
  if (selectingGround) {
    trackGroundY = norm.y;
    selectingGround = false;
    // Recompute heights for existing trajectory
    recomputeTrajectoryHeights();
    redrawAllCanvases();
    showToast(`Ground level set at y=${(norm.y * 100).toFixed(1)}%`);
    return;
  }

  const videoEl = videoItems[videoIdx].el;
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;

  // Capture template from current video frame
  const scratch = ensureScratchCanvas(videoEl);
  const sctx = scratch.getContext('2d');
  sctx.drawImage(videoEl, 0, 0, vw, vh);

  const cx = norm.x * vw;
  const cy = norm.y * vh;
  const patch = extractGrayscalePatch(sctx, cx, cy, trackTemplateSize, vw, vh);
  if (!patch) { showToast('Could not capture template'); return; }

  trackTemplate = { data: patch.data, w: patch.w, h: patch.h };
  trackVideoIdx = videoIdx;

  // Add or update the current frame in trajectory
  const frame = Math.round(masterTime * masterFPS);
  const existing = trajectory.findIndex(p => p.frame === frame);
  const pt = {
    frame,
    masterTime,
    normX: norm.x,
    normY: norm.y,
    heightM: computeTrackHeight(videoIdx, norm),
  };
  if (existing >= 0) {
    trajectory[existing] = pt;
  } else {
    trajectory.push(pt);
    trajectory.sort((a, b) => a.frame - b.frame);
  }

  updateTrackStatus();
  redrawAllCanvases();
  showToast('Template captured — use Forward/Backward to track');
}

function computeTrackHeight(videoIdx, normPos) {
  if (trackGroundY === null) return null;
  const cal = calibrations.get(videoIdx);
  if (!cal) return null;
  const groundPt = { x: normPos.x, y: trackGroundY };
  return computeHeight(videoIdx, groundPt, normPos);
}

function recomputeTrajectoryHeights() {
  if (trackVideoIdx === null) return;
  for (const pt of trajectory) {
    pt.heightM = computeTrackHeight(trackVideoIdx, { x: pt.normX, y: pt.normY });
  }
}

async function trackInDirection(direction) {
  if (trackBusy) return;
  if (!trackTemplate) { showToast('Click the ball first to set a template'); return; }
  if (trackVideoIdx === null) return;

  trackBusy = true;
  const statusEl = document.getElementById('track-status');
  const progressWrap = document.getElementById('track-progress');
  const progressBar = document.getElementById('track-progress-bar');
  const stopBtn = document.getElementById('track-stop');
  if (progressWrap) progressWrap.style.display = '';
  if (stopBtn) stopBtn.style.display = '';

  const step = direction === 'forward' ? 1 / masterFPS : -1 / masterFPS;
  const limit = direction === 'forward' ? masterMax : masterMin;
  const videoEl = videoItems[trackVideoIdx].el;
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const syncOff = videoItems[trackVideoIdx].syncOffset;

  const scratch = ensureScratchCanvas(videoEl);
  const sctx = scratch.getContext('2d');

  // Find last known position in the tracking direction
  const currentFrame = Math.round(masterTime * masterFPS);
  let lastPt = trajectory.find(p => p.frame === currentFrame);
  if (!lastPt && trajectory.length > 0) {
    // Find closest point
    lastPt = trajectory.reduce((best, p) =>
      Math.abs(p.frame - currentFrame) < Math.abs(best.frame - currentFrame) ? p : best
    );
  }
  if (!lastPt) { trackBusy = false; showToast('No starting point'); return; }

  let lastPx = { x: lastPt.normX * vw, y: lastPt.normY * vh };
  let t = lastPt.masterTime + step;
  let frameCount = 0;
  const totalFrames = Math.abs((limit - lastPt.masterTime) * masterFPS);

  while (trackBusy && (direction === 'forward' ? t <= limit : t >= limit)) {
    const videoTime = t + syncOff;
    if (videoTime < 0 || videoTime > videoEl.duration) break;

    await seekAndCapture(videoEl, videoTime);
    sctx.drawImage(videoEl, 0, 0, vw, vh);

    // Extract search region around last known position
    const searchHalf = trackTemplateSize + trackSearchRadius;
    const searchPatch = extractGrayscalePatch(sctx, lastPx.x, lastPx.y, searchHalf, vw, vh);
    if (!searchPatch) break;

    // Run NCC
    const match = computeNCC(
      trackTemplate.data, trackTemplate.w, trackTemplate.h,
      searchPatch.data, searchPatch.w, searchPatch.h
    );

    if (match.bestScore < 0.5) {
      showToast(`Tracking lost at frame ${Math.round(t * masterFPS)} (score: ${match.bestScore.toFixed(2)})`);
      break;
    }

    // Convert match position back to video pixel coords
    // match.bestX/Y is top-left of best match within search patch
    // Center of match = bestX + templateW/2, bestY + templateH/2, relative to search patch origin
    const matchCx = searchPatch.ox + match.bestX + trackTemplate.w / 2;
    const matchCy = searchPatch.oy + match.bestY + trackTemplate.h / 2;
    const normX = matchCx / vw;
    const normY = matchCy / vh;

    const frame = Math.round(t * masterFPS);
    const existingIdx = trajectory.findIndex(p => p.frame === frame);
    const pt = {
      frame,
      masterTime: t,
      normX,
      normY,
      heightM: computeTrackHeight(trackVideoIdx, { x: normX, y: normY }),
    };
    if (existingIdx >= 0) {
      trajectory[existingIdx] = pt;
    } else {
      trajectory.push(pt);
    }

    lastPx = { x: matchCx, y: matchCy };
    t += step;
    frameCount++;

    // Update UI periodically
    if (frameCount % 30 === 0) {
      trajectory.sort((a, b) => a.frame - b.frame);
      if (statusEl) statusEl.textContent = `Tracking: ${frameCount} frames (score: ${match.bestScore.toFixed(2)})`;
      if (progressBar) progressBar.style.width = `${Math.min(100, (frameCount / totalFrames) * 100)}%`;
      seekToMaster(t);
      redrawAllCanvases();
      await new Promise(r => setTimeout(r, 0));
    }
  }

  trajectory.sort((a, b) => a.frame - b.frame);
  trackBusy = false;
  if (progressWrap) progressWrap.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'none';
  if (progressBar) progressBar.style.width = '0%';
  updateTrackStatus();
  seekToMaster(t - step); // stay at last tracked frame
  redrawAllCanvases();
  showToast(`Tracked ${frameCount} frames ${direction}`);
}

function drawTrajectory(ctx, canvas, traj) {
  const W = canvas.width, H = canvas.height;
  if (traj.length === 0) return;

  ctx.save();

  // Draw ground reference line
  if (trackGroundY !== null) {
    ctx.strokeStyle = 'rgba(74, 255, 138, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, trackGroundY * H);
    ctx.lineTo(W, trackGroundY * H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw connecting line
  ctx.strokeStyle = 'rgba(255, 204, 68, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < traj.length; i++) {
    const px = traj[i].normX * W;
    const py = traj[i].normY * H;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Draw dots
  for (const pt of traj) {
    ctx.fillStyle = '#ffcc44';
    ctx.beginPath();
    ctx.arc(pt.normX * W, pt.normY * H, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight current frame's point
  const currentFrame = Math.round(masterTime * masterFPS);
  const currentPt = traj.find(p => p.frame === currentFrame);
  if (currentPt) {
    ctx.strokeStyle = '#ff4a6a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(currentPt.normX * W, currentPt.normY * H, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function exportTrajectory() {
  if (trajectory.length === 0) { showToast('No trajectory to export'); return; }
  if (trackVideoIdx === null) return;

  const videoEl = videoItems[trackVideoIdx].el;
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const cal = calibrations.get(trackVideoIdx);
  const item = videoItems[trackVideoIdx];

  const metaObj = {
    videos: [{ name: item.name, syncOffset: item.syncOffset, fps: item.fps }],
    realTimeFactor,
    calibration: cal ? { realHeight: cal.realHeight, unit: cal.unit } : null,
    groundY: trackGroundY,
    templateSize: trackTemplateSize,
  };

  const headers = ['frame', 'time_s', 'real_time_s', 'norm_x', 'norm_y', 'pixel_x', 'pixel_y', 'height', 'height_unit'];
  const dataRows = trajectory.map(pt => [
    pt.frame,
    pt.masterTime.toFixed(6),
    toRealTime(pt.masterTime).toFixed(6),
    pt.normX.toFixed(6),
    pt.normY.toFixed(6),
    Math.round(pt.normX * vw),
    Math.round(pt.normY * vh),
    pt.heightM != null ? pt.heightM.toFixed(4) : '',
    cal ? cal.unit : '',
  ]);

  const metaLine = '#meta ' + JSON.stringify(metaObj);
  const csv = metaLine + '\r\n' + [headers, ...dataRows].map(r => r.join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `trajectory_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${trajectory.length} trajectory points`);
}

// Draw button event
$('btn-draw').addEventListener('click', () => toggleDrawingMode());
$('btn-calibrate').addEventListener('click', () => toggleCalibrateMode());
$('btn-track').addEventListener('click', () => toggleTrackMode());

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
        <p>Scrub or play through the synced videos and log every ball touch and the contact surface. The frame counter at the bottom-left shows the synced frame across all cameras.</p>
      </div>
      <div class="help-section">
        <h3>Logging a touch</h3>
        <ol class="help-steps">
          <li data-n="1">Pause on the frame of contact (use <strong>← →</strong> for fine control).</li>
          <li data-n="2">Select a surface (Foot / Head / Arm / Torso / Other) — or skip and assign it later.</li>
          <li data-n="3">Press <strong>T</strong> or click <strong>Log Touch</strong>. The touch appears in the list on the right.</li>
          <li data-n="4">If you chose <em>Other</em>, a comment box appears — type a description and press <strong>Enter</strong>.</li>
        </ol>
      </div>
      <div class="help-section">
        <h3>Editing a logged touch</h3>
        <p>Click any row in the touch list to <strong>seek to that frame</strong> and select it for editing. Then click a surface button to assign or change it. The row is highlighted in blue while selected.</p>
      </div>
      <div class="help-section">
        <h3>Keyboard shortcuts</h3>
        <table class="help-keys">
          <tr><td><span class="kbd">Space</span></td><td>Play / Pause</td></tr>
          <tr><td><span class="kbd">←</span> <span class="kbd">→</span></td><td>Step one frame back / forward</td></tr>
          <tr><td><span class="kbd">↑</span> <span class="kbd">↓</span></td><td>Jump 1 second back / forward</td></tr>
          <tr><td><span class="kbd">T</span></td><td>Log touch at current frame</td></tr>
          <tr><td><span class="kbd">1</span>–<span class="kbd">5</span></td><td>Select surface: Foot · Head · Arm · Torso · Other</td></tr>
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
        <h3>Ball trajectory tracking</h3>
        <ol class="help-steps">
          <li data-n="1">Calibrate a reference height first (press <strong>C</strong>).</li>
          <li data-n="2">Press <strong>B</strong> or click <strong>⊙ Track</strong> to enter tracking mode.</li>
          <li data-n="3">Click the ball to capture a template patch.</li>
          <li data-n="4">Press <strong>G</strong> or click <strong>Set Ground</strong>, then click the ground level.</li>
          <li data-n="5">Press <strong>F</strong> to track forward or <strong>R</strong> to track backward. The tracker uses NCC template matching to follow the ball frame-by-frame.</li>
          <li data-n="6">Click <strong>Export Traj.</strong> to save the trajectory as CSV.</li>
        </ol>
        <table class="help-keys" style="margin-top:8px;">
          <tr><td><span class="kbd">B</span></td><td>Toggle tracking mode</td></tr>
          <tr><td><span class="kbd">F</span></td><td>Track forward (in track mode)</td></tr>
          <tr><td><span class="kbd">R</span></td><td>Track backward</td></tr>
          <tr><td><span class="kbd">G</span></td><td>Set ground level</td></tr>
          <tr><td><span class="kbd">Esc</span></td><td>Stop tracking / exit track mode</td></tr>
        </table>
        <p style="margin-top:6px;">Click on the ball at any time to reposition the template and correct tracking errors. Adjust <strong>Size</strong> (template half-size in pixels) and <strong>Search</strong> (search radius) in the toolbar for your video.</p>
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
        <p>Click <strong>Export CSV</strong> when done. Columns: <code>frame</code>, <code>time_s</code>, <code>surface</code>, <code>comment</code>, <code>height</code>, <code>height_unit</code>, plus one column per video showing that touch's local frame number.</p>
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
