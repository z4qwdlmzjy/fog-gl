import type { FogParams } from '../fog';

export interface Preset {
  id: string;
  label: string;
  params: FogParams;
}

/** Starting points that exercise the resolve: still air leans on history,
 *  the shaft preset turns it off so the march has to stand on its own. */
export const PRESETS: Preset[] = [
  {
    id: 'still-air',
    label: 'Still air',
    params: { density: 0.035, scatter: 0.45, marchSteps: 32, temporal: true, blend: 0.92 },
  },
  {
    id: 'windy-dawn',
    label: 'Windy dawn',
    params: { density: 0.075, scatter: 0.7, marchSteps: 48, temporal: true, blend: 0.88 },
  },
  {
    id: 'light-shaft',
    label: 'Light shaft',
    params: { density: 0.11, scatter: 1.1, marchSteps: 64, temporal: false, blend: 0.0 },
  },
];

export const DEFAULT_PARAMS: FogParams = { ...PRESETS[1].params };

/** Copies a preset into the live parameter object, keeping its identity. */
export function applyPreset(params: FogParams, preset: Preset): void {
  params.density = preset.params.density;
  params.scatter = preset.params.scatter;
  params.marchSteps = preset.params.marchSteps;
  params.temporal = preset.params.temporal;
  params.blend = preset.params.blend;
}
