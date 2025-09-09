// src/main.js
import { startOverlay } from './ui.js';
import {
  initAudioAnalysis, analyzeAudio, frequencyData,
  routeHandsToAudio, kickPulse
} from './audio.js';
import { initHandTracking, getHandInfluences, getGestureSummary } from './hands.js';
import { composer, onResize } from './scene.js';
import { initializeSphere, updateParticles } from './particles.js';

window.addEventListener('resize', onResize);

const startAll = async () => {
  startOverlay.button.disabled = true;
  try {
    await initAudioAnalysis();
    await initHandTracking();
    initializeSphere();
    startOverlay.root.remove();
    loop();
  } catch (e) {
    console.error(e);
    startOverlay.button.disabled = false;
    startOverlay.button.textContent = 'Failed — Click to retry (allow camera/audio)';
  }
};
startOverlay.button.addEventListener('pointerdown', startAll, { once: true });

let last = performance.now();
function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  analyzeAudio();

  const hands = getHandInfluences();     // sorted by confidence
  const dominant = hands[0];
  const gesture = getGestureSummary();   // <-- get it first
  routeHandsToAudio(dominant, gesture);  // <-- then use it

  updateParticles({
    time: now / 1000,
    frequencyData,
    hands,
    kickPulse,
    gesture
  });

  composer.render();
  requestAnimationFrame(loop);
}
