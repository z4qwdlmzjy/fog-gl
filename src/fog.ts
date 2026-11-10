import type { Mat4, Vec3 } from './math';
import { COMPOSITE_FS, FOG_FS, FULLSCREEN_VS, RESOLVE_FS, SCENE_FS } from './shaders';

export interface FogParams {
  /** Extinction coefficient before the height and noise terms. */
  density: number;
  /** In-scatter intensity from the sun. */
  scatter: number;
  /** March steps, 8..96. */
  marchSteps: number;
  /** Enable the history buffer. */
  temporal: boolean;
  /** History weight, 0..1. */
  blend: number;
}

export interface FrameState {
  viewProj: Mat4;
  prevViewProj: Mat4;
  invViewProj: Mat4;
  camPos: Vec3;
  /** Normalized direction towards the sun. */
  sunDir: Vec3;
  time: number;
  frame: number;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

type Uniforms = Map<string, WebGLUniformLocation | null>;

const HALF = 0.5;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile error');
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, fsSource: string): { program: WebGLProgram; uniforms: Uniforms } {
  const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) ?? 'program link error');
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return { program: prog, uniforms: new Map() };
}

/**
 * Owns every framebuffer of the fog pipeline. Buffers are half resolution:
 * the march is the expensive part and the resolve runs on the same footprint.
 */
export class FogPass {
  readonly params: FogParams;
  private readonly gl: WebGL2RenderingContext;
  private readonly internalFormat: number;
  private readonly programs: { scene: WebGLProgram; fog: WebGLProgram; resolve: WebGLProgram; composite: WebGLProgram };
  private readonly lookup = new Map<WebGLProgram, Uniforms>();
  private readonly vao: WebGLVertexArrayObject;
  private scene: Target;
  private raw: Target;
  private history: [Target, Target];
  private writeIndex = 0;
  private width = 1;
  private height = 1;

  constructor(gl: WebGL2RenderingContext, params: FogParams) {
    this.gl = gl;
    this.params = params;
    this.internalFormat = gl.getExtension('EXT_color_buffer_float') ? gl.RGBA16F : gl.RGBA8;
    const scene = program(gl, SCENE_FS);
    const fog = program(gl, FOG_FS);
    const resolve = program(gl, RESOLVE_FS);
    const composite = program(gl, COMPOSITE_FS);
    this.programs = {
      scene: scene.program,
      fog: fog.program,
      resolve: resolve.program,
      composite: composite.program,
    };
    this.lookup.set(scene.program, scene.uniforms);
    this.lookup.set(fog.program, fog.uniforms);
    this.lookup.set(resolve.program, resolve.uniforms);
    this.lookup.set(composite.program, composite.uniforms);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;

    this.scene = this.target(1, 1);
    this.raw = this.target(1, 1);
    this.history = [this.target(1, 1), this.target(1, 1)];
    gl.bindVertexArray(vao);
    gl.bindVertexArray(null);
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error('framebuffer allocation failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.internalFormat, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private resizeTarget(target: Target, w: number, h: number): void {
    if (target.w === w && target.h === h) return;
    const gl = this.gl;
    gl.deleteTexture(target.tex);
    gl.deleteFramebuffer(target.fbo);
    const next = this.target(w, h);
    target.tex = next.tex;
    target.fbo = next.fbo;
    target.w = w;
    target.h = h;
  }

  /** Drawable size in device pixels. History is reset if the footprint changes. */
  setSize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    const hw = Math.max(1, Math.ceil(w * HALF));
    const hh = Math.max(1, Math.ceil(h * HALF));
    this.resizeTarget(this.scene, w, h);
    this.resizeTarget(this.raw, hw, hh);
    for (const target of this.history) this.resizeTarget(target, hw, hh);
  }

  private loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    const cache = this.lookup.get(prog);
    if (!cache) return null;
    if (!cache.has(name)) cache.set(name, this.gl.getUniformLocation(prog, name));
    return cache.get(name) ?? null;
  }

  private u1i(prog: WebGLProgram, name: string, value: number): void {
    const loc = this.loc(prog, name);
    if (loc) this.gl.uniform1i(loc, value);
  }

  private u1f(prog: WebGLProgram, name: string, value: number): void {
    const loc = this.loc(prog, name);
    if (loc) this.gl.uniform1f(loc, value);
  }

  private u3f(prog: WebGLProgram, name: string, value: Vec3): void {
    const loc = this.loc(prog, name);
    if (loc) this.gl.uniform3fv(loc, value);
  }

  private uMat4(prog: WebGLProgram, name: string, value: Mat4): void {
    const loc = this.loc(prog, name);
    if (loc) this.gl.uniformMatrix4fv(loc, false, value);
  }

  private bind(unit: number, texture: WebGLTexture, prog: WebGLProgram, name: string): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.u1i(prog, name, unit);
  }

  private drawTo(target: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(frame: FrameState): void {
    const gl = this.gl;
    const { params } = this;

    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(this.programs.scene);
    this.uMat4(this.programs.scene, 'uInvViewProj', frame.invViewProj);
    this.u3f(this.programs.scene, 'uCamPos', frame.camPos);
    this.u3f(this.programs.scene, 'uSunDir', frame.sunDir);
    this.drawTo(this.scene);

    gl.useProgram(this.programs.fog);
    this.bind(0, this.scene.tex, this.programs.fog, 'uScene');
    this.uMat4(this.programs.fog, 'uInvViewProj', frame.invViewProj);
    this.u3f(this.programs.fog, 'uCamPos', frame.camPos);
    this.u3f(this.programs.fog, 'uSunDir', frame.sunDir);
    this.u1f(this.programs.fog, 'uDensity', params.density);
    this.u1f(this.programs.fog, 'uScatter', params.scatter);
    this.u1f(this.programs.fog, 'uTime', frame.time);
    this.u1f(this.programs.fog, 'uFrame', frame.frame);
    this.u1i(this.programs.fog, 'uSteps', Math.max(8, Math.min(96, Math.round(params.marchSteps))));
    this.drawTo(this.raw);

    const read = this.history[this.writeIndex];
    const write = this.history[1 - this.writeIndex];
    this.writeIndex = 1 - this.writeIndex;

    gl.useProgram(this.programs.resolve);
    this.bind(0, this.raw.tex, this.programs.resolve, 'uFog');
    this.bind(1, read.tex, this.programs.resolve, 'uHistory');
    this.bind(2, this.scene.tex, this.programs.resolve, 'uScene');
    this.uMat4(this.programs.resolve, 'uPrevViewProj', frame.prevViewProj);
    this.uMat4(this.programs.resolve, 'uInvViewProj', frame.invViewProj);
    this.u3f(this.programs.resolve, 'uCamPos', frame.camPos);
    this.u1f(this.programs.resolve, 'uBlend', params.temporal ? params.blend : 0);
    this.drawTo(write);

    gl.useProgram(this.programs.composite);
    this.bind(0, this.scene.tex, this.programs.composite, 'uScene');
    this.bind(1, write.tex, this.programs.composite, 'uFog');
    this.drawTo(null);

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const target of [this.scene, this.raw, ...this.history]) {
      gl.deleteTexture(target.tex);
      gl.deleteFramebuffer(target.fbo);
    }
    for (const prog of Object.values(this.programs)) gl.deleteProgram(prog);
    gl.deleteVertexArray(this.vao);
  }
}
