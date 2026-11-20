import { APP_PRESETS } from './index.js';
import { fake } from './fake.test-support.js';
import { registerAppPresets } from './registry.js';

export const TEST_PRESETS = registerAppPresets([...APP_PRESETS, fake]);
