import type { FogParams } from '../fog';
import { applyPreset, DEFAULT_PARAMS, PRESETS } from './presets';

interface Slider {
  key: 'density' | 'scatter' | 'marchSteps' | 'blend';
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: Slider[] = [
  { key: 'density', label: 'density', min: 0, max: 0.3, step: 0.001 },
  { key: 'scatter', label: 'scatter', min: 0, max: 2, step: 0.01 },
  { key: 'marchSteps', label: 'steps', min: 8, max: 96, step: 1 },
  { key: 'blend', label: 'history', min: 0, max: 1, step: 0.01 },
];

const BOX = 'position:fixed;top:12px;right:12px;width:210px;padding:10px;'
  + 'background:rgba(10,12,16,0.82);border:1px solid #2a313b;border-radius:4px;'
  + 'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfd6df;';

/**
 * Debug panel: one row per live parameter plus the preset buttons. Inputs write
 * straight into `params`, so the next frame picks the values up without a reload.
 */
export function attachPanel(params: FogParams, mount: HTMLElement = document.body): () => void {
  const root = document.createElement('div');
  root.style.cssText = BOX;

  const title = document.createElement('div');
  title.textContent = 'fog tuning';
  title.style.cssText = 'margin-bottom:8px;color:#8d99a8;';
  root.append(title);

  const rows = SLIDERS.map((slider) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:block;margin-bottom:6px;';

    const head = document.createElement('span');
    head.style.cssText = 'display:flex;justify-content:space-between;';
    const name = document.createElement('span');
    name.textContent = slider.label;
    const value = document.createElement('span');
    value.textContent = String(params[slider.key]);
    head.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(slider.min);
    input.max = String(slider.max);
    input.step = String(slider.step);
    input.value = String(params[slider.key]);
    input.style.cssText = 'width:100%;';
    input.addEventListener('input', () => {
      params[slider.key] = Number(input.value);
      value.textContent = input.value;
    });

    row.append(head, input);
    root.append(row);
    return { slider, input, value };
  });

  const temporalRow = document.createElement('label');
  temporalRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin:8px 0;';
  const temporal = document.createElement('input');
  temporal.type = 'checkbox';
  temporal.checked = params.temporal;
  temporal.addEventListener('change', () => {
    params.temporal = temporal.checked;
  });
  temporalRow.append(temporal, document.createTextNode('temporal resolve'));
  root.append(temporalRow);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.textContent = preset.label;
    button.style.cssText = 'flex:1 1 auto;padding:3px 6px;background:#1a2027;color:#cfd6df;'
      + 'border:1px solid #2f3843;border-radius:3px;cursor:pointer;';
    button.addEventListener('click', () => {
      applyPreset(params, preset);
      sync();
    });
    buttons.append(button);
  }
  root.append(buttons);

  function sync(): void {
    for (const { slider, input, value } of rows) {
      input.value = String(params[slider.key]);
      value.textContent = String(params[slider.key]);
    }
    temporal.checked = params.temporal;
  }

  mount.append(root);

  const syncAfterPreset = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const index = Number(event.key) - 1;
    const preset = PRESETS[index];
    if (!preset) return;
    applyPreset(params, preset);
    sync();
  };
  window.addEventListener('keydown', syncAfterPreset);

  return () => {
    window.removeEventListener('keydown', syncAfterPreset);
    root.remove();
  };
}
