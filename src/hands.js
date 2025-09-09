// src/hands.js
import * as THREE from 'three';
import * as mpHands from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';
import { settings } from './settings.js';
import { pinchEvent } from './particles.js'; // ⟵ NEW: wire to particles
// make sure these are imported near your other imports
// BEFORE
// import { pinchBurst } from './audio.js';

// AFTER
import { startBreak, holdBreak, endBreak } from './audio.js';


// add near your other imports
// Pinch config + state (used by onResults + drawPreview)
const PINCH_ON  = settings.pinchOnThreshold  ?? 0.78;
const PINCH_OFF = settings.pinchOffThreshold ?? 0.62;
const PINCH_SMOOTH = settings.pinchSmoothing ?? 0.25;

let isPinching = false;
let pinchStrengthSm = 0;
let lastPinchScreen = { x: 0.5, y: 0.5, z: 0 };





// Keep the preview selfie-style? If true we also flip X in toWorld()
// so the 3D reacts on the **same side** you see in the preview.
const MIRROR_PREVIEW = (settings?.mirrorPreview ?? true);

// ===== Public API =====
let ready = false;
const handInfluences = [null, null]; // up to 2 (sorted by confidence)
const gesture = { open: 0, fist: 0, twoHands: false, sep01: 0 };

export function getHandInfluences() {
  const out = [];
  if (handInfluences[0]) out.push(handInfluences[0]);
  if (handInfluences[1]) out.push(handInfluences[1]);
  return out;
}
export function getGestureSummary() {
  return { ...gesture };
}

// ===== Internals =====
const H = {
  Left:  { worldPos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), conf: 0, seen:false },
  Right: { worldPos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), conf: 0, seen:false },
};

let videoEl = null;   // hidden source video (MediaPipe reads from this)
let cam = null;
let hp = null;
let lastTS = performance.now();

// Visible preview canvas (we draw results.image here every frame)
let preview = null;
let pctx = null;

// ---------- utils ----------
const clamp = (v,a,b)=>Math.min(b,Math.max(a,v));
const ema = (cur, t, s)=>cur + (t - cur) * s;

function toWorld(p){
  // If preview is mirrored, flip X here so 3D matches what you see.
  const x = MIRROR_PREVIEW ? (1 - p.x) : p.x;
  const y = p.y;
  const z = p.z;
  return new THREE.Vector3(
    (x * 2 - 1) * 30,    // right on preview → +X in world
    -(y * 2 - 1) * 30,   // up on preview → +Y in world
    (settings?.invertDepth ? -1 : 1) * z * 30
  );
}

// Thumb–Index pinch strength in [0..1], size-normalized
function pinchStrengthFrom(lm){
  const WRIST=0, MID=9, TH=4, ID=8;
  const dx = lm[TH].x - lm[ID].x, dy = lm[TH].y - lm[ID].y, dz = (lm[TH].z - lm[ID].z)*0.7;
  const d  = Math.hypot(dx, dy, dz);
  const sx = lm[MID].x - lm[WRIST].x, sy = lm[MID].y - lm[WRIST].y, sz = (lm[MID].z - lm[WRIST].z)*0.7;
  const span = Math.max(1e-6, Math.hypot(sx, sy, sz));
  return clamp(1 - (d / (0.7 * span)), 0, 1);
}

// Midpoint of thumb/index in WORLD coords; also update preview-dot coords
function pinchCenterWorld(lm){
  const TH = lm[4], ID = lm[8];
  const mid = { x:(TH.x+ID.x)/2, y:(TH.y+ID.y)/2, z:(TH.z+ID.z)/2 };
  // preview dot (canvas is already mirrored in drawPreview)
  lastPinchScreen.x = MIRROR_PREVIEW ? (1 - mid.x) : mid.x;
  lastPinchScreen.y = mid.y;
  lastPinchScreen.z = mid.z;
  return toWorld(mid);
}


// Openness (size-normalized)
function opennessScore(lm){
  const WRIST=0, M_MCP=9, TIPS=[8,12,16,20];
  const w=lm[WRIST], m=lm[M_MCP];
  const base = Math.hypot(m.x-w.x, m.y-w.y, (m.z-w.z)*0.7);
  if (!Number.isFinite(base) || base<1e-5) return 0;
  let sum=0;
  for(const i of TIPS){
    const t=lm[i];
    sum += Math.hypot(t.x-w.x, t.y-w.y, (t.z-w.z)*0.7);
  }
  const r = (sum/TIPS.length)/base;            // fist≈1.0–1.3, open≈1.8–2.6
  return clamp((r - 1.0)/1.4, 0, 1);
}

// Fist (curl + tip→palm proximity)
function fingerCurl(lm, mcp, pip, tip){
  const ax = (lm[pip].x-lm[mcp].x), ay=(lm[pip].y-lm[mcp].y), az=(lm[pip].z-lm[mcp].z)*0.7;
  const bx = (lm[tip].x-lm[pip].x),  by=(lm[tip].y-lm[pip].y),  bz=(lm[tip].z-lm[pip].z)*0.7;
  const al = Math.hypot(ax,ay,az), bl = Math.hypot(bx,by,bz);
  if (al<1e-6 || bl<1e-6) return 0;
  const dot = clamp((ax/al)*(bx/bl) + (ay/al)*(by/bl) + (az/al)*(bz/bl), -1, 1);
  return (1 - dot) * 0.5; // straight→0, folded→1
}
function proximityScore(lm){
  const PALM=[0,5,9,13,17], TIPS=[8,12,16,20], WRIST=0;
  const c = {
    x:(lm[0].x+lm[5].x+lm[9].x+lm[13].x+lm[17].x)/5,
    y:(lm[0].y+lm[5].y+lm[9].y+lm[13].y+lm[17].y)/5,
    z:(lm[0].z+lm[5].z+lm[9].z+lm[13].z+lm[17].z)/5,
  };
  let scale=0;
  for(const i of PALM){
    scale += Math.hypot(lm[i].x-lm[WRIST].x, lm[i].y-lm[WRIST].y, (lm[i].z-lm[WRIST].z)*0.7);
  }
  scale /= PALM.length;
  if (!Number.isFinite(scale) || scale<1e-5) return 0;
  let sum=0;
  for(const i of TIPS){
    sum += Math.hypot(lm[i].x-c.x, lm[i].y-c.y, (lm[i].z-c.z)*0.7);
  }
  const mean = sum/TIPS.length;
  return clamp(1 - (mean / (1.8*scale)), 0, 1); // closer tips→higher score
}

// ---------- preview helpers ----------
function ensurePreviewCanvas(){
  if ((settings.showCameraPreview ?? true) === false) return;

  if (!preview){
    preview = document.createElement('canvas');
    preview.id = 'webcam-canvas';
    preview.width = 320;  // internal size
    preview.height = 240;
    Object.assign(preview.style, {
      position: 'fixed',
      bottom: '10px',
      right: '10px',
      width: '320px',      // CSS size
      height: '240px',
      border: '2px solid white',
      borderRadius: '8px',
      zIndex: '999999',    // ensure above WebGL
      pointerEvents: 'none',
      background: '#000'
    });
    document.body.appendChild(preview);
    pctx = preview.getContext('2d');
  }
}

function drawPreview(res){
  if (!pctx || !res?.image) return;
  const w = preview.width, h = preview.height;

  pctx.setTransform(1,0,0,1,0,0);   // reset
  pctx.clearRect(0,0,w,h);

  if (MIRROR_PREVIEW) {
    // mirror the whole canvas: easier + landmarks use native coords
    pctx.setTransform(-1,0,0,1,w,0);
  }

  try { pctx.drawImage(res.image, 0, 0, w, h); } catch {}

  // Landmarks
  if (res.multiHandLandmarks){
    pctx.fillStyle = '#00FF88';
    for (const lm of res.multiHandLandmarks){
      for (const p of lm){
        pctx.beginPath();
        pctx.arc(p.x * w, p.y * h, 2, 0, Math.PI*2);
        pctx.fill();
      }
    }
  }

  // (Optional) pinch dot
  if (isPinching){
    pctx.fillStyle = '#FFD400';
    pctx.beginPath();
    // remember: the canvas is already mirrored
    pctx.arc(lastPinchScreen.x * w, lastPinchScreen.y * h, 4, 0, Math.PI*2);
    pctx.fill();
  }

  // restore default transform
  pctx.setTransform(1,0,0,1,0,0);
}

// ========== Init ==========
export async function initHandTracking(){
  if (ready) return;

  ensurePreviewCanvas(); // make sure the visible canvas exists

  // Hidden <video> used as MediaPipe input (we don't show it; we draw frames into preview)
  videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.style.display = 'none';
  document.body.appendChild(videoEl);

  hp = new mpHands.Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
  });
  hp.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: settings.handDetectionThreshold ?? 0.6,
    minTrackingConfidence: settings.handDetectionThreshold ?? 0.6,
  });
  hp.onResults(onResults);

  // Important: use the hidden video as the source, but DRAW into our preview canvas
  cam = new Camera(videoEl, {
    onFrame: async () => { await hp.send({ image: videoEl }); },
    width: 640, height: 480,
    facingMode: 'user',
  });

  await cam.start();
  ready = true;
}

function onResults(res){
  // 1) draw visible preview each frame
  drawPreview(res);

  // 2) update hands + gestures
  const now = performance.now();
  const dt = clamp((now - lastTS)/1000, 0.016, 0.08);
  lastTS = now;

  H.Left.seen = H.Right.seen = false;
  const local = [];

  // ===== pinch evaluation across hands (inline helpers) =====
  let bestPinchStrength = 0;
  let bestPinchWorld = null;

  if (res.multiHandLandmarks && res.multiHandLandmarks.length){
    for (let i=0;i<res.multiHandLandmarks.length;i++){
      const lm = res.multiHandLandmarks[i];
      const label = res.multiHandedness?.[i]?.label || 'Right';
      const conf  = res.multiHandedness?.[i]?.score ?? 0;

      // wrist → world (for follow & forces)
      const wrist = lm[0];
      const wp = toWorld(wrist);

      const h = H[label] || H.Right;
      h.prev.copy(h.worldPos);
      h.worldPos.copy(wp);
      h.vel.copy(h.worldPos).sub(h.prev).multiplyScalar(1/dt);
      h.conf = conf; h.seen = true;

      // ---- gesture components (unchanged) ----
      const open = opennessScore(lm);
      const curl = (
        fingerCurl(lm,5,6,8) + fingerCurl(lm,9,10,12) +
        fingerCurl(lm,13,14,16) + fingerCurl(lm,17,18,20)
      )/4;
      const prox = proximityScore(lm);
      const fist = clamp(0.55*curl + 0.45*prox, 0, 1);

      local.push({
        handedness: label,
        confidence: conf,
        worldPos: h.worldPos.clone(),
        velocity: h.vel.clone(),
        openness: open,
        fist,
        _lm: lm, // keep landmarks for pinch eval
      });

      // ---- INLINE pinch strength + center (no external helpers) ----
      // strength in [0..1], smaller thumb–index distance = stronger pinch
      const WRIST=0, MID=9, TH=4, ID=8;
      const dx = lm[TH].x - lm[ID].x, dy = lm[TH].y - lm[ID].y, dz = (lm[TH].z - lm[ID].z)*0.7;
      const d  = Math.hypot(dx, dy, dz);
      const sx = lm[MID].x - lm[WRIST].x, sy = lm[MID].y - lm[WRIST].y, sz = (lm[MID].z - lm[WRIST].z)*0.7;
      const span = Math.max(1e-6, Math.hypot(sx, sy, sz));
      const ps = clamp(1 - (d / (0.7 * span)), 0, 1);

      if (ps > bestPinchStrength){
        bestPinchStrength = ps;

        // midpoint of thumb/index → world
        const mid = { x:(lm[TH].x+lm[ID].x)/2, y:(lm[TH].y+lm[ID].y)/2, z:(lm[TH].z+lm[ID].z)/2 };
        bestPinchWorld = toWorld(mid);

        // update preview pinch dot if the var exists (avoids crashes)
        try {
          if (typeof lastPinchScreen !== 'undefined') {
            const mirroredX = (typeof MIRROR_PREVIEW !== 'undefined' && MIRROR_PREVIEW) ? (1 - mid.x) : mid.x;
            lastPinchScreen.x = mirroredX;
            lastPinchScreen.y = mid.y;
            lastPinchScreen.z = mid.z;
          }
        } catch {}
      }
    }
  }

  // Sort by confidence (for influences / gestures)
  local.sort((a,b)=>(b.confidence??0)-(a.confidence??0));

  handInfluences[0] = local[0] ? {
    worldPos: local[0].worldPos, velocity: local[0].velocity, confidence: local[0].confidence
  } : null;
  handInfluences[1] = local[1] ? {
    worldPos: local[1].worldPos, velocity: local[1].velocity, confidence: local[1].confidence
  } : null;

  const s = settings.gestureSmoothing ?? 0.25;
  gesture.open = ema(gesture.open,  local[0]?.openness ?? 0, s);
  gesture.fist = ema(gesture.fist,  local[0]?.fist ?? 0,     s);

  if (handInfluences[0] && handInfluences[1]){
    const d = handInfluences[0].worldPos.distanceTo(handInfluences[1].worldPos);
    gesture.sep01 = clamp(d/40, 0, 1);
    gesture.twoHands = true;
  } else {
    gesture.sep01 = ema(gesture.sep01, 0, s);
    gesture.twoHands = false;
  }

  // ===== Pinch hysteresis + events + AUDIO BREAK (persistent while pinching) =====
  const PINCH_ON  = settings.pinchOnThreshold  ?? 0.78;
  const PINCH_OFF = settings.pinchOffThreshold ?? 0.62;
  const PINCH_SMOOTH = settings.pinchSmoothing ?? 0.25;

  pinchStrengthSm = ema(pinchStrengthSm, bestPinchStrength, PINCH_SMOOTH);

  if (!isPinching && pinchStrengthSm >= PINCH_ON){
    isPinching = true;
    pinchEvent({ phase: 'start', strength: pinchStrengthSm, worldPos: bestPinchWorld ?? H.Right.worldPos });
    // 🔊 start persistent break music
    try { startBreak(pinchStrengthSm); } catch {}
  } else if (isPinching && pinchStrengthSm <= PINCH_OFF){
    isPinching = false;
    pinchEvent({ phase: 'end' });
    // 🔇 stop break music
    try { endBreak(); } catch {}
  } else if (isPinching){
    pinchEvent({ phase: 'hold', strength: pinchStrengthSm, worldPos: bestPinchWorld ?? H.Right.worldPos });
    // 🎚️ keep break alive / update intensity
    try { holdBreak(pinchStrengthSm); } catch {}
  }

  // If no hands at all, ensure pinch ends
  if ((!res.multiHandLandmarks || res.multiHandLandmarks.length === 0) && isPinching){
    isPinching = false;
    pinchEvent({ phase: 'end' });
    try { endBreak(); } catch {}
  }
}
