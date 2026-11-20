import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@riosoma/ui';
import { ApiError } from '../../api';
import { reportError } from './actions';

afterEach(() => vi.restoreAllMocks());

describe('reporting a failure', () => {
  it('says what the server refused, in the language the page is using', () => {
    const shown = vi.spyOn(toast, 'show').mockReturnValue('toast');
    reportError(new ApiError(403, { code: 'forbidden', messageKey: 'errors.adminOnly', userFault: true }));
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls[0]![0]).toMatchObject({
      tone: 'danger',
      title: 'Only an administrator can do that.',
    });
  });

  it('still reports a failure it knows no message for', () => {
    const shown = vi.spyOn(toast, 'show').mockReturnValue('toast');
    // A move that threw inside a key handler used to fail a second time right here, because the
    // shared i18n instance had no locale in a test, and so the person was told nothing at all.
    reportError(new Error('Move failed'));
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls[0]![0]).toMatchObject({
      tone: 'danger',
      title: 'Something went wrong on the server.',
    });
  });
});
