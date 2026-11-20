import { describe, expect, it } from 'vitest';
import { Preferences, PreferencesUpdate, OrgSettings } from './auth.js';
import { higherLevel, levelsFor, lowerLevel, reaches } from './levels.js';

describe('experience levels', () => {
  it('orders the levels from Simple to Advanced', () => {
    expect(reaches('advanced', 'standard')).toBe(true);
    expect(reaches('standard', 'standard')).toBe(true);
    expect(reaches('simple', 'standard')).toBe(false);
    expect(lowerLevel('advanced', 'simple')).toBe('simple');
    expect(higherLevel('simple', 'standard')).toBe('standard');
  });

  it('starts members at Standard and guests at Simple, until they choose', () => {
    expect(levelsFor('member', {}, undefined)).toEqual({
      level: 'standard',
      highest: 'advanced',
      start: 'standard',
      chosen: false,
    });
    expect(levelsFor('owner', undefined, undefined).level).toBe('standard');
    expect(levelsFor('guest', {}, undefined)).toEqual({
      level: 'simple',
      highest: 'advanced',
      start: 'simple',
      chosen: false,
    });
    expect(levelsFor('member', {}, 'advanced')).toMatchObject({ level: 'advanced', chosen: true });
  });

  it('starts members at the organization’s default, and never guests', () => {
    expect(levelsFor('member', { defaultLevel: 'simple' }, undefined).level).toBe('simple');
    expect(levelsFor('owner', { defaultLevel: 'advanced' }, undefined).level).toBe('advanced');
    expect(levelsFor('guest', { defaultLevel: 'advanced' }, undefined).level).toBe('simple');
    // A choice outlasts a new default.
    expect(levelsFor('member', { defaultLevel: 'simple' }, 'advanced').level).toBe('advanced');
  });

  it('holds guests at or below the organization’s limit, even with an older choice', () => {
    expect(levelsFor('guest', { guestLevel: 'standard' }, 'advanced')).toEqual({
      level: 'standard',
      highest: 'standard',
      start: 'simple',
      chosen: true,
    });
    expect(levelsFor('guest', { guestLevel: 'simple' }, 'standard').level).toBe('simple');
    // The limit is for guests alone.
    expect(levelsFor('member', { guestLevel: 'simple' }, 'advanced').level).toBe('advanced');
  });

  it('keeps the level with a person’s preferences and the organization’s settings', () => {
    expect(Preferences.parse({ level: 'simple', levelSuggestion: 'dismissed' })).toEqual({
      level: 'simple',
      levelSuggestion: 'dismissed',
    });
    expect(Preferences.safeParse({ level: 'expert' }).success).toBe(false);
    expect(OrgSettings.parse({ defaultLevel: 'advanced', guestLevel: 'simple' })).toEqual({
      defaultLevel: 'advanced',
      guestLevel: 'simple',
    });
  });

  it('clears a level with null, so the person follows the default again, and nothing else', () => {
    expect(PreferencesUpdate.parse({ level: null })).toEqual({ level: null });
    expect(PreferencesUpdate.parse({ level: 'advanced', theme: 'nature' })).toEqual({
      level: 'advanced',
      theme: 'nature',
    });
    // Only the level goes back to a default.  Everything else is set, never cleared.
    expect(PreferencesUpdate.safeParse({ theme: null }).success).toBe(false);
    expect(PreferencesUpdate.safeParse({ level: 'expert' }).success).toBe(false);
  });
});
