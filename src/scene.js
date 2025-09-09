// src/scene.js
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RGBShiftShader } from 'three/examples/jsm/shaders/RGBShiftShader.js';
import { GlitchPass } from 'three/examples/jsm/postprocessing/GlitchPass.js';

// ————————————————— Scene / Renderer / Camera —————————————————
export const scene = new THREE.Scene();

export const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.debug.checkShaderErrors = true;
renderer.shadowMap.enabled = false;
renderer.autoClear = false;
renderer.setClearColor(0x0A0713, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

export const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 0, 95);

// ————————————————— Post —————————————————
export const composer = new EffectComposer(renderer);

export const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

export const afterimagePass = new AfterimagePass(0.88);
composer.addPass(afterimagePass);

export const bokehPass = new BokehPass(scene, camera, { focus: 95.0, aperture: 0.00022, maxblur: 0.012 });
composer.addPass(bokehPass);

// Rim boost (keeps center dark, edges bright)
const RimBoostShader = {
  uniforms: {
    tDiffuse:    { value: null },
    center:      { value: new THREE.Vector2(0.5, 0.5) },
    rimStart:    { value: 0.36 },
    rimEnd:      { value: 0.98 },
    rimGain:     { value: 1.25 },
    innerDarken: { value: 0.25 },
    gamma:       { value: 1.00 }
  },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: `
    uniform sampler2D tDiffuse;uniform vec2 center;uniform float rimStart,rimEnd,rimGain,innerDarken,gamma;
    varying vec2 vUv;
    void main(){
      vec3 col=texture2D(tDiffuse,vUv).rgb;
      float r=distance(vUv,center);
      float rim=smoothstep(rimStart,rimEnd,r); rim=pow(rim,gamma);
      col*=mix(1.0-innerDarken,1.0,rim);
      col*=(1.0+rim*rimGain);
      gl_FragColor=vec4(col,1.0);
    }`
};
export const rimPass = new ShaderPass(RimBoostShader);
composer.addPass(rimPass);

export const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.48, 0.88);
composer.addPass(bloomPass);

export const rgbShiftPass = new ShaderPass(RGBShiftShader);
rgbShiftPass.uniforms.amount.value = 0.0008;
composer.addPass(rgbShiftPass);

const GradeVignetteShader = {
  uniforms: {
    tDiffuse:   { value: null },
    exposure:   { value: 0.90 },
    contrast:   { value: 1.10 },
    saturation: { value: 0.96 },
    tint:       { value: new THREE.Vector3(0.98, 1.00, 1.05) },
    vigStrength:{ value: 0.42 },
    vigCurve:   { value: 1.18 },
  },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: `
    uniform sampler2D tDiffuse;uniform float exposure,contrast,saturation,vigStrength,vigCurve;uniform vec3 tint;
    varying vec2 vUv;float luma(vec3 c){return dot(c,vec3(0.2126,0.7152,0.0722));}
    void main(){
      vec3 col=texture2D(tDiffuse,vUv).rgb;
      col*=exposure; col=(col-0.5)*contrast+0.5;
      float Y=luma(col); col=mix(vec3(Y),col,saturation);
      col*=tint; float d=distance(vUv,vec2(0.5)); float v=pow(smoothstep(0.0,1.0,1.0-d),vigCurve);
      col*=mix(1.0-vigStrength,1.0,v);
      gl_FragColor=vec4(col,1.0);
    }`
};
export const gradePass = new ShaderPass(GradeVignetteShader);
composer.addPass(gradePass);

export const glitchPass = new GlitchPass();
glitchPass.enabled = false;
composer.addPass(glitchPass);

// ————————————————— Resize + Render —————————————————
export function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); composer.setSize(w, h); bloomPass.setSize(w, h);
}
window.addEventListener('resize', onResize);

export function render() {
  const t = performance.now() * 0.001;
  rgbShiftPass.uniforms.amount.value = 0.0007 + 0.0003 * Math.sin(t * 0.35);
  renderer.clear();
  composer.render();
}

// ————————————————— Small helpers (optional) —————————————————
export function setRim({ rimStart, rimEnd, rimGain, innerDarken, gamma, center } = {}) {
  const u = rimPass.uniforms;
  if (rimStart    !== undefined) u.rimStart.value    = rimStart;
  if (rimEnd      !== undefined) u.rimEnd.value      = rimEnd;
  if (rimGain     !== undefined) u.rimGain.value     = rimGain;
  if (innerDarken !== undefined) u.innerDarken.value = innerDarken;
  if (gamma       !== undefined) u.gamma.value       = gamma;
  if (center      !== undefined) u.center.value.copy(center);
}
export function setBloom({ strength, radius, threshold } = {}) {
  if (strength  !== undefined) bloomPass.strength  = strength;
  if (radius    !== undefined) bloomPass.radius    = radius;
  if (threshold !== undefined) bloomPass.threshold = threshold;
}
