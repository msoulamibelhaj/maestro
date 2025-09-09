// audio.js — Persistent BREAK mode while pinching
// Exports: initAudioAnalysis, analyzeAudio, routeHandsToAudio, ensureAudioReady,
//          startBreak, holdBreak, endBreak, frequencyData, kickPulse

import { settings } from './settings.js';
import { createTechnoEngine } from './techno.js';

export let audioCtx;
export let analyser;
export let frequencyData = { bass: 0, mid: 0, treble: 0, level: 0 };
export let kickPulse = 0;

// ===== shared nodes =====
let dataArray;
let mediaEl, mediaSource;

let mediaIn;        // media input
let bassShelf, trebleShelf, lpf;
let dryGain;        // media split before master
let delaySend, delayNode, delayFeedback, delayReturn;
let masterGain;     // media master (pump + break duck acts here)

let engine;         // techno engine
let engineGain;     // engine dry trim (break duck acts here)

let sumBus;         // media + engine + break
let limiter;        // final safety

// ===== Break bus (persistent while pinching) =====
let breakBus, breakSat, breakLimiter, breakGain;
let noiseBuffer = null;
let curBPM = settings?.bpm ?? 128;
let baseMaster = 1.0;
let baseEngine = 0.9;

// Break state + scheduler
let breakActive = false;
let breakTargetGain = 1.8;   // will follow pinch strength
let breakDuckFloor = 0.08;   // floor for media/engine while breaking
let lookahead = 0.025;       // s
let scheduleAheadTime = 0.15;// s
let schedulerTimer = null;
let nextNoteTime = 0;        // absolute time for next step
let step = 0;                // 0..15 (sixteenth grid)

// Reese (sustained while breaking)
let reese = null; // { o1, o2, mix, lp, drive, g }

/*** GROOVE profile (subtle pinch music) ***/
const GROOVE = {
  // overall pinch layer loudness = base + span*strength (clamped later)
  breakGainBase: 0.7,
  breakGainSpan: 0.5,     // max ~1.2 (was 1.8+)
  // keep most of the original mix during pinch (light duck)
  duckFloorMin: 0.75,     // strongest pinch keeps ~75% of original
  duckFloorMax: 0.90,     // soft pinch keeps ~90% of original
  // softer color
  satAmount: 0.6,         // was 1.2
  // instrument balances
  mix: { kick: 0.55, snare: 0.50, hat: 0.35, crash: 0.22 },
  reeseLevel: 0.0         // 0 = OFF (set ~0.15 if you want a tiny bass bed)
};

// ===== utils =====
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (Number.isFinite(v) ? v : d);
function safeSet(param, value, def, min, max) {
  const v = clamp(num(value, def), min, max);
  if (Number.isFinite(v)) param.value = v;
}
function makeNoiseBuffer(ctx, dur=2.0){
  const sr = ctx.sampleRate, n = Math.max(1, Math.floor(sr*dur));
  const buf = ctx.createBuffer(1, n, sr);
  const ch = buf.getChannelData(0);
  for (let i=0;i<n;i++) ch[i] = Math.random()*2-1;
  return buf;
}
function makeShaper(ctx, amount=1.0){
  const n = 2048, curve = new Float32Array(n);
  const k = amount*60 + 1;
  for (let i=0;i<n;i++){ const x=i/(n-1)*2-1; curve[i]=(1+k)*x/(1+k*Math.abs(x)); }
  const ws = ctx.createWaveShaper(); ws.curve = curve; ws.oversample = '4x'; return ws;
}

const DEF = {
  lpfMin: 180, lpfMax: 18000,
  delayMinMS: 90, delayMaxMS: 220,
  feedback: 0.25, gain: 1.0,
  bpm: 128, swing: 0.06,
  technoGain: 0.9,
  autoTechno: true,
  engineThroughFX: false,
  delaySend: 0.35,
  pumpAmount: 0.15,
};

// ===== init / ensure =====
// ====== INIT (ordered so every connect() sees a real node) ======
export async function initAudioAnalysis() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }

  // --- Analyser
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  dataArray = new Uint8Array(analyser.frequencyBinCount);

  // --- MEDIA FX CHAIN
  mediaIn = audioCtx.createGain();

  bassShelf = audioCtx.createBiquadFilter(); bassShelf.type = 'lowshelf';
  bassShelf.frequency.value = 200; bassShelf.gain.value = settings?.bassBoost ?? 0;

  trebleShelf = audioCtx.createBiquadFilter(); trebleShelf.type = 'highshelf';
  trebleShelf.frequency.value = 2000; trebleShelf.gain.value = settings?.trebleBoost ?? 0;

  lpf = audioCtx.createBiquadFilter(); lpf.type = 'lowpass';
  lpf.frequency.value = settings?.masterLPFMax ?? 18000;

  dryGain = audioCtx.createGain(); dryGain.gain.value = 1.0;

  // wire media path to dry split
  mediaIn.connect(bassShelf);
  bassShelf.connect(trebleShelf);
  trebleShelf.connect(lpf);
  lpf.connect(dryGain);

  // --- Delay loop on MEDIA path
  delaySend = audioCtx.createGain(); delaySend.gain.value = settings?.delaySend ?? 0.35;
  dryGain.connect(delaySend);

  delayNode = audioCtx.createDelay(2.0);
  delayNode.delayTime.value = (settings?.delayMinMS ?? 90) / 1000;

  delayFeedback = audioCtx.createGain(); delayFeedback.gain.value = settings?.delayFeedback ?? 0.25;

  delaySend.connect(delayNode);
  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);

  delayReturn = audioCtx.createGain(); delayReturn.gain.value = 1.0;
  delayNode.connect(delayReturn);

  // Media master AFTER dry split & delay return
  masterGain = audioCtx.createGain();
  baseMaster = (settings?.masterGain ?? 1.0);
  masterGain.gain.value = baseMaster;
  dryGain.connect(masterGain);
  delayReturn.connect(masterGain);

  // --- ENGINE (techno)
  engine = createTechnoEngine(audioCtx);
  engineGain = audioCtx.createGain();
  baseEngine = (settings?.technoGain ?? 0.9);
  engineGain.gain.value = baseEngine;

  try { engine.bus.disconnect(); } catch {}
  const throughFX = settings?.engineThroughFX ?? false;
  if (throughFX) {
    engine.bus.connect(mediaIn);     // through media FX
  } else {
    engine.bus.connect(engineGain);  // dry to mix
  }

  // --- SUM BUS (create BEFORE we connect break bus to it)
  sumBus = audioCtx.createGain();
  masterGain.connect(sumBus);
  if (!throughFX) engineGain.connect(sumBus);

  // --- BREAK BUS (subtle groove overlay + small delay glue send)
  breakBus = audioCtx.createGain();

  breakSat = makeShaper(audioCtx, GROOVE.satAmount);
  breakLimiter = audioCtx.createDynamicsCompressor();
  breakLimiter.threshold.value = -8;
  breakLimiter.knee.value = 0;
  breakLimiter.ratio.value = 12;
  breakLimiter.attack.value = 0.002;
  breakLimiter.release.value = 0.12;

  breakGain = audioCtx.createGain();
  breakGain.gain.value = 0.0; // off until pinch

  const breakGlueSend = audioCtx.createGain();
  breakGlueSend.gain.value = 0.18; // tiny amount into your existing delay loop

  // wire break chain
  breakBus
    .connect(breakSat)
    .connect(breakLimiter);

  breakLimiter.connect(breakGain);       // main path to mix
  breakLimiter.connect(breakGlueSend);   // glue into delay
  breakGlueSend.connect(delayNode);      // (valid: DelayNode is an AudioNode)
  breakGain.connect(sumBus);             // <-- sumBus EXISTS already

  // --- FINAL LIMITER → ANALYSER → DEST
  limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;

  sumBus.connect(limiter);
  limiter.connect(analyser);
  analyser.connect(audioCtx.destination);

  // --- MEDIA element hookup
  mediaEl = document.getElementById('audio-player') || null;
  if (mediaEl) {
    try { mediaSource = audioCtx.createMediaElementSource(mediaEl); mediaSource.connect(mediaIn); } catch (e) {}
    const resumeCtx = () => { if (audioCtx.state === 'suspended') audioCtx.resume(); };
    ['play','pause','ended','seeking','seeked','ratechange','volumechange'].forEach(ev =>
      mediaEl.addEventListener(ev, resumeCtx, { passive: true })
    );
  } else {
    const cs = audioCtx.createConstantSource(); cs.offset.value = 0;
    cs.connect(mediaIn); cs.start();
  }

  // engine kick → visual pulse
  let engineKickEnv = 0;
  engine.setKickCallback(() => { engineKickEnv = 1.0; });
  window.__getEngineKick = () => { engineKickEnv *= 0.86; return Math.max(0, Math.min(1, engineKickEnv)); };

  // autostart engine if no media
  const autoTechno = settings?.autoTechnoWhenNoTrack ?? true;
  let shouldStart = autoTechno;
  if (mediaEl) { try { shouldStart = autoTechno && (mediaEl.paused || mediaEl.ended || mediaEl.currentTime === 0); } catch {} }
  if (shouldStart) engine.start();

  if (!noiseBuffer) noiseBuffer = makeNoiseBuffer(audioCtx, 2.0);
}

export async function ensureAudioReady() {
  if (!audioCtx) await initAudioAnalysis();
  try { if (audioCtx.state === 'suspended') await audioCtx.resume(); } catch {}
}

// ===== analysis / pump =====
let bassFloor = 0;
export function analyzeAudio() {
  if (!analyser) return;

  analyser.getByteFrequencyData(dataArray);
  const n = dataArray.length;
  let sum = 0; for (let i=0;i<n;i++) sum += dataArray[i];
  frequencyData.level = sum / (n*255);

  const bassEnd = Math.floor(n*0.10);
  const midEnd  = Math.floor(n*0.40);
  let b=0,m=0,t=0;
  for (let i=0;i<bassEnd;i++) b += dataArray[i];
  for (let i=bassEnd;i<midEnd;i++) m += dataArray[i];
  for (let i=midEnd;i<n;i++) t += dataArray[i];
  frequencyData.bass   = (b/Math.max(1,bassEnd))/255;
  frequencyData.mid    = (m/Math.max(1,midEnd-bassEnd))/255;
  frequencyData.treble = (t/Math.max(1,n-midEnd))/255;

  bassFloor += (frequencyData.bass - bassFloor) * 0.12;
  const kickFromAudio = clamp((frequencyData.bass - bassFloor) * 6.0, 0, 1);
  const kickFromEngine = typeof window.__getEngineKick === 'function' ? window.__getEngineKick() : 0;
  kickPulse = Math.max(kickFromAudio, kickFromEngine);

  // normal pump on media path
  if (masterGain && !breakActive) {
    const base = baseMaster;
    const pumpAmt = clamp(num(settings?.pumpAmount ?? DEF.pumpAmount, DEF.pumpAmount), 0, 0.85);
    masterGain.gain.value = clamp(base * (1.0 - pumpAmt * kickPulse), 0, 2.0);
  }
}

// ===== hand → audio (LPF / Delay / BPM) =====
export function routeHandsToAudio(dominant, gesture = undefined) {
  if (!audioCtx || !lpf || !delayNode || !delayFeedback) return;

  const clamp01 = (x)=>Math.min(1,Math.max(0,x));
  const y = dominant?.worldPos?.y ?? 0;   // -30..+30
  const y01 = clamp01((y + 30) / 60);
  const fMin = num(settings?.masterLPFMin ?? DEF.lpfMin, DEF.lpfMin);
  const fMax = num(settings?.masterLPFMax ?? DEF.lpfMax, DEF.lpfMax);
  const cutoff = fMin * Math.pow(fMax / fMin, y01);
  lpf.frequency.value = clamp(cutoff, 20, 22050);

  const x = dominant?.worldPos?.x ?? 0;
  const x01 = clamp01((x + 30) / 60);
  const dMin = (settings?.delayMinMS ?? DEF.delayMinMS) / 1000;
  const dMax = (settings?.delayMaxMS ?? DEF.delayMaxMS) / 1000;
  delayNode.delayTime.value = dMin + (dMax - dMin) * x01;

  const v = dominant?.velocity ? Math.hypot(dominant.velocity.x, dominant.velocity.y, dominant.velocity.z) : 0;
  const spd01 = clamp01(v / 140);
  const fbBase = settings?.delayFeedback ?? DEF.feedback;
  delayFeedback.gain.value = clamp(fbBase * (0.7 + 0.3 * spd01), 0, 0.95);

  // Track BPM for scheduler
  try {
    const bpmBase = num(settings?.bpm ?? DEF.bpm, DEF.bpm);
    const bpmVar = bpmBase * (0.9 + 0.2 * (y01 - 0.5)); // ±10%
    const clamped = clamp(bpmVar, 90, 160);
    engine?.setBPM(clamped);
    curBPM = clamped;
  } catch {}
}

// ===== BREAK MODE (persistent) =====
// ===== Subtle, persistent break while pinching =====


// drum one-shots used by the scheduler
function hatAt(t, g=1.0){
  const src = audioCtx.createBufferSource(); src.buffer = noiseBuffer;
  const hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 9000;
  const gg = audioCtx.createGain(); gg.gain.setValueAtTime(0, t);
  gg.gain.linearRampToValueAtTime(0.9*g, t + 0.003);
  gg.gain.exponentialRampToValueAtTime(1e-3, t + 0.05);
  src.connect(hp).connect(gg).connect(breakBus);
  src.start(t); src.stop(t + 0.12);
}
function snareAt(t, g=1.0){
  const n = audioCtx.createBufferSource(); n.buffer = noiseBuffer;
  const bp = audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.9;
  const ng = audioCtx.createGain(); ng.gain.setValueAtTime(0, t);
  ng.gain.linearRampToValueAtTime(1.2*g, t + 0.004);
  ng.gain.exponentialRampToValueAtTime(1e-3, t + 0.14);
  n.connect(bp).connect(ng).connect(breakBus);
  n.start(t); n.stop(t + 0.25);
}
function kickAt(t, g=1.0){
  const o = audioCtx.createOscillator(); o.type='sine';
  o.frequency.setValueAtTime(190, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
  const gg = audioCtx.createGain(); gg.gain.setValueAtTime(0, t);
  gg.gain.linearRampToValueAtTime(1.2*g, t + 0.004);
  gg.gain.exponentialRampToValueAtTime(1e-3, t + 0.22);
  const hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 25;
  o.connect(hp).connect(gg).connect(breakBus);
  o.start(t); o.stop(t + 0.26);
}
function crashAt(t, g=0.2){
  if (g <= 0) return;
  const src = audioCtx.createBufferSource(); src.buffer = noiseBuffer;
  const hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 5500;
  const gg = audioCtx.createGain(); gg.gain.setValueAtTime(0, t);
  gg.gain.linearRampToValueAtTime(1.5*g, t + 0.02);
  gg.gain.exponentialRampToValueAtTime(1e-3, t + 1.0);
  src.connect(hp).connect(gg).connect(breakBus);
  src.start(t); src.stop(t + 1.2);
}


function scheduleNextSteps() {
  if (!breakActive) return;
  const bpm = curBPM || (settings?.bpm ?? 128);
  const spb = 60 / bpm;
  const stepDur = spb / 4;

  while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
    const s = step % 16;
    if (s % 4 === 0) kickAt(nextNoteTime, GROOVE.mix.kick);
    if (s === 4 || s === 12) snareAt(nextNoteTime, GROOVE.mix.snare);
    hatAt(nextNoteTime, GROOVE.mix.hat);
    step = (step + 1) & 15;
    nextNoteTime += stepDur;
  }
}
function schedulerTick() {
  if (!breakActive) { schedulerTimer = null; return; }
  scheduleNextSteps();
  schedulerTimer = setTimeout(schedulerTick, lookahead * 1000);
}

export async function startBreak(strength = 1) {
  await ensureAudioReady();
  if (breakActive) return holdBreak(strength);

  breakActive = true;
  const s = Math.max(0, Math.min(1, strength));
  breakTargetGain = GROOVE.breakGainBase + GROOVE.breakGainSpan * s;          // ~0.7..1.2
  breakDuckFloor  = GROOVE.duckFloorMax - (GROOVE.duckFloorMax - GROOVE.duckFloorMin) * s;

  const t = audioCtx.currentTime + 0.01;

  // light duck of original
  masterGain.gain.cancelScheduledValues(t);
  engineGain.gain.cancelScheduledValues(t);
  masterGain.gain.linearRampToValueAtTime(baseMaster * breakDuckFloor, t + 0.08);
  engineGain.gain.linearRampToValueAtTime(baseEngine * breakDuckFloor, t + 0.08);

  // bring in groove layer
  breakGain.gain.cancelScheduledValues(t);
  breakGain.gain.linearRampToValueAtTime(breakTargetGain, t + 0.10);

  // open highs slightly
  if (lpf?.frequency) {
    lpf.frequency.cancelScheduledValues(t);
    lpf.frequency.setValueAtTime(lpf.frequency.value, t);
    lpf.frequency.linearRampToValueAtTime(16000, t + 0.08);
  }

  // very low crash (or comment out to remove)
  crashAt(t + 0.02, GROOVE.mix.crash);

  // start scheduler
  step = 0;
  const bpm = curBPM || (settings?.bpm ?? 128);
  nextNoteTime = t + 0.05;
  if (!schedulerTimer) schedulerTick();
}

export function holdBreak(strength = 1) {
  if (!audioCtx || !breakActive) return;
  const s = Math.max(0, Math.min(1, strength));
  breakTargetGain = GROOVE.breakGainBase + GROOVE.breakGainSpan * s;
  breakDuckFloor  = GROOVE.duckFloorMax - (GROOVE.duckFloorMax - GROOVE.duckFloorMin) * s;

  const t = audioCtx.currentTime;
  breakGain.gain.linearRampToValueAtTime(breakTargetGain, t + 0.08);
  masterGain.gain.linearRampToValueAtTime(baseMaster * breakDuckFloor, t + 0.08);
  engineGain.gain.linearRampToValueAtTime(baseEngine * breakDuckFloor, t + 0.08);
}

export function endBreak() {
  if (!audioCtx || !breakActive) return;
  breakActive = false;

  const t = audioCtx.currentTime + 0.01;
  // restore original
  masterGain.gain.cancelScheduledValues(t);
  engineGain.gain.cancelScheduledValues(t);
  masterGain.gain.linearRampToValueAtTime(baseMaster, t + 0.18);
  engineGain.gain.linearRampToValueAtTime(baseEngine, t + 0.18);

  // fade groove out
  breakGain.gain.cancelScheduledValues(t);
  breakGain.gain.linearRampToValueAtTime(0.0, t + 0.15);

  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
}

// ---- optional debug hook ----
if (typeof window !== 'undefined') {
  window.__audio = {
    init: initAudioAnalysis,
    ready: ensureAudioReady,
    startBreak: (s=1)=>startBreak(s),
    holdBreak:  (s=1)=>holdBreak(s),
    endBreak:   ()=>endBreak(),
    ctx: ()=>audioCtx
  };
}
