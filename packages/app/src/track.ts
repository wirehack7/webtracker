/**
 * Announces notable actions as a `chiptrackr:track` event on window, with
 * `{ name, data }` as its detail. Nothing here talks to an analytics service:
 * a deployment can listen for the event through the tracking code it injects,
 * and without a listener the event goes nowhere.
 */
export const TRACK_EVENT = 'chiptrackr:track';

export type TrackData = Record<string, string | number | boolean>;

export function track(name: string, data?: TrackData): void {
  window.dispatchEvent(new CustomEvent(TRACK_EVENT, { detail: data ? { name, data } : { name } }));
}
