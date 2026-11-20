import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_LIMITS,
  FeedbackContext,
  FeedbackCreate,
  FeedbackGithubUpdate,
  GithubRepository,
  ScreenshotDataUrl,
  feedbackPath,
  idKind,
  newId,
} from './index.js';

const context: FeedbackContext = {
  path: '/settings/appearance',
  appVersion: '1.2.3',
  browser: 'Firefox 140',
  platform: 'Linux',
  theme: 'nature',
  language: 'en-US',
  errors: [],
};

describe('feedback', () => {
  it('gets its own kinds of ID', () => {
    expect(idKind(newId('feedback'))).toBe('feedback');
    expect(idKind(newId('feedbackReply'))).toBe('feedbackReply');
  });

  it('keeps the places in a path and drops the records, the search, and anything else', () => {
    const databaseId = newId('database');
    const tableId = newId('table');
    const viewId = newId('view');
    const recordId = newId('record');
    expect(feedbackPath(`/${databaseId}/${tableId}/${viewId}/${recordId}?q=Ada#top`)).toBe(
      `/${databaseId}/${tableId}/${viewId}/:record`,
    );
    expect(feedbackPath(`/${databaseId}/automations/${newId('automation')}`)).toMatch(
      new RegExp(`^/${databaseId}/automations/aut[0-9A-Za-z]{14}$`),
    );
    expect(feedbackPath('/settings/my-feedback')).toBe('/settings/my-feedback');
    expect(feedbackPath('/v/Secret-Link_Token')).toBe('/v/:value');
    expect(feedbackPath('/%E0%A4%A')).toBe('/:value');
    expect(feedbackPath('/')).toBe('/');
  });

  it('refuses a context whose path still names a record or a value', () => {
    expect(FeedbackContext.safeParse(context).success).toBe(true);
    const written = feedbackPath(
      `/${newId('database')}/${newId('table')}/${newId('view')}/${newId('record')}`,
    );
    expect(feedbackPath(written)).toBe(written);
    expect(FeedbackContext.safeParse({ ...context, path: written }).success).toBe(true);
    const path = `/${newId('database')}/${newId('table')}/${newId('view')}/${newId('record')}`;
    expect(FeedbackContext.safeParse({ ...context, path }).success).toBe(false);
    expect(FeedbackContext.safeParse({ ...context, path: '/v/Ada Lovelace' }).success).toBe(false);
    const errors = Array.from({ length: FEEDBACK_LIMITS.errors + 1 }, () => ({ message: 'x' }));
    expect(FeedbackContext.safeParse({ ...context, errors }).success).toBe(false);
  });

  it('takes a message, a kind, and at most a 2 MB screenshot', () => {
    expect(FeedbackCreate.safeParse({ kind: 'idea', message: ' Dark mode ', context }).data?.message).toBe(
      'Dark mode',
    );
    expect(FeedbackCreate.safeParse({ kind: 'idea', message: '   ', context }).success).toBe(false);
    expect(FeedbackCreate.safeParse({ kind: 'rant', message: 'Hi', context }).success).toBe(false);
    expect(ScreenshotDataUrl.safeParse('data:image/png;base64,iVBORw0KGgo=').success).toBe(true);
    expect(ScreenshotDataUrl.safeParse('data:image/svg+xml;base64,PHN2Zz4=').success).toBe(false);
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil(FEEDBACK_LIMITS.screenshotBytes / 3) * 4 + 40)}`;
    expect(ScreenshotDataUrl.safeParse(huge).success).toBe(false);
  });

  it('names a GitHub repository as owner and name, and a token without spaces', () => {
    expect(GithubRepository.safeParse('riosoma/riosoma').success).toBe(true);
    expect(GithubRepository.safeParse('owner/repo/extra').success).toBe(false);
    expect(GithubRepository.safeParse('https://github.com/owner/repo').success).toBe(false);
    expect(GithubRepository.safeParse('owner/..').success).toBe(false);
    expect(
      FeedbackGithubUpdate.safeParse({ enabled: true, repository: 'a/b', token: 'has a space' }).success,
    ).toBe(false);
    expect(FeedbackGithubUpdate.safeParse({ enabled: false, repository: null }).success).toBe(true);
  });
});
