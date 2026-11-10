import { FogPass, type FogParams, type FrameState } from './fog';
import { halton, invert, lookAt, multiply, normalize, perspective, type Mat4, type Vec3 } from './math';

const canvas = document.querySelector<HTMLCanvasElement>('#view');
const hud = document.querySelector<HTMLOutputElement>('#hud');
if (!canvas) throw new Error('missing #view canvas');

const gl = canvas.getContext('webgl2', {
  alpha: false,
  antialias: false,
  powerPreference: 'high-performance',
});
if (!gl) throw new Error('this demo needs WebGL2');

const params: FogParams = {
  density: 0.055,
  scatter: 0.55,
  marchSteps: 40,
  temporal: true,
  blend: 0.9,
};
const fog = new FogPass(gl, params);

const sunDir = normalize([0.42, 0.72, 0.31]);
const target: Vec3 = [0, 2.5, 0];
const projection: Mat4 = new Float32Array(16);
const view: Mat4 = new Float32Array(16);
const viewProj: Mat4 = new Float32Array(16);
const invViewProj: Mat4 = new Float32Array(16);
let prevViewProj: Mat4 | null = null;

let yaw = 0.55;
let pitch = 0.28;
let dragging = false;
let lastX = 0;
let lastY = 0;
let frame = 0;

canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointerup', () => {
  dragging = false;
});
canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  yaw -= (event.clientX - lastX) * 0.005;
  pitch = Math.min(0.85, Math.max(0.04, pitch + (event.clientY - lastY) * 0.004));
  lastX = event.clientX;
  lastY = event.clientY;
});
window.addEventListener('keydown', (event) => {
  if (event.key === 't') params.temporal = !params.temporal;
});

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  fog.setSize(w, h);
  prevViewProj = null;
}

const start = performance.now();
let lastHudUpdate = 0;

function tick(now: number): void {
  resize();
  const time = (now - start) / 1000;

  const radius = 24;
  const eye: Vec3 = [
    Math.sin(yaw) * Math.cos(pitch) * radius,
    3 + Math.sin(pitch) * radius,
    Math.cos(yaw) * Math.cos(pitch) * radius,
  ];
  lookAt(view, eye, target, [0, 1, 0]);
  perspective(projection, (52 * Math.PI) / 180, canvas.width / canvas.height, 0.25, 400);

  // Sub-pixel jitter, Halton(2,3): the resolve integrates over the sequence.
  const jx = halton((frame % 16) + 1, 2) - 0.5;
  const jy = halton((frame % 16) + 1, 3) - 0.5;
  projection[8] += (jx * 2) / canvas.width;
  projection[9] += (jy * 2) / canvas.height;

  multiply(viewProj, projection, view);
  invert(invViewProj, viewProj);

  const state: FrameState = {
    viewProj,
    prevViewProj: prevViewProj ?? viewProj,
    invViewProj,
    camPos: eye,
    sunDir,
    time,
    frame,
  };
  fog.render(state);
  if (!prevViewProj) prevViewProj = new Float32Array(viewProj);

  if (hud && now - lastHudUpdate > 250) {
    lastHudUpdate = now;
    hud.value = `${canvas.width}x${canvas.height} dpr-capped | ${params.marchSteps} steps | temporal ${params.temporal ? 'on' : 'off'}`;
  }
  frame++;
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
