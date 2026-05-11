// Golden — main app
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const MODE_LIST = [
  { id: 'minimal',      name: 'Minimal',      sub: 'Quiet. Just the best find.' },
  { id: 'photographer', name: 'Photographer', sub: 'φ-grid + ratio readout.' },
  { id: 'educational',  name: 'Educational',  sub: 'Labels & explanations.' },
  { id: 'playful',      name: 'Hunt',         sub: 'Score & collect spirals.' },
];

const state = {
  screen: 'splash',
  mode: 'minimal',
  stream: null,
  video: null,
  overlay: null,
  octx: null,
  detector: null,
  tracker: new Tracker(),
  tracks: [],
  lastDetect: 0,
  manualAnchors: [],
  hud: { ar: null, conf: 0, dphi: 0 },
  hunt: {
    collection: JSON.parse(localStorage.getItem('golden.collection') || '[]'),
    streak: parseInt(localStorage.getItem('golden.streak') || '0', 10),
    flashUntil: 0,
  },
};

// ──────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────
function boot() {
  renderSplash();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // hide install hint when running as PWA
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone;
  if (isStandalone) $('.install-hint')?.classList.add('hidden');
}

// ──────────────────────────────────────────────────────────────
// Splash
// ──────────────────────────────────────────────────────────────
function renderSplash() {
  const app = $('#app');
  app.innerHTML = `
    <section id="splash" class="screen active">
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 220 140">
          <path d="" id="splashSpiral" fill="none" stroke="#d9b04a" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <h1>Golden</h1>
        <p>Find φ everywhere.</p>
      </div>
      <div class="modes">
        ${MODE_LIST.map((m, i) => `
          <button class="mode-btn" data-mode="${m.id}">
            <div class="num">0${i + 1}</div>
            <div class="name">${m.name}</div>
            <div class="sub">${m.sub}</div>
          </button>
        `).join('')}
      </div>
      <div class="source-row">
        <button class="source-btn live-source on" data-source="camera">
          <span class="src-ico">◉</span> Live camera
        </button>
        <label class="source-btn" for="photoPicker">
          <span class="src-ico">▣</span> Pick from Photos
          <input type="file" id="photoPicker" accept="image/*" hidden/>
        </label>
      </div>
      <button class="library-link" id="openLib">→ Overlay parts library</button>
      <div class="install-hint">
        On iPhone: tap <b>Share ↑</b> → <b>Add to Home Screen</b> to install.<br/>
        Live camera needs HTTPS; Photos works anywhere.
      </div>
    </section>
    <section id="live" class="screen"></section>
    <section id="photo" class="screen"></section>
    <section id="library" class="screen"></section>
  `;
  // populate splash spiral
  const path = goldenSplashPath();
  document.getElementById('splashSpiral').setAttribute('d', path);
  $$('.mode-btn').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    enterLive();
  }));
  $('#photoPicker').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) enterPhoto(f);
    e.target.value = '';
  });
  $('#openLib').addEventListener('click', enterLibrary);
}

// ──────────────────────────────────────────────
// Photo analysis (camera roll)
// ──────────────────────────────────────────────
async function enterPhoto(file) {
  $('#splash').classList.remove('active');
  const photo = $('#photo');
  photo.classList.add('active');
  photo.innerHTML = `
    <button class="back glass" id="pback" aria-label="Back">←</button>
    <div class="modebar" id="pmodebar">
      ${MODE_LIST.map(m => `<button data-mode="${m.id}" class="${m.id === state.mode ? 'on' : ''}">${m.name}</button>`).join('')}
    </div>
    <div class="photo-stage" id="pstage">
      <img id="pimg" alt=""/>
      <canvas id="poverlay"></canvas>
    </div>
    <div class="photo-bar glass" id="pbar">
      <div class="pbar-info" id="pinfo">analysing…</div>
      <div class="pbar-actions">
        <label class="pbar-btn" for="photoPicker2">↑ New photo<input type="file" id="photoPicker2" accept="image/*" hidden/></label>
        <button class="pbar-btn primary" id="psave">Save</button>
      </div>
    </div>
  `;

  $('#pback').addEventListener('click', () => {
    photo.classList.remove('active');
    renderSplash();
  });
  $$('#pmodebar button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    $$('#pmodebar button').forEach(x => x.classList.toggle('on', x.dataset.mode === state.mode));
    analysePhoto();
  }));
  $('#photoPicker2').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadPhotoFile(f);
    e.target.value = '';
  });
  $('#psave').addEventListener('click', savePhotoResult);

  loadPhotoFile(file);
}

function loadPhotoFile(file) {
  const img = $('#pimg');
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    analysePhoto();
  };
  img.src = url;
}

function analysePhoto() {
  const img = $('#pimg');
  const cv = $('#poverlay');
  if (!img.naturalWidth) return;
  state.detector = state.detector || new GoldenDetector(160, 160);
  const tracker = new Tracker();
  // run detection a few times to let the tracker settle
  let dets = [];
  for (let i = 0; i < 4; i++) {
    dets = state.detector.detect(img, 4, 'contain');
    tracker.update(dets);
  }
  state.tracks = tracker.tracks;

  // size the overlay to the displayed image
  const r = img.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = r.width * dpr;
  cv.height = r.height * dpr;
  cv.style.width = r.width + 'px';
  cv.style.height = r.height + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  MODES[state.mode]?.({
    ctx, W: r.width, H: r.height,
    tracks: state.tracks, accent: '#d9b04a',
    hud: state.hud, hunt: state.hunt,
  });

  const best = state.tracks[0];
  const info = $('#pinfo');
  if (best && best.box.conf > 0.25) {
    info.innerHTML = `Found <b>${state.tracks.length}</b> φ-candidate${state.tracks.length>1?'s':''} · best <b>${best.box.ar.toFixed(2)}</b> (Δφ ${Math.abs(best.box.ar - PHI).toFixed(3)})`;
  } else {
    info.textContent = 'No strong φ-rectangles found. Try a photo with clear edges.';
  }
}

function savePhotoResult() {
  const img = $('#pimg');
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0, W, H);
  MODES[state.mode]?.({
    ctx: cx, W, H, tracks: state.tracks, accent: '#d9b04a',
    hud: state.hud, hunt: state.hunt,
  });
  c.toBlob((blob) => {
    if (!blob) return;
    if (navigator.share && navigator.canShare?.({ files: [new File([blob], 'golden.jpg')] })) {
      navigator.share({ files: [new File([blob], 'golden.jpg', { type: 'image/jpeg' })], title: 'φ in the wild' }).catch(()=>{});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `golden-${Date.now()}.jpg`;
      a.click();
    }
  }, 'image/jpeg', 0.92);
}

function goldenSplashPath() {
  // a spiral fitting 220 wide × 140 tall (~PHI rect)
  let w = 220, h = 140, bx = 0, by = 0, bw = w, bh = h, dir = 0;
  let d = '', first = true;
  for (let i = 0; i < 8; i++) {
    const sq = Math.min(bw, bh);
    let sx, sy, ex, ey;
    if (dir === 0) { sx = bx; sy = by + sq; ex = bx + sq; ey = by; bx += sq; bw -= sq; }
    else if (dir === 1) { sx = bx; sy = by; ex = bx + sq; ey = by + sq; by += sq; bh -= sq; }
    else if (dir === 2) { sx = bx + bw; sy = by; ex = bx + bw - sq; ey = by + sq; bw -= sq; }
    else { sx = bx + bw; sy = by + bh; ex = bx; ey = by + bh - sq; bh -= sq; }
    if (first) { d += `M ${sx} ${sy} `; first = false; }
    d += `A ${sq} ${sq} 0 0 1 ${ex} ${ey} `;
    dir = (dir + 1) % 4;
    if (sq < 2) break;
  }
  return d;
}

// ──────────────────────────────────────────────────────────────
// Camera
// ──────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream = stream;
    state.video.srcObject = stream;
    await state.video.play();
    return true;
  } catch (e) {
    showCameraError(e);
    return false;
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
}

function showCameraError(e) {
  const live = $('#live');
  live.innerHTML = `
    <div class="center-msg">
      <h2>Camera blocked</h2>
      <p>${e.name === 'NotAllowedError'
        ? 'Permission denied. Open iOS Settings → Safari → Camera → Allow, then reload.'
        : 'Camera is unavailable. Try a different browser or reload.'}</p>
      <button class="btn-primary" id="retry">Try again</button>
    </div>
  `;
  $('#retry').addEventListener('click', () => enterLive());
}

// ──────────────────────────────────────────────────────────────
// Live screen
// ──────────────────────────────────────────────────────────────
async function enterLive() {
  $('#splash').classList.remove('active');
  const live = $('#live');
  live.classList.add('active');
  live.innerHTML = `
    <video id="cam" autoplay muted playsinline webkit-playsinline></video>
    <canvas id="overlay"></canvas>
    <div id="ui"></div>
    <div class="modebar" id="modebar">
      ${MODE_LIST.map(m => `<button data-mode="${m.id}" class="${m.id === state.mode ? 'on' : ''}">${m.name}</button>`).join('')}
    </div>
    <button class="back glass" id="back" aria-label="Back">←</button>
  `;
  state.video = $('#cam');
  state.overlay = $('#overlay');
  state.octx = state.overlay.getContext('2d');
  state.detector = state.detector || new GoldenDetector(120, 80);
  state.tracker = new Tracker();

  $('#back').addEventListener('click', () => {
    stopCamera();
    state.screen = 'splash';
    renderSplash();
  });
  $$('#modebar button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    $$('#modebar button').forEach(x => x.classList.toggle('on', x.dataset.mode === state.mode));
    renderModeUI();
  }));

  const ok = await startCamera();
  if (!ok) return;
  resizeOverlay();
  window.addEventListener('resize', resizeOverlay);
  renderModeUI();
  startLoop();
}

function resizeOverlay() {
  if (!state.overlay) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = state.overlay.getBoundingClientRect();
  state.overlay.width = rect.width * dpr;
  state.overlay.height = rect.height * dpr;
  state.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ──────────────────────────────────────────────────────────────
// Render mode UI (HTML overlay on top of canvas)
// ──────────────────────────────────────────────────────────────
function renderModeUI() {
  const ui = $('#ui');
  ui.innerHTML = '';
  const shutterHTML = `<button class="shutter ${state.mode === 'playful' ? 'hunt-shutter' : ''}" id="shutter" aria-label="Capture"></button>`;

  if (state.mode === 'minimal') {
    ui.innerHTML = shutterHTML;
  } else if (state.mode === 'photographer') {
    ui.innerHTML = `
      <div class="hud-readout glass" id="hud">
        <h4>RATIO METER</h4>
        <div><span class="lbl">w/h ····</span> <span class="val" id="hud-ar">—</span></div>
        <div><span class="lbl">Δφ ·····</span> <span class="val" id="hud-dphi">—</span></div>
        <div><span class="lbl">conf ···</span> <span class="val" id="hud-conf">—</span></div>
      </div>
      <div class="hud-tools">
        <button class="hud-tool glass on" data-tool="grid">GRID</button>
        <button class="hud-tool glass" data-tool="lock">LOCK</button>
        <button class="hud-tool glass" data-tool="flip">FLIP</button>
      </div>
      ${shutterHTML}
    `;
    $$('.hud-tool').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.tool === 'flip') flipCamera();
      else b.classList.toggle('on');
    }));
  } else if (state.mode === 'educational') {
    ui.innerHTML = `
      <div class="edu-callout glass hidden" id="edu-callout">
        <div class="ck">GOLDEN RECTANGLE · <span id="edu-conf">—</span>%</div>
        <div class="ct">A rectangle whose long side is <span style="color:var(--accent-2)">1.618×</span> the short. Nature reuses this everywhere.</div>
      </div>
      <div class="edu-sheet glass" id="edu-sheet">
        <div class="edu-grip"></div>
        <div class="edu-title">What is φ?</div>
        <div class="edu-sub">3 ways it shows up around you</div>
        <div class="edu-cards">
          <div class="edu-card"><div class="k">φ-RECT</div><div class="v">Windows, screens, books</div></div>
          <div class="edu-card"><div class="k">SPIRAL</div><div class="v">Shells, ferns, galaxies</div></div>
          <div class="edu-card"><div class="k">FACE</div><div class="v">Eye / nose / mouth bands</div></div>
        </div>
        <div class="edu-body">
          <p>The golden ratio <span class="phi">φ ≈ 1.618</span> is the value where a line, split into two pieces, has the same ratio between the whole and the long piece as between the long and the short.</p>
          <p>Point your camera at a window, doorway, or a leaf. The overlay locks onto rectangles near this ratio and draws the spiral they imply.</p>
        </div>
      </div>
    `;
    const sheet = $('#edu-sheet');
    sheet.addEventListener('click', () => sheet.classList.toggle('expanded'));
  } else if (state.mode === 'playful') {
    const total = 50;
    const slots = Array.from({ length: 6 }).map((_, i) => {
      const item = state.hunt.collection[i];
      return item
        ? `<div class="hunt-slot"><img src="${item.img}" alt=""/></div>`
        : `<div class="hunt-slot empty"></div>`;
    }).join('');
    ui.innerHTML = `
      <div class="hunt-bar">
        <div class="hunt-chip glass">🏆 <span class="num">${state.hunt.collection.length}</span> / ${total}</div>
        <div class="hunt-chip glass">⚡ streak <span class="num">${state.hunt.streak}</span></div>
      </div>
      <div class="hunt-toast" id="toast">SPOTTED!</div>
      <div class="hunt-drawer glass">
        <h4>My collection <span>last ${Math.min(6, state.hunt.collection.length)}</span></h4>
        <div class="hunt-grid">${slots}</div>
      </div>
      ${shutterHTML}
    `;
  }
  const sh = $('#shutter');
  if (sh) sh.addEventListener('click', capture);
}

let usingFront = false;
async function flipCamera() {
  usingFront = !usingFront;
  stopCamera();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: usingFront ? 'user' : { ideal: 'environment' } },
      audio: false,
    });
    state.stream = stream;
    state.video.srcObject = stream;
    await state.video.play();
  } catch (e) { showCameraError(e); }
}

// ──────────────────────────────────────────────────────────────
// Capture (snapshot)
// ──────────────────────────────────────────────────────────────
function capture() {
  const v = state.video;
  if (!v || !v.videoWidth) return;
  // composite frame + overlay into a single image
  const w = v.videoWidth, h = v.videoHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.drawImage(v, 0, 0, w, h);
  // re-draw overlays at this resolution
  drawAll(cx, w, h);

  if (state.mode === 'playful') {
    // add a small thumbnail to collection
    const thumb = document.createElement('canvas');
    thumb.width = 200; thumb.height = 200;
    const tx = thumb.getContext('2d');
    const s = Math.min(w, h);
    tx.drawImage(c, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 200, 200);
    const dataUrl = thumb.toDataURL('image/jpeg', 0.7);
    state.hunt.collection.unshift({ img: dataUrl, t: Date.now() });
    if (state.hunt.collection.length > 30) state.hunt.collection.pop();
    state.hunt.streak += 1;
    localStorage.setItem('golden.collection', JSON.stringify(state.hunt.collection));
    localStorage.setItem('golden.streak', String(state.hunt.streak));
    state.hunt.flashUntil = Date.now() + 400;
    const toast = $('#toast');
    if (toast) {
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 900);
    }
    renderModeUI();
  } else {
    // download / share frame
    c.toBlob((blob) => {
      if (!blob) return;
      if (navigator.share && navigator.canShare?.({ files: [new File([blob], 'golden.jpg')] })) {
        navigator.share({ files: [new File([blob], 'golden.jpg', { type: 'image/jpeg' })],
          title: 'φ in the wild' }).catch(()=>{});
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `golden-${Date.now()}.jpg`;
        a.click();
      }
    }, 'image/jpeg', 0.92);
  }
}

// ──────────────────────────────────────────────────────────────
// Frame loop
// ──────────────────────────────────────────────────────────────
function startLoop() {
  const loop = () => {
    if (!state.video) return;
    const now = performance.now();
    if (now - state.lastDetect > 180) {
      const dets = state.detector.detect(state.video, 3);
      state.tracks = state.tracker.update(dets);
      state.lastDetect = now;
    }
    const rect = state.overlay.getBoundingClientRect();
    state.octx.clearRect(0, 0, rect.width, rect.height);
    drawAll(state.octx, rect.width, rect.height);
    updateHUD();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function drawAll(ctx, W, H) {
  const mode = state.mode;
  const accent = '#d9b04a';
  MODES[mode]?.({
    ctx, W, H,
    tracks: state.tracks.map(t => t),
    accent,
    hud: state.hud,
    hunt: state.hunt,
  });
}

function updateHUD() {
  if (state.mode === 'photographer') {
    const arEl = $('#hud-ar'), dpEl = $('#hud-dphi'), cnEl = $('#hud-conf');
    if (!arEl) return;
    if (state.hud.ar) {
      arEl.textContent = state.hud.ar.toFixed(3);
      dpEl.textContent = state.hud.dphi.toFixed(3);
      cnEl.textContent = Math.round(state.hud.conf * 100) + '%';
    } else {
      arEl.textContent = dpEl.textContent = cnEl.textContent = '—';
    }
  } else if (state.mode === 'educational') {
    const co = $('#edu-callout'), cf = $('#edu-conf');
    const best = state.tracks[0];
    if (co && cf) {
      if (best && best.box.conf > 0.4 && best.age > 3) {
        co.classList.remove('hidden');
        cf.textContent = Math.round(best.box.conf * 100);
      } else {
        co.classList.add('hidden');
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);

// ──────────────────────────────────────────────────────────────
// Library screen — illustrated overlay vocabulary
// ──────────────────────────────────────────────────────────────
const LIBRARY = [
  { id: 'phi-rect', name: 'φ-rectangle',
    where: 'Windows · phone screens · book pages · doorways',
    why: 'A rectangle whose long side is 1.618× the short. The fundamental shape — most other overlays are built from it.',
    draw: (ctx, W, H, a) => { drawRect(ctx, W*0.1, H*0.25, W*0.8, W*0.8/PHI, a, 3); drawSubdivs(ctx, W*0.1, H*0.25, W*0.8, W*0.8/PHI, a, 0.5); }
  },
  { id: 'spiral', name: 'Golden spiral',
    where: 'Shells · ferns · galaxies · hurricane eyes',
    why: 'Quarter-circles inscribed in each square of a recursively-subdivided φ-rectangle. The shape nature reuses most.',
    draw: (ctx, W, H, a) => { drawSpiral(ctx, W*0.1, H*0.25, W*0.8, W*0.8/PHI, a, 3.5); }
  },
  { id: 'phi-grid', name: 'φ-grid',
    where: 'Composition guide — like rule-of-thirds, but tuned',
    why: 'Splits the frame at 1:φ:1. Place subjects on the inner lines or intersections for a more harmonious composition.',
    draw: (ctx, W, H, a) => { drawPhiGridDemo(ctx, W*0.1, H*0.15, W*0.8, H*0.7, a); }
  },
  { id: 'face', name: 'Face proportions',
    where: 'Hairline · brow · nose · chin alignment',
    why: 'Many studies of "beauty" map facial landmarks to φ-spaced horizontal bands. Useful as a portrait guide.',
    draw: (ctx, W, H, a) => { drawFaceDemo(ctx, W*0.5, H*0.5, W*0.32, a); }
  },
  { id: 'fib', name: 'Fibonacci sequence',
    where: 'Counting spirals on a pinecone or sunflower',
    why: 'Each number is the sum of the two before: 1,1,2,3,5,8,13… The ratio of consecutive terms approaches φ.',
    draw: (ctx, W, H, a) => { drawFibDemo(ctx, W*0.1, H*0.3, W*0.8, H*0.4, a); }
  },
  { id: 'subdiv', name: 'φ subdivisions',
    where: 'Layout grids · text columns · UI proportions',
    why: 'Repeatedly slicing a φ-rectangle into a square + smaller φ-rectangle gives a nested rhythm of decreasing sizes.',
    draw: (ctx, W, H, a) => { const rw=W*0.8, rh=rw/PHI; drawRect(ctx, W*0.1, H*0.3, rw, rh, a, 2); drawSubdivs(ctx, W*0.1, H*0.3, rw, rh, a, 0.7); }
  },
];

function drawPhiGridDemo(ctx, x, y, w, h, c) {
  ctx.save();
  ctx.strokeStyle = c; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
  ctx.setLineDash([4,4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  const t = 2 + PHI;
  const x1 = x + w/t, x2 = x + w*(1+PHI)/t;
  const y1 = y + h/t, y2 = y + h*(1+PHI)/t;
  ctx.globalAlpha = 0.85; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1,y); ctx.lineTo(x1,y+h);
  ctx.moveTo(x2,y); ctx.lineTo(x2,y+h);
  ctx.moveTo(x,y1); ctx.lineTo(x+w,y1);
  ctx.moveTo(x,y2); ctx.lineTo(x+w,y2);
  ctx.stroke();
  ctx.fillStyle = c;
  [[x1,y1],[x2,y1],[x1,y2],[x2,y2]].forEach(([px,py])=>{
    ctx.beginPath(); ctx.arc(px,py,4,0,Math.PI*2); ctx.fill();
  });
  ctx.restore();
}

function drawFaceDemo(ctx, cx, cy, r, c) {
  ctx.save();
  ctx.strokeStyle = c; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(cx, cy, r*0.75, r, 0, 0, Math.PI*2); ctx.stroke();
  ctx.setLineDash([4,4]); ctx.globalAlpha = 0.7;
  // 4 horizontal lines at φ-spaced bands within the face oval
  const top = cy - r, bot = cy + r;
  const span = bot - top;
  const ys = [0.31, 0.5, 0.69].map(t => top + span*t);
  ys.forEach(y => { ctx.beginPath(); ctx.moveTo(cx-r*0.85, y); ctx.lineTo(cx+r*0.85, y); ctx.stroke(); });
  ctx.restore();
}

function drawFibDemo(ctx, x, y, w, h, c) {
  ctx.save();
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.5;
  const seq = [1,1,2,3,5,8,13];
  let total = seq.reduce((a,b)=>a+b,0);
  let cx = x;
  ctx.globalAlpha = 0.5;
  seq.forEach((n,i) => {
    const sw = (n/total)*w;
    ctx.strokeRect(cx, y, sw, h);
    ctx.globalAlpha = 1;
    ctx.font = '600 13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(n), cx + sw/2, y + h/2 + 4);
    ctx.globalAlpha = 0.5;
    cx += sw;
  });
  ctx.restore();
}

function enterLibrary() {
  $('#splash').classList.remove('active');
  const lib = $('#library');
  lib.classList.add('active');
  lib.innerHTML = `
    <button class="back glass" id="lback" aria-label="Back">←</button>
    <div class="lib-head">
      <div class="lib-title">Overlay parts</div>
      <div class="lib-sub">The vocabulary the camera looks for.</div>
    </div>
    <div class="lib-grid" id="lgrid">
      ${LIBRARY.map(p => `
        <div class="lib-card" data-id="${p.id}">
          <canvas class="lib-canvas" data-id="${p.id}" width="320" height="200"></canvas>
          <div class="lib-name">${p.name}</div>
          <div class="lib-where">${p.where}</div>
          <div class="lib-why">${p.why}</div>
        </div>
      `).join('')}
    </div>
  `;
  $('#lback').addEventListener('click', () => {
    lib.classList.remove('active');
    renderSplash();
  });
  // draw each part into its canvas
  $$('.lib-canvas').forEach(cv => {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const cx = cv.getContext('2d');
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const part = LIBRARY.find(p => p.id === cv.dataset.id);
    part.draw(cx, W, H, '#d9b04a');
  });
}
