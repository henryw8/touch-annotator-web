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

let annotations          = [];   // { frame, time, surface }
let selectedSurface      = null;
let editingAnnotationIdx = null; // index in annotations[] being edited post-hoc

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

function detectFPS(video) {
  return new Promise(resolve => {
    // Feature-detect requestVideoFrameCallback
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      resolve(25);
      return;
    }

    const SAMPLE_FRAMES = 60;
    let count      = 0;
    let startMedia = null;
    const savedTime = video.currentTime;

    // Start a bit into the video (avoid black frames / buffering edge)
    const startAt = Math.min(2, (video.duration || 10) * 0.05);
    video.currentTime = startAt;
    video.playbackRate = 1;

    const onFrame = (now, meta) => {
      if (startMedia === null) {
        startMedia = meta.mediaTime;
        count = 0;
      } else {
        count++;
        if (count >= SAMPLE_FRAMES) {
          const elapsed = meta.mediaTime - startMedia;
          const fps = elapsed > 0 ? Math.round(count / elapsed) : 25;
          video.pause();
          video.currentTime = savedTime;
          // Clamp to sane fps values
          resolve(Math.max(10, Math.min(120, fps)));
          return;
        }
      }
      video.requestVideoFrameCallback(onFrame);
    };

    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => resolve(25));

    // Safety timeout — if detection stalls, fall back to 25
    setTimeout(() => {
      if (!video.paused) {
        video.pause();
        video.currentTime = savedTime;
      }
      resolve(25);
    }, 10000);
  });
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
               min="0" max="${item.el.duration || 9999}" step="0.001" value="0">
        <span class="sync-time">0.000 s</span>
      </div>
      <div class="sync-controls" style="flex-wrap:wrap;gap:8px;">
        <button class="sync-set-btn" data-i="${i}">Set Sync Point</button>
        <span class="sync-fps-row">
          <span class="fps-badge">${item.fps} fps</span>
          <input type="number" class="btn btn-sm fps-override"
                 min="1" max="120" value="${item.fps}"
                 title="Override detected FPS" style="width:56px;text-align:center;">
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
      if (val >= 1 && val <= 120) {
        item.fps = val;
        fpsBadge.textContent = val + ' fps';
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
const btnPlay  = $('btn-play');
const btnPrev  = $('btn-prev');
const btnNext  = $('btn-next');
const btnStart = $('btn-start');
const btnEnd   = $('btn-end');

function buildAnnotateScreen() {
  videoGrid.innerHTML = '';
  const count = videoItems.length;
  videoGrid.className = `video-grid count-${count}`;

  videoItems.forEach(item => {
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

    cell.appendChild(item.el);
    cell.appendChild(label);
    cell.appendChild(fpsBadge);
    videoGrid.appendChild(cell);
  });

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
  timeDisplay.textContent  = masterTime.toFixed(3) + ' s';
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
    const rate = parseFloat(this.value);
    videoItems.forEach(item => { item.el.playbackRate = rate; });
  }
});

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
    annotations.push({ frame, time, surface: 'other', comment });
    annotations.sort((a, b) => a.frame - b.frame);
    editingAnnotationIdx = annotations.findIndex(a => a.frame === frame);
    renderAnnotations();
    showToast(`Logged: frame ${frame}  ·  other — ${comment}`);
    return;
  }

  const surface = selectedSurface || null;
  annotations.push({ frame, time, surface, comment: '' });
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

    const row = document.createElement('div');
    row.className = 'annotation-row'
      + (ann.frame === currentFrame ? ' current' : '')
      + (isEditing ? ' editing' : '');
    row.dataset.frame = ann.frame;
    row.innerHTML = `
      <span class="ann-frame">${ann.frame}</span>
      <span class="ann-time">${ann.time.toFixed(3)}s</span>
      <span class="ann-surface">${surfaceLabel}</span>
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
  const colComment = headers.indexOf('comment');

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

    annotations.push({ frame, time, surface, comment });
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

  const headers = ['frame', 'time_s', 'surface', 'comment', ...videoHeaders];

  const dataRows = annotations.map(a => {
    const comment = (a.comment && a.comment.includes(','))
      ? `"${a.comment}"`
      : (a.comment || '');

    const perVideoFrames = videoItems.map(item => {
      const localTime = a.time + item.syncOffset;
      return Math.round(localTime * item.fps);
    });

    return [a.frame, a.time.toFixed(6), a.surface ?? '', comment, ...perVideoFrames];
  });

  // Prepend sync metadata so the CSV can be reloaded to restore the session
  const metaObj = {
    videos: videoItems.map(item => ({
      name: item.name,
      syncOffset: item.syncOffset,
      fps: item.fps,
    })),
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
    case '?':
    case 'h':
    case 'H':
      openHelp('annotate');
      break;
  }
});

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
        <h3>Exporting</h3>
        <p>Click <strong>Export CSV</strong> when done. Columns: <code>frame</code>, <code>time_s</code>, <code>surface</code>, <code>comment</code>, plus one column per video showing that touch's local frame number.</p>
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
