import { settings } from './settings.js';

export function createTechnoEngine(ctx) {
  /* ------------------------------------------------------------------ */
  /* Output bus                                                         */
  /* ------------------------------------------------------------------ */
  const engineBus = ctx.createGain();
  engineBus.gain.value = (settings?.technoGain ?? 0.9);

  /* ------------------------------------------------------------------ */
  /* Music bus (tout sauf la kick) + ducking (sidechain) + tiny reverb  */
  /* ------------------------------------------------------------------ */
  const musicBus = ctx.createGain();      // contenu ducké
  const duckGain = ctx.createGain();      // piloté par la kick
  duckGain.gain.value = 1.0;
  musicBus.connect(duckGain).connect(engineBus);

  // petite reverb (courte, légère)
  const reverb = ctx.createConvolver();
  (function makeTinyIR() {
    const len = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    reverb.buffer = buf;
  })();
  const revSend = ctx.createGain();
  revSend.gain.value = 0.12;
  revSend.connect(reverb).connect(musicBus);

  /* ------------------------------------------------------------------ */
  /* Helpers: jitter & scale quantize                                   */
  /* ------------------------------------------------------------------ */
  function jitterTime(t, amplitude = 0.004) { return t + (Math.random() * 2 - 1) * amplitude; }
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10] };
  function quantizeMidi(m, scale = SCALES.minor, root = 36) {
    const off = m - root;
    const oct = Math.floor(off / 12);
    const deg = ((off % 12) + 12) % 12;
    let nearest = scale[0], best = 99;
    for (const s of scale) { const diff = Math.abs(s - deg); if (diff < best) { best = diff; nearest = s; } }
    return root + oct * 12 + nearest;
  }

  /* ------------------------------------------------------------------ */
  /* Engine tempo & swing                                               */
  /* ------------------------------------------------------------------ */
  let bpm = settings?.bpm ?? 126;
  let swing = settings?.swing ?? 0.06;
  let onKick = () => {};

  /* ------------------------------------------------------------------ */
  /* CALM switch                                                        */
  /* ------------------------------------------------------------------ */
  let calmMode = true; // default calm
  function setCalmMode(v) { calmMode = !!v; }

  /* ------------------------------------------------------------------ */
  /* Kick                                                               */
  /* ------------------------------------------------------------------ */
  function triggerKick(time) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(100, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);

    // softer peak in calm mode
    const kickPeak = calmMode ? 0.6 : 0.9;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(kickPeak, time + (calmMode ? 0.004 : 0.002));
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.28);

    // much softer click in calm
    click.type = 'square';
    clickGain.gain.setValueAtTime(calmMode ? 0.05 : 0.2, time);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);

    // la kick ne passe pas par le ducking
    click.connect(clickGain).connect(engineBus);
    osc.connect(gain).connect(engineBus);

    osc.start(time);
    click.start(time);
    osc.stop(time + 0.35);
    click.stop(time + 0.03);

    // sidechain (duck) : quasi inaudible en calm
    const duckMin = calmMode ? 0.92
      : Math.max(0.2, Math.min(0.7, 0.55 - (settings?.pumpAmount ?? 0.15)));
    duckGain.gain.cancelScheduledValues(time);
    duckGain.gain.setValueAtTime(duckMin, time);
    duckGain.gain.linearRampToValueAtTime(1.0, time + (calmMode ? 0.18 : 0.22));

    onKick && onKick(time);
  }

  /* ------------------------------------------------------------------ */
  /* Hihat                                                              */
  /* ------------------------------------------------------------------ */
  function triggerHat(time, open = false, density = 1.0) {
    const bufferSize = 2 * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource(); noise.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = calmMode ? 6000 : 8000;

    const gain = ctx.createGain();
    const dur = open ? (calmMode ? 0.12 : 0.15) : (calmMode ? 0.035 : 0.04);
    const amp = (open ? (calmMode ? 0.12 : 0.16) : (calmMode ? 0.08 : 0.11)) * density;

    gain.gain.setValueAtTime(amp, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    noise.connect(hp).connect(gain);
    gain.connect(musicBus);
    gain.connect(revSend);

    noise.start(time);
    noise.stop(time + dur + 0.02);
  }

  /* ------------------------------------------------------------------ */
  /* Clap                                                               */
  /* ------------------------------------------------------------------ */
  function triggerClap(time) {
    const bursts = [0.0, 0.012, 0.024, 0.038];
    bursts.forEach((off, i) => {
      const b = ctx.createBuffer(1, 0.05 * ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let n = 0; n < d.length; n++) d[n] = (Math.random() * 2 - 1) * (1 - n / d.length);

      const src = ctx.createBufferSource(); src.buffer = b;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 0.6;

      const g = ctx.createGain();
      const base = 0.22 / (i + 1);
      const level = base * (params.clapLevel ?? 1.0) * (calmMode ? 0.7 : 1.0);

      g.gain.setValueAtTime(level, time + off);
      g.gain.exponentialRampToValueAtTime(0.0001, time + off + 0.12);

      src.connect(bp).connect(g);
      g.connect(musicBus);
      g.connect(revSend);

      src.start(time + off);
      src.stop(time + off + 0.14);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Bass synth                                                          */
  /* ------------------------------------------------------------------ */
  const bass = (() => {
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const g = ctx.createGain(); g.gain.value = 0.0;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 200;
    o.connect(g).connect(f);
    f.connect(musicBus);
    o.start();
    return { o, g, f };
  })();

  function noteToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function triggerBass(time, midi, len = 0.23, vel = 0.18, filt = 300) {
    const freq = noteToHz(midi);
    bass.o.frequency.setValueAtTime(freq, time);
    bass.f.frequency.setValueAtTime(filt, time);
    bass.g.gain.cancelScheduledValues(time);
    bass.g.gain.setValueAtTime(0.0001, time);
    bass.g.gain.exponentialRampToValueAtTime(vel, time + 0.01);
    bass.g.gain.exponentialRampToValueAtTime(0.0001, time + len);
  }

  /* ------------------------------------------------------------------ */
  /* Chords (stab)                                                       */
  /* ------------------------------------------------------------------ */
  const chords = (() => {
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth';
    const mix = ctx.createGain(); mix.gain.value = 0.0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 0.7;
    o1.connect(mix); o2.connect(mix); mix.connect(lp);
    lp.connect(musicBus); lp.connect(revSend);
    o1.start(); o2.start();
    return { o1, o2, mix, lp };
  })();

  function chordToMidis(rootMidi, type = 'minor') {
    return (type === 'minor') ? [rootMidi, rootMidi + 3, rootMidi + 7] : [rootMidi, rootMidi + 4, rootMidi + 7];
  }
  function setChord(time, rootMidi, dur = 0.18, vel = 0.18) {
    const notes = chordToMidis(rootMidi, 'minor');
    chords.o1.frequency.setValueAtTime(noteToHz(notes[0]), time);
    chords.o2.frequency.setValueAtTime(noteToHz(notes[2]), time);

    chords.lp.frequency.cancelScheduledValues(time);
    chords.lp.frequency.setValueAtTime(900, time);
    chords.lp.frequency.linearRampToValueAtTime(1800, time + dur);

    chords.mix.gain.cancelScheduledValues(time);
    chords.mix.gain.setValueAtTime(0.0001, time);
    chords.mix.gain.exponentialRampToValueAtTime(vel, time + 0.01);
    chords.mix.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  }

  /* ------------------------------------------------------------------ */
  /* Step sequencer                                                      */
  /* ------------------------------------------------------------------ */
  const steps = 16;
  let stepIndex = 0;
  let nextNoteTime = 0;
  let isRunning = false;
  let lookahead = 0.025;
  let scheduleAhead = 0.12;
  let timer = null;

  const kickPat = [1,0,0,0,  1,0,0,0,  1,0,0,0,  1,0,0,0];
  const clapPat = [0,0,0,0,  1,0,0,0,  0,0,0,0,  1,0,0,0];
  const hatPat  = [0,1,0,1,  0,1,0,1,  0,1,0,1,  0,1,0,1];

  const params = {
    hatDensity: 1.0,
    openHatChance: 0.15,
    clapLevel: 1.0,
    bassCutoff: 380,
    bassVel: 0.22,
  };

  // Presets
  const PRESETS = {
    DeepChill: {
      hatDensity: 0.55,
      openHatChance: 0.06,
      clapLevel: 0.65,
      bassCutoff: 320,
      bassVel: 0.14,
      bassPat: [36,0,43,0, 36,0,41,0, 36,0,43,0, 36,0,41,0],
      chordRoots: [36,36,36,36, 33,33,33,33, 31,31,31,31, 33,33,33,33],
      chordEvery: 4,
      jitterMs: 0.004,
    },
    FrenchTouch1998: {
      hatDensity: 0.95,
      openHatChance: 0.10,
      clapLevel: 1.2,
      bassCutoff: 520,
      bassVel: 0.24,
      bassPat: [36,36,43,36,  36,36,43,36,  36,36,43,36,  36,36,43,36],
      chordRoots: [36,36,36,36,  36,36,36,36,  34,34,34,34,  36,36,36,36],
      chordEvery: 4,
      jitterMs: 0.003,
    },
    LoFiHouse: {
      hatDensity: 0.8,
      openHatChance: 0.2,
      clapLevel: 1.0,
      bassCutoff: 420,
      bassVel: 0.20,
      bassPat: [36,0,43,0,  36,0,41,0,  36,0,43,0,  36,0,41,0],
      chordRoots: [36,36,36,36,  35,35,35,35,  33,33,33,33,  36,36,36,36],
      chordEvery: 2,
      jitterMs: 0.006,
    },
    PeakTimeTechno: {
      hatDensity: 1.0,
      openHatChance: 0.08,
      clapLevel: 1.3,
      bassCutoff: 680,
      bassVel: 0.28,
      bassPat: [36,36,43,36,  38,36,45,36,  41,36,43,36,  38,36,45,36],
      chordRoots: [36,36,36,36,  38,38,38,38,  41,41,41,41,  38,38,38,38],
      chordEvery: 2,
      jitterMs: 0.002,
    },
  };
  let activePreset = 'DeepChill';

  function secondsPerStep() {
    const spb = 60 / bpm;
    const sp16 = spb / 4;
    const isSwingStep = (stepIndex % 2) === 1;
    return isSwingStep ? sp16 * (1 + swing) : sp16 * (1 - swing);
  }

  function scheduleStep(time, idx) {
    const P = PRESETS[activePreset] || PRESETS.DeepChill;
    const t = jitterTime(time, P.jitterMs ?? 0.004);

    if (kickPat[idx]) triggerKick(t);

    if (clapPat[idx]) {
      const old = revSend.gain.value;
      revSend.gain.setValueAtTime(Math.min(0.22, old + 0.03), t);
      triggerClap(t);
    }

    if (hatPat[idx]) {
      const open = Math.random() < params.openHatChance;
      triggerHat(t, open, params.hatDensity);
    }

    const midi = (P.bassPat ?? [])[idx];
    if (midi) {
      const qm = quantizeMidi(midi, SCALES.minor, 36);
      triggerBass(t, qm, calmMode ? 0.22 : 0.22, params.bassVel, params.bassCutoff);
    }

    if ((idx % P.chordEvery) === 0) {
      const root = (P.chordRoots ?? [])[idx] ?? 36;
      setChord(t, root, calmMode ? 0.16 : 0.16, calmMode ? 0.16 : 0.18);
    }
  }

  function scheduler() {
    const now = ctx.currentTime;
    while (nextNoteTime < now + scheduleAhead) {
      scheduleStep(nextNoteTime, stepIndex);
      const dur = secondsPerStep();
      nextNoteTime += dur;
      stepIndex = (stepIndex + 1) % steps;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Control API                                                         */
  /* ------------------------------------------------------------------ */
  function start() {
    if (isRunning) return;
    stepIndex = 0;
    nextNoteTime = ctx.currentTime + 0.05;

    // appliquer preset actif
    const P = PRESETS[activePreset] || PRESETS.DeepChill;
    setParams({
      hatDensity: P.hatDensity,
      openHatChance: P.openHatChance,
      clapLevel: P.clapLevel,
      bassCutoff: P.bassCutoff,
      bassVel: P.bassVel,
    });

    isRunning = true;
    timer = setInterval(scheduler, lookahead * 1000);
  }

  function stop() {
    isRunning = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function setBPM(next) { bpm = Math.max(60, Math.min(200, next)); }
  function setSwing(v) { swing = Math.max(0, Math.min(0.2, v)); }

  function setParams(next) {
    if (next.hatDensity !== undefined) params.hatDensity = Math.max(0, Math.min(1, next.hatDensity));
    if (next.openHatChance !== undefined) params.openHatChance = Math.max(0, Math.min(1, next.openHatChance));
    if (next.clapLevel !== undefined) params.clapLevel = Math.max(0, Math.min(1.5, next.clapLevel));
    if (next.bassCutoff !== undefined) params.bassCutoff = Math.max(120, Math.min(3000, next.bassCutoff));
    if (next.bassVel !== undefined) params.bassVel = Math.max(0.05, Math.min(0.6, next.bassVel));
  }

  function setKickCallback(fn) { onKick = fn; }

  function setPreset(name) {
    if (!PRESETS[name]) return;
    activePreset = name;
    const P = PRESETS[activePreset];
    setParams({
      hatDensity: P.hatDensity,
      openHatChance: P.openHatChance,
      clapLevel: P.clapLevel,
      bassCutoff: P.bassCutoff,
      bassVel: P.bassVel,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Expose                                                             */
  /* ------------------------------------------------------------------ */
  return {
    bus: engineBus,
    start,
    stop,
    setBPM,
    setSwing,
    setParams,
    setKickCallback,
    setPreset,
    setCalmMode, // NEW
  };
}
