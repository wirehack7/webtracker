import { describe, expect, it } from 'vitest';
import { describeCleanup, formatBytes, formatDuration } from './song-stats.ts';

describe('song stats', () => {
  it('formats sizes and times', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2560)).toBe('2.5 KB');
    expect(formatDuration(61.6)).toBe('1:02');
    expect(formatDuration(5)).toBe('0:05');
  });

  it('describes what an optimization changes', () => {
    expect(describeCleanup({ patterns: 0, instruments: 0, samples: 0, frames: 0, halved: 0, converted: 0 })).toBe('');
    expect(describeCleanup({ patterns: 1, instruments: 2, samples: 0, frames: 1500, halved: 1, converted: 3 })).toBe(
      '1 pattern removed, 2 instruments removed, 1 sample at half rate, 3 samples to 8-bit, 1,500 sample frames fewer',
    );
  });
});
