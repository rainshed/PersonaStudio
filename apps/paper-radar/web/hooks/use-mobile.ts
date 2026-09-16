import * as React from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

const subscribe = (onChange: () => void) => {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};
const getSnapshot = () => window.matchMedia(MOBILE_QUERY).matches;
// Keep the initial hydration identical to the desktop-shaped server markup.
const getServerSnapshot = () => false;

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
