/**
 * The page's own output volume: how loud everything the tracker plays comes out of
 * this browser (songs, previews, the sample library, a jam). It belongs to the
 * listener, not the song, so it never changes the song's global volume or an export.
 */

export interface MasterVolume {
  /** Percent, 0..100, as the slider shows it. */
  level: number;
  muted: boolean;
}

const KEY = 'webtracker.volume';
export const DEFAULT_VOLUME: MasterVolume = { level: 100, muted: false };

const clampLevel = (level: number) => Math.max(0, Math.min(100, Math.round(level)));

export function loadVolume(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): MasterVolume {
  try {
    const stored = JSON.parse(storage?.getItem(KEY) ?? '{}') as Partial<MasterVolume>;
    return {
      level: typeof stored.level === 'number' && Number.isFinite(stored.level) ? clampLevel(stored.level) : DEFAULT_VOLUME.level,
      muted: stored.muted === true,
    };
  } catch {
    return { ...DEFAULT_VOLUME };
  }
}

export function saveVolume(volume: MasterVolume, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ level: clampLevel(volume.level), muted: volume.muted }));
  } catch {
    // Storage can be off (private windows); the volume then lasts for the session.
  }
}

/**
 * Gain for a slider position. Ears hear loudness roughly logarithmically, so a
 * squared curve makes the middle of the slider sound like the middle.
 */
export function volumeGain(volume: MasterVolume): number {
  if (volume.muted) return 0;
  const x = clampLevel(volume.level) / 100;
  return x * x;
}
