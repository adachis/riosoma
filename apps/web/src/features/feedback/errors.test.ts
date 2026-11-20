import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { browserName, feedbackContext, platformName, themeName } from './context';
import { clearClientErrors, recentClientErrors, recordClientError, scrubMessage, scrubStack } from './errors';

afterEach(() => clearClientErrors());

describe('the page’s recent errors', () => {
  it('keeps the last 20, oldest first', () => {
    for (let n = 1; n <= 25; n += 1) recordClientError(new TypeError(`step ${n} failed`));
    const kept = recentClientErrors();
    expect(kept).toHaveLength(20);
    expect(kept[0]!.message).toBe('TypeError: step 6 failed');
    expect(kept.at(-1)!.message).toBe('TypeError: step 25 failed');
  });

  it('keeps messages and stacks only, with anything that could be a value taken out', () => {
    expect(scrubMessage('Unexpected token \'a\', "Ada Lovelace" is not valid JSON')).toBe(
      'Unexpected token […], […] is not valid JSON',
    );
    expect(scrubMessage('No account for ada@example.com (id 1234567)')).toBe(
      'No account for [email] (id [number])',
    );
    expect(
      scrubStack(
        'Error: boom\n    at render (https://app.example.test/assets/index-abc.js?v=Ada#frag:10:4)\n    at x@https://app.example.test/a.js:1:2',
      ),
    ).toBe(
      '    at render (https://app.example.test/assets/index-abc.js:10:4)\n    at x@https://app.example.test/a.js:1:2',
    );
    const error = Object.assign(new Error('Saving "Ada" failed'), { record: { name: 'Ada Lovelace' } });
    recordClientError(error);
    recordClientError('plain words');
    recordClientError({ name: 'Grace Hopper' });
    expect(JSON.stringify(recentClientErrors())).not.toMatch(/Ada|Grace/);
    expect(recentClientErrors().map((entry) => entry.message)).toEqual([
      'Error: Saving […] failed',
      'plain words',
      'object',
    ]);
  });
});

describe('the context', () => {
  it('names the browser and platform plainly, or leaves them blank', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
    expect(browserName(mac)).toBe('Safari 19');
    expect(platformName({ userAgent: mac })).toBe('macOS');
    expect(browserName(edge)).toBe('Edge 140');
    expect(platformName({ userAgent: edge })).toBe('Windows');
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe(
      'Firefox 140',
    );
    expect(browserName('curl/8')).toBe('');
    expect(platformName({ userAgent: 'curl/8' })).toBe('');
  });

  it('says where the person was without a record’s ID, and carries the errors kept so far', () => {
    recordClientError(new RangeError('bad index'));
    const databaseId = newId('database');
    const tableId = newId('table');
    const viewId = newId('view');
    const context = feedbackContext({
      pathname: `/${databaseId}/${tableId}/${viewId}/${newId('record')}`,
      version: '2.4.0',
      browser: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' },
      preferences: { theme: 'nature', scheme: 'forest', mode: 'dark' },
      org: {},
      language: 'fr',
    });
    expect(context).toEqual({
      path: `/${databaseId}/${tableId}/${viewId}/:record`,
      appVersion: '2.4.0',
      browser: 'Firefox 140',
      platform: 'Linux',
      theme: 'nature / forest / dark',
      language: 'fr',
      errors: [{ message: 'RangeError: bad index', stack: expect.any(String) as string }],
    });
    expect(themeName({}, {})).not.toBe('');
  });
});
