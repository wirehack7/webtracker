// Browser quirks that cannot be detected by feature, only by platform.

interface Platform {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

/** iPhone, iPad and iPod; iPadOS asks for desktop pages and calls itself a Mac with a touch screen. */
export function isAppleTouch(nav: Platform = navigator): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}

/**
 * True where the system file picker filters by file type rather than by name.
 * iOS turns `accept` into file types and has none for tracker formats, so it greys
 * those files out; Android does the same once any listed extension has a type.
 */
export function pickerFiltersByType(nav: Platform = navigator): boolean {
  return isAppleTouch(nav) || /Android/.test(nav.userAgent);
}

/** Lets the picker offer every file where it would grey out ours; the change handlers check what was picked. */
export function relaxFileFilters(root: ParentNode = document, nav: Platform = navigator): void {
  if (!pickerFiltersByType(nav)) return;
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type=file][accept]')) input.removeAttribute('accept');
}
