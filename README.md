# fog-gl

Screen-space volumetric fog for WebGL2 with temporal reprojection. The fog is ray
marched at half resolution with a per-pixel, per-frame jittered start offset, then
resolved against a history buffer reprojected through the previous view-projection
matrix. History samples are clamped to the 3x3 neighbourhood of the fresh march and
faded out with pixel velocity, so camera motion and the animated noise field stay
stable without smearing.

The point is the resolve, not the fog: the same history path also works for
half-resolution ambient occlusion, SSR and soft shadows, and it is small enough to
read in one sitting.

Live demo: `https://z4qwdlmzjy.github.io/fog-gl/` (placeholder until Pages is wired up).

## Why

Full-resolution ray marching of heterogeneous fog costs 30-96 dependent texture
reads per pixel. At half resolution with a 40-step march and a 2x temporal reuse the
frame keeps roughly a quarter of the taps while still converging when the camera is
still. The scene is a single analytic height field, so there is no glTF or loader
dependency and the shaders stay focused.

## Install

```sh
npm install
npm run dev      # vite on http://localhost:5173
npm run build    # type check + production bundle in dist/
```

Requires a WebGL2 browser with `EXT_color_buffer_float` for the 16-bit fog buffers
(8-bit is used as a fallback; banding is visible there).

## Usage

Drag to orbit. Press `t` to toggle the history buffer and compare the march against
the resolve. Fog parameters live in the `params` object in `src/main.ts`:

| field        | meaning                                      |
| ------------ | -------------------------------------------- |
| `density`    | extinction before height and noise terms      |
| `scatter`    | sun in-scatter intensity                      |
| `marchSteps` | 8..96, clamped in the pass                    |
| `temporal`   | enable history reuse                          |
| `blend`      | history weight, 0..1                          |

## Layout

```
index.html          canvas, HUD and the dev entry point
src/main.ts         camera orbit, Halton jitter, frame state, resize
src/fog.ts          targets, programs and the four passes (scene, fog, resolve, composite)
src/shaders.ts      GLSL for every pass, including the resolve
src/math.ts         mat4 helpers and the Halton sequence
```

## Performance notes

- Fog buffers are half resolution and reallocate only on resize; the scene target is
  the only full-resolution colour attachment.
- `marchSteps` is uniform-clamped to 8..96, so a slow iGPU can drop to 16 steps
  without a shader recompile.
- The neighbourhood clamp costs 9 taps per pixel and is what keeps the 0.9 history
  weight from smearing highlights. Lowering `blend` below 0.6 makes the clamp
  pointless and the fog starts to flicker.
- History is dropped for a frame after a resize or when the reprojected UV leaves the
  viewport.

## Limitations

- One directional light, no shadowing of the in-scatter.
- The ground is analytic; nothing writes real depth yet, so the march stops at the
  scene distance packed into the alpha channel.
- No jitter-aware anti-aliasing outside the fog pass.

## License

MIT, 2026 Mira Haddad.
