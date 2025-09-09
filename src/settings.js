export const settings = {
  /* ---- visuals / point sphere ---- */
  sphereRadius: 30,
  innerCount: 10000,
  outerCount: 0,

  // tiny “pixel” dots (world units)
  dotSizeInner: 0.1,
  dotSizeOuter: 0.1,

  // subtle audio response
  musicReactivity: 0.55,
  trebleSensitivity: 1.0,
  pulseIntensity: 1.0,

  // hand field (avoidance/swirl/velocity push)
  handStrength: 2.0,
  handReach: 0.035,
  fieldPower: 2.4,
  swirlAmount: 0.20,
  velStrength: 5.0,

  /* ---- gesture → shape morph ---- */
  // Open hand → “cube” power (superquadric)
  cubePowerMin: 2.0,      // ~sphere
  cubePowerMax: 22.0,     // boxy

  // Two hands → torus (fractions of current shell radius)
  torusMajorMin: 0.55,
  torusMajorMax: 1.15,
  torusMinorInner: 0.16,
  torusMinorOuter: 0.22,

  // Fist → capsule (fractions of current shell radius)
  capHalfLenInner: 0.45,
  capHalfLenOuter: 0.70,
  capRadiusInner: 0.30,
  capRadiusOuter: 0.48,

  /* ---- hand tracking / gesture thresholds ---- */
  fistThreshold: 0.40,     // raise to 0.5 if it's too sensitive
  openThreshold: 0.55,
  splitThreshold: 0.15,
  gestureSmoothing: 0.25,
  /* ---- audio engine + FX ---- */
  bpm: 126,
  swing: 0.06,
  technoGain: 0.9,
  autoTechnoWhenNoTrack: true,
  engineThroughFX: false,   // engine stays DRY like your original

  masterGain: 1.0,
  masterLPFMin: 180,
  masterLPFMax: 18000,
  delayMinMS: 90,
  delayMaxMS: 220,
  delayFeedback: 0.25,
  pumpAmount: 0.15,
  bassBoost: 0,
  trebleBoost: 0,

  followEnabled: true,
  followXYScale: 1,
  followZScale: 1,
  followSmoothing: 0.12,
  followHomeSpring: 0.10,
  depthZoomAmount: 2,      // ±60% size change from depth
  cubePowerMin: 2.0,
  cubePowerMax: 22.0,
  torusMajorMin: 0.55,
  torusMajorMax: 1.15,
  torusMinorInner: 0.16,
  torusMinorOuter: 0.22,
  capHalfLenInner: 0.45,
  capRadiusInner: 0.30,
  capHalfLenOuter: 0.70,
  capRadiusOuter: 0.48,

  handDetectionThreshold: 0.65,
  gestureSmoothing: 0.25,
  pinchThreshold: 0.55,

  followInvertX: false,
  followInvertY: false,
  followInvertZ: false,

  // Pinch macro strength
  pinchCutDepth: 0.9,  // 0..0.98  (how dark the LPF goes)
  pinchDrive: 0.9,     // 0..1     (distortion strength)

  // Pinch “disintegrate” visual
  explodeSmoothing: 0.22,     // how fast the effect engages/releases
  pinchExplodeRadial: 0.9,    // up to 0.9 * shell radius pushed outward
  pinchExplodeJitter: 0.35,   // lateral jitter as fraction of radius
  pinchPointShrink: 0.5,      // dots shrink to 50% at full pinch

  // If your preview is mirrored and the motion feels flipped:
  mirrorPreview: true,
  invertDepth: false,
  pinchOnThreshold: 0.78,
  pinchOffThreshold: 0.62,
  pinchSmoothing: 0.25,    
  pinchFullShatter: true,
  pinchImpulseStrength: 26.0,
  pinchHoldBleed: 0.5,
  pinchImpulseDecay: 1.3,
  pinchLocalFalloff: 0.8,
  pinchMaxVel: 110,
  particleDamping: 0.90,
  reformDelay: 0.30,

  pinchExplodeRadial: 1.2,
  pinchExplodeJitter: 0.55,
  pinchPointShrink: 0.7,

  shatterDistance: 260,
  shatterChaos: 1.15,
  shatterOpacityMin: 0.05,
  duoRadiusScale:   0.80, // 0.7–0.9 → how small each half-sphere is
  duoSeparationMul: 1.25, // 1.0–1.6 → how far centers separate
  
};
