// The master volume in the status bar: a mute button and a slider drawn like
// the tracker's value fields. The slider gives the keyboard back to the
// pattern after a drag, so note keys keep playing notes.

import type { MasterVolume } from '../audio/master-volume.ts';

export interface VolumeControl {
  set(volume: MasterVolume): void;
}

export function mountVolumeControl(root: HTMLElement, initial: MasterVolume, changed: (volume: MasterVolume) => void): VolumeControl {
  const mute = root.querySelector<HTMLButtonElement>('.vol-mute')!;
  const slider = root.querySelector<HTMLInputElement>('input[type=range]')!;
  const value = root.querySelector<HTMLOutputElement>('output')!;
  let volume = { ...initial };

  const show = () => {
    slider.value = String(volume.level);
    root.style.setProperty('--vol', `${volume.level}%`);
    root.classList.toggle('muted', volume.muted);
    mute.setAttribute('aria-pressed', String(volume.muted));
    value.textContent = volume.muted ? '---' : String(volume.level).padStart(3, '0');
  };
  const update = (next: MasterVolume) => {
    volume = next;
    show();
    changed({ ...volume });
  };

  mute.addEventListener('click', () => update({ ...volume, muted: !volume.muted }));
  // Moving the slider means wanting to hear it, so it unmutes.
  slider.addEventListener('input', () => update({ level: Number(slider.value), muted: false }));
  slider.addEventListener('pointerup', () => slider.blur());
  slider.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') slider.blur();
  });
  root.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const level = Math.max(0, Math.min(100, volume.level + (event.deltaY < 0 ? 5 : -5)));
      update({ level, muted: false });
    },
    { passive: false },
  );

  show();
  return {
    set(next) {
      volume = { ...next };
      show();
    },
  };
}
