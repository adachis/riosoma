import { i18n } from '@lingui/core';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Components render their English source messages when no catalog is loaded.
i18n.load('en-US', {});
i18n.activate('en-US');

afterEach(() => cleanup());
