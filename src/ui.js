// src/ui.js
// UI: Start overlay (user gesture), audio player + file input, status labels, webcam preview.

function el(tag, attrs = {}, parent = document.body) {
  const n = document.createElement(tag);
  Object.assign(n, attrs);
  parent.appendChild(n);
  return n;
}

// Container
const hud = el('div', { id: 'hud' });
hud.style.position = 'fixed';
hud.style.left = '10px';
hud.style.bottom = '10px';
hud.style.display = 'flex';
hud.style.flexDirection = 'column';
hud.style.gap = '8px';
hud.style.zIndex = '9999';
hud.style.fontFamily = 'system-ui, Arial, sans-serif';
hud.style.pointerEvents = 'none';

// Audio row
const audioRow = el('div', {}, hud);
audioRow.style.display = 'flex';
audioRow.style.gap = '8px';
audioRow.style.pointerEvents = 'auto';

export const audioPlayer = el('audio', { id: 'audio-player', controls: true }, audioRow);
audioPlayer.style.width = '320px';

export const fileInput = el('input', { id: 'file-input', type: 'file' }, audioRow);
fileInput.accept = 'audio/*';

// Status row
const statusCol = el('div', {}, hud);
statusCol.style.display = 'flex';
statusCol.style.flexDirection = 'column';
statusCol.style.gap = '6px';
statusCol.style.pointerEvents = 'auto';

export const audioStatus = el('div', { id: 'audio-status' }, statusCol);
audioStatus.textContent = 'Audio: idle (techno loop will start if no track is playing)';
audioStatus.style.padding = '6px 8px';
audioStatus.style.borderRadius = '6px';
audioStatus.style.background = 'rgba(0,0,0,0.45)';
audioStatus.style.color = '#fff';
audioStatus.style.fontSize = '12px';

export const handStatus = el('div', { id: 'hand-status' }, statusCol);
handStatus.textContent = 'Camera: waiting for permission…';
handStatus.style.padding = '6px 8px';
handStatus.style.borderRadius = '6px';
handStatus.style.background = 'rgba(0,0,0,0.45)';
handStatus.style.color = '#fff';
handStatus.style.fontSize = '12px';

// Webcam preview (small)
export const webcamCanvas = el('canvas', { id: 'webcam-canvas' });
webcamCanvas.width = 320;
webcamCanvas.height = 240;
webcamCanvas.style.position = 'fixed';
webcamCanvas.style.right = '10px';
webcamCanvas.style.bottom = '10px';
webcamCanvas.style.width = '320px';
webcamCanvas.style.height = '240px';
webcamCanvas.style.border = '2px solid white';
webcamCanvas.style.borderRadius = '8px';
webcamCanvas.style.zIndex = '9999';
webcamCanvas.style.background = '#000';
webcamCanvas.style.pointerEvents = 'none';

// START overlay (blocks until user clicks)
const overlay = el('div', { id: 'start-overlay' });
overlay.style.position = 'fixed';
overlay.style.inset = '0';
overlay.style.background = 'rgba(0,0,0,0.8)';
overlay.style.display = 'flex';
overlay.style.alignItems = 'center';
overlay.style.justifyContent = 'center';
overlay.style.zIndex = '10000';

const startBtn = el('button', { id: 'start-btn' }, overlay);
startBtn.textContent = 'Start (enable camera + audio)';
startBtn.style.padding = '14px 22px';
startBtn.style.fontSize = '16px';
startBtn.style.borderRadius = '10px';
startBtn.style.cursor = 'pointer';

// Remove audio UI (file input + audio player) since we no longer need audio upload/player
if (typeof audioRow !== 'undefined' && audioRow.parentNode) {
  audioRow.remove();
}

// Clear any audio state if the elements exist
if (typeof audioPlayer !== 'undefined') {
  try { audioPlayer.pause(); } catch (e) {}
  try { audioPlayer.src = ''; } catch (e) {}
}
if (typeof fileInput !== 'undefined') {
  try { fileInput.value = ''; } catch (e) {}
}

// Update status label to reflect that audio features have been removed
audioStatus.textContent = 'Audio: basic techno loop';

// Export the overlay handle used by main.js
export const startOverlay = {
  root: overlay,
  button: startBtn,
};

// (No default export)
