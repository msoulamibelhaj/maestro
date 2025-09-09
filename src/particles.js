// particles.js — same features, now rendered with Points + custom shaders
import * as THREE from 'three';
import { scene } from './scene.js';
import { settings } from './settings.js';

/* =========================
   GLSL SHADERS (inlined)
   ========================= */

const particleVert = /* glsl */`
precision mediump float;
precision mediump int;

uniform float uTime;
uniform float uBass, uMid, uTreble;
uniform float uMusicReactivity, uTrebleSensitivity, uPulseIntensity;

uniform vec3  uCamPos;
uniform float uPointMin, uPointMax;

// extras for subtle motion (optional)
uniform float uRippleAmt;
uniform float uGlowGain;

varying float vAlpha;
varying float vFres;
varying float vDepthK;
varying float vSpark;

attribute float aShell; // 0 inner, 1 outer
attribute float aSeed;

void main(){
  // world-space position is provided by CPU in 'position'
  vec4 worldPos = modelMatrix * vec4(position, 1.0);

  // fresnel vs camera
  vec3 viewDir = normalize(uCamPos - worldPos.xyz);
  vec3 surfN   = normalize(worldPos.xyz);
  float fres   = pow(max(0.0, 1.0 - dot(surfN, viewDir)), 1.6);

  // view
  vec4 mv = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mv;

  // audio-driven point size (kept simple + fresnel bias)
  float audioLift = (uBass + uMid + uTreble) * 0.12 * uMusicReactivity;
  float baseSize  = mix(uPointMin, uPointMax, aShell);
  float size      = baseSize * (1.0 + audioLift) * mix(1.0, 1.22, fres);

  gl_PointSize = size * (300.0 / max(1.0, -mv.z));

  // alpha lane (shader will still gate by sprite mask)
  float a = mix(0.45, 0.80, aShell);
  a *= mix(0.9, 1.1, fres);
  float depthK = clamp((-mv.z - 20.0)/140.0, 0.0, 1.0);
  a *= mix(1.0, 0.8, depthK);

  vAlpha  = clamp(a, 0.0, 0.95);
  vFres   = fres;
  vDepthK = depthK;

  // subtle per-dot sparkle trigger (time-quantized)
  float ph = floor(uTime * 9.0) + aSeed * 0.123;
  float rand = fract(sin(ph*12.9898+78.233)*43758.5453);
  vSpark = smoothstep(0.75, 1.0, rand) * (0.25 + 0.75 * (uTreble*uMusicReactivity));
}
`;

const particleFrag = /* glsl */`
precision mediump float;
precision mediump int;

varying float vAlpha;
varying float vFres;
varying float vDepthK;
varying float vSpark;

uniform vec3 uColInner;
uniform vec3 uColOuter;
uniform vec3 uColRim;
uniform float uColorMix;  // 0..1 blends inner→outer look
uniform float uGlowGain;

// --- tiny 2D value noise (fast, no textures) ---
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0,0.0));
  float c = hash(i + vec2(0.0,1.0));
  float d = hash(i + vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}

void main(){
  // base round sprite
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);

  // animated smoky mask: warp the edge with time-varying noise
  // scale anisotropically so puffs look organic
  vec2 nUV = uv * vec2(7.5, 6.0);
  float n  = noise(nUV + noise(nUV*0.7)*2.0);     // fbm-ish
  float edge = 0.48 + (n - 0.5)*0.10;             // wobble the edge
  float mask = 1.0 - smoothstep(edge, edge+0.02, r);
  if (mask <= 0.0) discard;

  // base palette + depth tint (same idea as before)
  vec3 baseCol = mix(uColInner, uColOuter, uColorMix);
  vec3 depthTintNear = vec3(1.0, 0.98, 0.95);
  vec3 depthTintFar  = vec3(0.86, 0.92, 1.00);
  baseCol *= mix(depthTintNear, depthTintFar, vDepthK);

  // fresnel rim
  vec3 col = baseCol + uColRim * pow(vFres, 1.2);

  // inner brightening + spark
  float core = smoothstep(0.42, 0.0, r);
  col *= (1.0 + core * 0.45);
  col += col * vSpark * core * 0.6;

  // alpha with a soft smoky falloff (multiply by core a touch)
  float alpha = vAlpha * mask * (0.6 + 0.4*core);

  // subtle ordered dither to avoid banding
  vec2 p = gl_FragCoord.xy;
  float d = fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453);
  alpha = clamp(alpha + (d - 0.5) * 0.012, 0.0, 1.0);

  if (alpha < 0.003) discard;
  gl_FragColor = vec4(col * uGlowGain, alpha);
}
`;

/* =========================
   Original state & helpers
   ========================= */

// Two Points layers instead of InstancedMesh
let innerMesh, outerMesh;          // THREE.Points
let innerGeo,  outerGeo;           // BufferGeometry with dynamic 'position'
let innerDirs = null;
let outerDirs = null;

let baseRadius = settings.sphereRadius ?? 16;
const followPos = new THREE.Vector3(0,0,0);

// -------- Pinch/shatter state --------
let explode = 0;
let explodeTarget = 0;
let impulse = 0;
let reformT = 0;
const pinchCenter = new THREE.Vector3(0,0,0);

// defaults / knobs (use settings to override)
const CFG = {
  explodeSmoothing: settings.explodeSmoothing ?? 0.22,
  pinchImpulseStrength: settings.pinchImpulseStrength ?? 22.0,
  pinchHoldBleed: settings.pinchHoldBleed ?? 0.45,
  pinchImpulseDecay: settings.pinchImpulseDecay ?? 1.6,
  pinchLocalFalloff: settings.pinchLocalFalloff ?? 0.85,
  pinchMaxVel: settings.pinchMaxVel ?? 80,
  particleDamping: settings.particleDamping ?? 0.92,
  reformDelay: settings.reformDelay ?? 0.24,

  pinchFullShatter: settings.pinchFullShatter ?? true,
  shatterDistance: settings.shatterDistance ?? 200,
  shatterChaos: settings.shatterChaos ?? 1.0,
  shatterOpacityMin: settings.shatterOpacityMin ?? 0.08
};

const sm = {
  weights: { sphere: 1, cube: 0, torus: 0 },
  axis: new THREE.Vector3(0,1,0),
  R_inner: baseRadius*0.62,
  R_outer: baseRadius*1.00,
  inner: { torusR: 0, torusr: 0, cubeP: 2.0 },
  outer: { torusR: 0, torusr: 0, cubeP: 2.0 },
};

// temps
const M=new THREE.Matrix4(), P=new THREE.Vector3(), Q=new THREE.Quaternion();
const S_in=new THREE.Vector3(1,1,1), S_out=new THREE.Vector3(1,1,1);
const SC=new THREE.Vector3(1,1,1);
const D=new THREE.Vector3(), TO=new THREE.Vector3(), TAN=new THREE.Vector3();
const AX=new THREE.Vector3(0,1,0), B1=new THREE.Vector3(), B2=new THREE.Vector3();
const BL=new THREE.Vector3(), TOR=new THREE.Vector3(), CUB=new THREE.Vector3();
const TMP=new THREE.Vector3();

const clamp01 = (x)=>Math.min(1,Math.max(0,x));
const smooth = (cur, target, s)=>cur + (target-cur)*s;

// deterministic per-index random in [-1,1]
function rand1(i){ const v = Math.sin(i*12.9898 + 78.233)*43758.5453; return (v-Math.floor(v))*2-1; }
function rand3(i,out){ out.set(rand1(i), rand1(i+101), rand1(i+202)).normalize(); return out; }

// directions over sphere
function fibonacciSphereDirs(n){
  const a = new Float32Array(n*3);
  const g = Math.PI*(3-Math.sqrt(5));
  for(let i=0;i<n;i++){
    const y = 1 - (i/Math.max(1,n-1))*2;
    const r = Math.sqrt(Math.max(0,1-y*y));
    const t = g*i;
    const x = Math.cos(t)*r;
    const z = Math.sin(t)*r;
    const o=i*3; a[o]=x; a[o+1]=y; a[o+2]=z;
  }
  return a;
}
function orthoBasis(axis, outB1, outB2){
  const up = Math.abs(axis.y)>0.9 ? TAN.set(1,0,0) : TAN.set(0,1,0);
  outB1.copy(up).cross(axis).normalize();
  outB2.copy(axis).cross(outB1).normalize();
}
function torusFromDir(dir, axis, R, r, out, B1, B2){
  const x=dir.dot(B1), y=dir.dot(B2), z=dir.dot(axis);
  const theta=Math.atan2(y,x);
  const phi=Math.atan2(z, Math.sqrt(x*x+y*y));
  out.copy(B1).multiplyScalar(Math.cos(theta))
     .addScaledVector(B2, Math.sin(theta))
     .multiplyScalar(R + r*Math.cos(phi))
     .addScaledVector(axis, r*Math.sin(phi));
  return out;
}
function cubeProject(dir, R, out){
  const ax = Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z));
  out.set(dir.x/ax, dir.y/ax, dir.z/ax).multiplyScalar(R);
  return out;
}

/* =========================
   Points builder
   ========================= */

function makePointsLayer(count, isOuter){
  // geometry with dynamic 'position' (CPU fills each frame)
  const geo = new THREE.BufferGeometry();
  // aBase directions (unit sphere)
  const dirs = isOuter ? outerDirs : innerDirs;
  geo.setAttribute('aBase',  new THREE.BufferAttribute(dirs, 3, false));
  geo.setAttribute('aShell', new THREE.BufferAttribute(new Float32Array(count).fill(isOuter?1:0), 1));
  const seeds = new Float32Array(count); for (let i=0;i<count;i++) seeds[i] = i + Math.random()*123.456;
  geo.setAttribute('aSeed',  new THREE.BufferAttribute(seeds, 1));

  // dynamic positions we will write to
  const pos = new Float32Array(count*3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.attributes.position.setUsage(THREE.DynamicDrawUsage);

  // material with our shaders
  const mat = new THREE.ShaderMaterial({
    vertexShader:   particleVert,
    fragmentShader: particleFrag,
    transparent:    true,
    depthTest:      true,
    depthWrite:     false,
    blending:       THREE.AdditiveBlending,
    uniforms: {
      // audio/time
      uTime:{value:0}, uBass:{value:0}, uMid:{value:0}, uTreble:{value:0},
      uMusicReactivity:{value: settings.musicReactivity ?? 0.6},
      uTrebleSensitivity:{value: settings.trebleSensitivity ?? 1.0},
      uPulseIntensity:{value: settings.pulseIntensity ?? 1.0},

      // camera/point sizes
      uCamPos:{ value: new THREE.Vector3(0,0,28) },
      uPointMin:{ value: isOuter ? (settings.dotSizeOuter ?? 1.6) : (settings.dotSizeInner ?? 1.4) },
      uPointMax:{ value: isOuter ? (settings.dotSizeOuter ?? 1.6) : (settings.dotSizeInner ?? 1.4) },

      // color
      uColInner:{ value: new THREE.Vector3(...new THREE.Color(settings.colInner ?? 0x0AA1FF).toArray()) },
      uColOuter:{ value: new THREE.Vector3(...new THREE.Color(settings.colOuter ?? 0x00FFC8).toArray()) },
      uColRim:  { value: new THREE.Vector3(...new THREE.Color(settings.colRim   ?? 0xE8FFF9).toArray()) },
      uColorMix:{ value: settings.colorMix ?? 0.5 },
      uGlowGain:{ value: settings.glowGain ?? 1.0 },

      // light extra
      uRippleAmt:{ value: settings.rippleAmt ?? 0.25 },
    }
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  return { pts, geo };
}

/* =========================
   Public API
   ========================= */

export function initializeSphere(){
  if(innerMesh){ scene.remove(innerMesh); innerGeo.dispose(); innerMesh.material.dispose(); innerMesh=null; innerGeo=null; }
  if(outerMesh){ scene.remove(outerMesh); outerGeo.dispose(); outerMesh.material.dispose(); outerMesh=null; outerGeo=null; }

  baseRadius = settings.sphereRadius ?? 16;
  const inCount  = settings.innerCount ?? 1400;
  const outCount = settings.outerCount ?? 2400;

  innerDirs = fibonacciSphereDirs(inCount);
  outerDirs = fibonacciSphereDirs(outCount);

  const inner = makePointsLayer(inCount, false);
  innerMesh = inner.pts; innerGeo = inner.geo;

  const outer = makePointsLayer(outCount, true);
  outerMesh = outer.pts; outerGeo = outer.geo;

  sm.weights = { sphere:1, cube:0, torus:0 };
  sm.axis.set(0,1,0);
  sm.R_inner = baseRadius*0.62;
  sm.R_outer = baseRadius*1.00;
  sm.inner = { torusR: 0.8*sm.R_inner, torusr: 0.18*sm.R_inner, cubeP: 2.0 };
  sm.outer = { torusR: 1.0*sm.R_outer, torusr: 0.24*sm.R_outer, cubeP: 2.0 };
  followPos.set(0,0,0);

  explode = 0; explodeTarget = 0; impulse = 0; reformT = 0; pinchCenter.set(0,0,0);
}

// Public: from hands.js
export function pinchEvent(ev){
  const s = THREE.MathUtils.clamp(ev?.strength ?? 1, 0, 1);
  if (ev?.worldPos) pinchCenter.copy(ev.worldPos);

  if (ev?.phase === 'start'){
    impulse = Math.min(impulse + s * CFG.pinchImpulseStrength, CFG.pinchMaxVel);
    explodeTarget = CFG.pinchFullShatter ? 1 : Math.max(explodeTarget, s);
    reformT = CFG.reformDelay;
  } else if (ev?.phase === 'hold'){
    explodeTarget = CFG.pinchFullShatter ? 1 : Math.max(explodeTarget, s);
    impulse = Math.min(impulse + s * CFG.pinchHoldBleed, CFG.pinchMaxVel);
    reformT = CFG.reformDelay;
  } else if (ev?.phase === 'end'){
    explodeTarget = 0;
  }
}

/* =========================
   Frame update
   ========================= */

export function updateParticles({ time, frequencyData, hands, kickPulse, gesture, camera }){
  if(!innerMesh || !outerMesh) return;

  const morphS  = settings.morphSmoothing  ?? 0.22;
  const axisS   = settings.axisSmoothing   ?? 0.18;
  const radiusS = settings.radiusSmoothing ?? 0.20;

  // audio breathing
  const musicReactivity   = settings.musicReactivity   ?? 0.6;
  const trebleSensitivity = settings.trebleSensitivity ?? 1.0;
  const pulseIntensity    = settings.pulseIntensity    ?? 1.0;

  const bass = frequencyData?.bass ?? 0;
  const mid  = frequencyData?.mid ?? 0;
  const treb = frequencyData?.treble ?? 0;

  const innerBreath = (bass*0.10)*musicReactivity*pulseIntensity;
  const outerBreath = (mid*0.05 + treb*0.07*trebleSensitivity)*musicReactivity*pulseIntensity;
  const pump = 1.0 + (kickPulse ?? 0)*0.10;

  // depth zoom
  const h0 = hands && hands[0];
  const h1 = hands && hands[1];
  let depthZoom = 1.0;
  if (h0?.worldPos && Number.isFinite(h0.worldPos.z)){
    const z = h0.worldPos.z;
    const zNorm = THREE.MathUtils.clamp((-z)/30, -1, 1);
    depthZoom = 1.0 + (settings.depthZoomAmount ?? 0.6)*zNorm;
  }

  const Rin_t = baseRadius*0.62*(1+innerBreath)*pump*depthZoom;
  const Rou_t = baseRadius*1.00*(1+outerBreath)*pump*depthZoom;
  sm.R_inner = smooth(sm.R_inner, Rin_t, radiusS);
  sm.R_outer = smooth(sm.R_outer, Rou_t, radiusS);

  // pinch envelope
  if (reformT > 0) reformT -= (1/60);
  impulse = Math.max(0, impulse - CFG.pinchImpulseDecay * (1/60));
  impulse *= Math.pow(CFG.particleDamping, 1); // 60fps-ish
  const lerpK = 1 - Math.pow(1 - CFG.explodeSmoothing, 1);
  explode = THREE.MathUtils.lerp(explode, explodeTarget, lerpK);

  const shrink = 1 - (settings.pinchPointShrink ?? 0.5) * explode;

  // locality radius
  const radiusAvg = (sm.R_inner + sm.R_outer) * 0.5;
  const localR = radiusAvg * THREE.MathUtils.lerp(2.2, 0.55, CFG.pinchLocalFalloff);
  const radialGain = (settings.pinchExplodeRadial ?? 0.9);
  const velClamp = CFG.pinchMaxVel;

  // follow offset
  {
    const sXY = settings.followXYScale ?? 0.25;
    const sZ  = settings.followZScale  ?? 0.12;
    const boost    = settings.followTravelBoost ?? 3.0;
    const zBoost   = settings.followZBoost ?? (boost * 0.6);
    const smoothT  = settings.followSmoothing ?? 0.12;
    const homeT    = settings.followHomeSpring ?? 0.10;
    const maxOff   = settings.followMaxOffset ?? (baseRadius * 2.4);
    const flipX = settings.followInvertX ?? false;
    const flipY = settings.followInvertY ?? false;
    const flipZ = settings.followInvertZ ?? false;
    const ok = h0 && h0.worldPos && (h0.confidence === undefined || h0.confidence >= 0.5);

    let tx = ok ? ((flipX ? -1 : 1) * h0.worldPos.x) * sXY * boost : 0;
    let ty = ok ? ((flipY ? -1 : 1) * h0.worldPos.y) * sXY * boost : 0;
    let tz = ok ? ((flipZ ? -1 : 1) * h0.worldPos.z) * sZ  * zBoost : 0;

    tx = THREE.MathUtils.clamp(tx, -maxOff, maxOff);
    ty = THREE.MathUtils.clamp(ty, -maxOff, maxOff);
    tz = THREE.MathUtils.clamp(tz, -maxOff, maxOff);

    BL.set(tx, ty, tz);
    followPos.lerp(ok ? BL : new THREE.Vector3(0,0,0), ok ? smoothT : homeT);
  }

  // shape selection (disabled while fully shattered)
  const shapingBlocked = explode > 0.55 && CFG.pinchFullShatter;
  const fistThr = settings.fistThreshold ?? 0.40;
  const splitThr= settings.splitThreshold ?? 0.15;

  const sep = clamp01(gesture?.sep01 ?? 0);
  const twoHands = !!(gesture?.twoHands && h0?.worldPos && h1?.worldPos);
  const twoHandsActive = !shapingBlocked && twoHands && sep > splitThr;
  const fistActive = !shapingBlocked && (gesture?.fist ?? 0) > fistThr;

  let tgt = { sphere:0, cube:0, torus:0 };
  if (twoHandsActive) tgt.torus = 1;
  else if (fistActive) tgt.cube = 1;
  else tgt.sphere = 1;

  sm.weights.sphere = smooth(sm.weights.sphere, tgt.sphere, shapingBlocked ? 0.08 : morphS);
  sm.weights.cube   = smooth(sm.weights.cube,   tgt.cube,   shapingBlocked ? 0.08 : morphS);
  sm.weights.torus  = smooth(sm.weights.torus,  tgt.torus,  shapingBlocked ? 0.08 : morphS);

  // axis
  if (twoHands) AX.copy(h0.worldPos).sub(h1.worldPos);
  else if (h0?.worldPos) AX.copy(h0.worldPos);
  else AX.set(0,1,0);
  if (AX.lengthSq()<1e-6) AX.set(0,1,0);
  AX.normalize();
  sm.axis.lerp(AX, axisS).normalize();
  orthoBasis(sm.axis, B1, B2);

  // torus params
  const RmajIn_t  = THREE.MathUtils.lerp(settings.torusMajorMin ?? 0.55, settings.torusMajorMax ?? 1.15, sep)*sm.R_inner;
  const RmajOut_t = THREE.MathUtils.lerp(settings.torusMajorMin ?? 0.55, settings.torusMajorMax ?? 1.15, sep)*sm.R_outer;
  const rIn_t  = (settings.torusMinorInner ?? 0.16)*sm.R_inner*(0.8+0.4*sep);
  const rOut_t = (settings.torusMinorOuter ?? 0.22)*sm.R_outer*(0.8+0.4*sep);

  sm.inner.torusR = smooth(sm.inner.torusR, RmajIn_t, morphS);
  sm.outer.torusR = smooth(sm.outer.torusR, RmajOut_t, morphS);
  sm.inner.torusr = smooth(sm.inner.torusr, rIn_t, morphS);
  sm.outer.torusr = smooth(sm.outer.torusr, rOut_t, morphS);

  // layer opacity while shattered
  const op = 1 - explode * (1 - CFG.shatterOpacityMin);
  if (innerMesh.material.opacity !== op) innerMesh.material.opacity = op;
  if (outerMesh.material.opacity !== op) outerMesh.material.opacity = op;

  // ====== UPDATE GEOMETRY POSITIONS (CPU) ======
  updateLayerPositions(innerGeo, innerDirs, sm.R_inner, sm.inner, sm.weights, {
    hands, axis: sm.axis, B1, B2, followPos,
    time, kickPulse, explode, impulse, shrink,
    pinchCenter, localR, radialGain, velClamp
  });

  updateLayerPositions(outerGeo, outerDirs, sm.R_outer, sm.outer, sm.weights, {
    hands, axis: sm.axis, B1, B2, followPos,
    time, kickPulse, explode, impulse, shrink,
    pinchCenter, localR, radialGain, velClamp
  });

  // ====== UNIFORMS ======
  const layers = [innerMesh, outerMesh];
  for (const pts of layers){
    const u = pts.material.uniforms;
    u.uTime.value   = time ?? 0;
    u.uBass.value   = bass;
    u.uMid.value    = mid;
    u.uTreble.value = treb;
    u.uColorMix.value = settings.colorMix ?? u.uColorMix.value;
    u.uGlowGain.value = settings.glowGain ?? u.uGlowGain.value;

    if (camera) u.uCamPos.value.copy(camera.position);
    else if (scene && scene.children.length) { /* leave default */ }

    // dot sizes (keep equal for crisp discs)
    if (pts === outerMesh){
      const s = settings.dotSizeOuter ?? 1.6; u.uPointMin.value = s; u.uPointMax.value = s;
    } else {
      const s = settings.dotSizeInner ?? 1.4; u.uPointMin.value = s; u.uPointMax.value = s;
    }
  }
}

/* =========================
   Internals: write positions
   ========================= */

function updateLayerPositions(geo, dirs, shellR, params, weights, ctx){
  const count = dirs.length/3;
  const arr = geo.attributes.position.array;

  // Hand forces
  const baseStrength = settings.handStrength ?? 2.0;
  const forceMul = THREE.MathUtils.lerp(1.0, (settings.forceWhileShaping ?? 0.35), 1 - weights.sphere);
  const explodeForceDamp = THREE.MathUtils.lerp(1.0, 0.6, ctx.explode);
  const handStrength = baseStrength * forceMul * explodeForceDamp;

  const handReach = settings.handReach ?? 0.035;
  const fieldPower= settings.fieldPower ?? 2.4;
  const swirlAmt  = settings.swirlAmount ?? 0.20;
  const velStrength = settings.velStrength ?? 5.0;

  const h0 = ctx.hands && ctx.hands[0];
  const h1 = ctx.hands && ctx.hands[1];

  for(let i=0;i<count;i++){
    const o=i*3;
    D.set(dirs[o],dirs[o+1],dirs[o+2]).normalize();

    // base placement (shape)
    if (weights.sphere >= weights.cube && weights.sphere >= weights.torus){
      P.copy(D).multiplyScalar(shellR);
    } else if (weights.cube >= weights.torus){
      cubeProject(D, shellR, CUB);
      P.copy(CUB);
    } else {
      torusFromDir(D, ctx.axis, params.torusR, params.torusr, TOR, ctx.B1, ctx.B2);
      P.copy(TOR);
    }

    // global follow
    P.add(ctx.followPos);

    // shatter vector calculation
    TO.copy(P).sub(ctx.pinchCenter);
    const dist = Math.max(1e-4, TO.length());
    TO.multiplyScalar(1.0/dist); // outward dir from pinch
    const fall = (() => {
      const x = THREE.MathUtils.clamp(1.0 - dist / ctx.localR, 0.0, 1.0);
      return x*x*(3.0-2.0*x);
    })();

    // outward blast + radial bias
    const outward = Math.min(ctx.velClamp, ctx.impulse) * fall
                  + (ctx.radialGain * ctx.explode) * (0.28 * shellR) * (0.5 + 0.5*fall);

    // big chaos offset (index-seeded)
    rand3(i, TMP);
    const chaos = CFG.shatterChaos * Math.pow(ctx.explode, 1.2) * CFG.shatterDistance * (0.35 + 0.65*fall);

    // shatter target position
    const shatterTarget = TMP.multiplyScalar(chaos).addScaledVector(TO, outward).add(ctx.pinchCenter);

    // lerp from shape → shatter
    const mix = Math.pow(ctx.explode, 1.15);
    P.lerp(shatterTarget, mix);

    // time-varying jitter (audio-reactive)
    const j = (settings.pinchExplodeJitter ?? 0.35) * (0.5 + 0.5 * (ctx.kickPulse ?? 0)) * (0.4 + 0.6*fall) * (0.35 + 0.65*ctx.explode);
    if (j > 1e-6){
      const t = ctx.time ?? 0;
      TMP.set(
        Math.sin(i*0.71 + t*1.7),
        Math.sin(i*1.31 + t*1.9),
        Math.sin(i*2.11 + t*1.5)
      ).multiplyScalar(j);
      P.add(TMP);
    }

    // hand forces (after shatter target so hands can still “touch” debris)
    if (h0 || h1){
      for (let k=0;k<2;k++){
        const h = k===0?h0:h1;
        if (!h?.worldPos) continue;
        const toH = TMP.copy(P).sub(h.worldPos);
        const d = Math.max(1e-4, toH.length());
        const dir = toH.multiplyScalar(1.0/d);
        const f   = Math.pow(1.0/(1.0 + d*handReach), fieldPower);
        P.addScaledVector(dir, handStrength*0.30*f);
        TAN.copy(dir).cross(new THREE.Vector3(0,1,0)).normalize();
        P.addScaledVector(TAN, handStrength*swirlAmt*0.35*f);
        const vmag = h.velocity ? Math.min(140, Math.hypot(h.velocity.x,h.velocity.y,h.velocity.z))/140 : 0;
        P.addScaledVector(ctx.axis, velStrength*vmag*0.40*f);
      }
    }

    // write to buffer
    arr[o+0] = P.x;
    arr[o+1] = P.y;
    arr[o+2] = P.z;
  }

  geo.attributes.position.needsUpdate = true;
}
