import { describe, expect, it } from 'vitest';
import { isAppleTouch, pickerFiltersByType } from './platform.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('platform', () => {
  it('finds iPhones and iPads, also iPads that pose as a Mac', () => {
    expect(isAppleTouch({ userAgent: IPHONE })).toBe(true);
    expect(isAppleTouch({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isAppleTouch({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });

  it('relaxes the file filter on phones only', () => {
    expect(pickerFiltersByType({ userAgent: IPHONE })).toBe(true);
    expect(pickerFiltersByType({ userAgent: ANDROID })).toBe(true);
    expect(pickerFiltersByType({ userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 0 })).toBe(false);
    expect(pickerFiltersByType({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });
});
