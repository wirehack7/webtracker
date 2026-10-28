import { describe, expect, it } from 'vitest';
import { DEFAULT_VOLUME, loadVolume, saveVolume, volumeGain } from './master-volume.ts';

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
}

describe('master volume', () => {
  it('starts at full volume, unmuted', () => {
    expect(loadVolume(memory())).toEqual(DEFAULT_VOLUME);
    expect(loadVolume(null)).toEqual(DEFAULT_VOLUME);
  });

  it('remembers level and mute under a webtracker key, so backups carry it', () => {
    const storage = memory();
    saveVolume({ level: 42, muted: true }, storage);
    expect(storage.getItem('webtracker.volume')).toBe('{"level":42,"muted":true}');
    expect(loadVolume(storage)).toEqual({ level: 42, muted: true });
  });

  it('ignores broken or out-of-range stored values', () => {
    const storage = memory();
    storage.setItem('webtracker.volume', 'not json');
    expect(loadVolume(storage)).toEqual(DEFAULT_VOLUME);
    storage.setItem('webtracker.volume', '{"level":250,"muted":"yes"}');
    expect(loadVolume(storage)).toEqual({ level: 100, muted: false });
    storage.setItem('webtracker.volume', '{"level":-3}');
    expect(loadVolume(storage)).toEqual({ level: 0, muted: false });
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('off');
      },
      setItem: () => {
        throw new Error('off');
      },
    } as unknown as Storage;
    expect(loadVolume(broken)).toEqual(DEFAULT_VOLUME);
    expect(() => saveVolume({ level: 10, muted: false }, broken)).not.toThrow();
  });

  it('turns the slider into gain on a squared curve, and mute into silence', () => {
    expect(volumeGain({ level: 100, muted: false })).toBe(1);
    expect(volumeGain({ level: 50, muted: false })).toBe(0.25);
    expect(volumeGain({ level: 0, muted: false })).toBe(0);
    expect(volumeGain({ level: 100, muted: true })).toBe(0);
  });
});
