export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Depth of the analytic ground in world units; the surface is gently rolling. */
const GROUND = `
float groundHeight(vec2 xz) {
  return 0.6 * sin(xz.x * 0.11) * cos(xz.y * 0.13)
       + 0.15 * sin(xz.x * 0.37 + xz.y * 0.21);
}`;

/** Scene pass: sky gradient or ground albedo, distance packed into alpha. */
export const SCENE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
out vec4 oColor;
const float MAX_RANGE = 120.0;
${GROUND}

void main() {
  vec4 far = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCamPos);
  float dist = 1e4;
  if (dir.y < -1e-3) {
    float t = (uCamPos.y - groundHeight(uCamPos.xz)) / -dir.y;
    if (t > 0.0) dist = t;
  }
  vec3 p = uCamPos + dir * dist;
  vec3 sky = mix(vec3(0.24, 0.34, 0.48), vec3(0.68, 0.76, 0.85), clamp(dir.y * 1.4, 0.0, 1.0));
  vec3 rock = vec3(0.19, 0.20, 0.17) * (0.7 + 0.3 * groundHeight(p.xz));
  float sun = max(dot(vec3(0.0, 1.0, 0.0), uSunDir), 0.0);
  vec3 color = dist < 1e3 ? rock * sun * vec3(1.0, 0.93, 0.82) : sky;
  oColor = vec4(color, min(dist, MAX_RANGE) / MAX_RANGE);
}`;

/** Fog pass: jittered ray march accumulating height fog with drifting noise. */
export const FOG_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uScene;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uDensity;
uniform float uScatter;
uniform float uTime;
uniform float uFrame;
uniform int uSteps;
out vec4 oFog;
const float MAX_RANGE = 120.0;
${GROUND}

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash(i);
  float n100 = hash(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

/** Interleaved gradient noise, per pixel, rotated per frame. */
float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

float density(vec3 p) {
  float height = exp(-max(p.y - 0.4, 0.0) * 0.35);
  vec3 drift = vec3(uTime * 0.35, uTime * 0.08, uTime * -0.2);
  float n = noise(p * 0.18 + drift) * noise(p * 0.51 - drift * 2.0);
  float hollow = smoothstep(0.0, 3.0, p.y - groundHeight(p.xz));
  return uDensity * height * (0.25 + 2.2 * n) * hollow;
}

float hg(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

void main() {
  vec3 dir = normalize((uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0)).xyz - uCamPos);
  float maxT = min(texture(uScene, vUv).a * MAX_RANGE, MAX_RANGE);
  float stepLen = maxT / float(uSteps);
  float jitter = mix(ign(gl_FragCoord.xy), ign(gl_FragCoord.yx + 17.0),
                     fract(uFrame * 0.6180339887));
  float phase = hg(dot(dir, uSunDir), 0.35) * 12.566;
  vec3 inScatter = vec3(0.0);
  float transmittance = 1.0;
  float t = stepLen * jitter;
  for (int i = 0; i < 96; i++) {
    if (i >= uSteps) break;
    float sigma = density(uCamPos + dir * t) * stepLen;
    inScatter += transmittance * vec3(1.0, 0.93, 0.82) * (uScatter * phase) * (1.0 - exp(-sigma));
    transmittance *= exp(-sigma);
    t += stepLen;
  }
  oFog = vec4(inScatter, transmittance);
}`;

/** Resolve: reproject history with the previous view-projection, clamp to the
 *  3x3 neighbourhood of the fresh march, fade history out with pixel velocity. */
export const RESOLVE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uFog;
uniform sampler2D uHistory;
uniform sampler2D uScene;
uniform mat4 uPrevViewProj;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform float uBlend;
out vec4 oResolved;
const float MAX_RANGE = 120.0;

void main() {
  vec4 current = texture(uFog, vUv);
  vec2 texel = 1.0 / vec2(textureSize(uFog, 0));
  vec4 lo = current;
  vec4 hi = current;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec4 s = texture(uFog, vUv + vec2(x, y) * texel * 1.5);
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }

  vec3 dir = normalize((uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0)).xyz - uCamPos);
  float dist = texture(uScene, vUv).a * MAX_RANGE;
  vec4 clip = uPrevViewProj * vec4(uCamPos + dir * dist, 1.0);
  vec2 prevUv = clip.xy / clip.w * 0.5 + 0.5;
  bool valid = clip.w > 0.0
    && all(greaterThanEqual(prevUv, vec2(0.0)))
    && all(lessThanEqual(prevUv, vec2(1.0)));

  vec4 history = valid ? clamp(texture(uHistory, prevUv), lo, hi) : current;
  float velocity = valid ? length((vUv - prevUv) * texel) : 1.0;
  float weight = uBlend * clamp(0.95 - velocity * 24.0, 0.0, 0.95);
  oResolved = mix(current, history, valid ? weight : 0.0);
}`;

/** Composite: absorption of the scene plus fog in-scatter, gamma to the swap chain. */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uFog;
out vec4 oColor;

void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec4 fog = texture(uFog, vUv);
  vec3 color = scene * clamp(fog.a, 0.0, 1.0) + fog.rgb;
  float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  color += (dither - 0.5) / 255.0;
  oColor = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;
