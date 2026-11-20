import { APP_BRANDS } from './app-brands.generated';
import { faWindowMaximize } from '@fortawesome/free-solid-svg-icons';

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve catalog names against the bundled free set without downloading company logos. */
export function appIcon(id: string, name: string) {
  return (
    APP_BRANDS.find((icon) => normalize(icon.iconName) === normalize(id)) ??
    APP_BRANDS.find((icon) => normalize(icon.iconName) === normalize(name)) ??
    faWindowMaximize
  );
}
