import { describe, expect, it, vi } from 'vitest';
import { ScimError } from './errors.js';
import { ENTERPRISE_SCHEMA, FILTER_WORK_LIMIT, PATCH_SCHEMA, USER_SCHEMA, patchResource } from './patch.js';

const patch = (Operations: unknown[]) => ({ schemas: [PATCH_SCHEMA], Operations });

describe('SCIM PATCH operations', () => {
  it('changes a filtered email without changing other addresses', () => {
    const resource = {
      emails: [
        { type: 'work', value: 'before@example.test' },
        { type: 'home', value: 'home@example.test' },
      ],
    };
    const changed = patchResource(
      resource,
      patch([{ op: 'replace', path: 'emails[type eq "work"].value', value: 'after@example.test' }]),
      'Users',
    );
    expect(changed.emails).toEqual([{ type: 'work', value: 'after@example.test' }, resource.emails[1]]);
    expect(resource.emails[0]?.value).toBe('before@example.test');
  });

  it('accepts Entra operations with capitalized operation names and pathless updates', () => {
    expect(
      patchResource(
        { active: true, displayName: 'Before' },
        patch([
          { op: 'Replace', value: { active: false } },
          { op: 'Replace', path: 'displayName', value: 'After' },
        ]),
        'Users',
      ),
    ).toEqual({ active: false, displayName: 'After' });
  });

  it('adds and removes group members in the order requested', () => {
    const resource = { members: [{ value: 'first' }] };
    const result = patchResource(
      resource,
      patch([
        { op: 'add', path: 'members', value: [{ value: 'second' }] },
        { op: 'remove', path: 'members[value eq "first"]' },
      ]),
      'Groups',
    );
    expect(result.members).toEqual([{ value: 'second' }]);
  });

  it('handles schema qualified enterprise fields and complex subattributes', () => {
    const result = patchResource(
      {},
      patch([
        { op: 'add', path: `${ENTERPRISE_SCHEMA}:department`, value: 'Operations' },
        { op: 'replace', path: 'name.givenName', value: 'Barbara' },
      ]),
      'Users',
    );
    expect(result).toEqual({
      [ENTERPRISE_SCHEMA]: { department: 'Operations' },
      name: { givenName: 'Barbara' },
    });
  });

  it('rejects invalid paths and leaves the resource unchanged after a later error', () => {
    const resource = { displayName: 'Before' };
    expect(() =>
      patchResource(
        resource,
        patch([
          { op: 'replace', path: 'displayName', value: 'After' },
          { op: 'replace', path: '__proto__.value', value: 'untrusted' },
        ]),
        'Users',
      ),
    ).toThrow(expect.objectContaining({ scimType: 'invalidPath' }));
    expect(resource).toEqual({ displayName: 'Before' });
  });

  it('reports an unmatched filtered replacement as noTarget', () => {
    expect(() =>
      patchResource(
        { emails: [] },
        patch([{ op: 'replace', path: 'emails[type eq "work"].value', value: 'work@example.test' }]),
        'Users',
      ),
    ).toThrow(expect.objectContaining({ status: 400, scimType: 'noTarget' }));
  });

  it('checks the member cap before any per-member work, across every operation', () => {
    const members = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({ value: `${prefix}${index}` }));
    for (const operations of [
      [{ op: 'add', path: 'members', value: members(10_001, 'a') }],
      [
        { op: 'add', path: 'members', value: members(6_000, 'a') },
        { op: 'add', path: 'members', value: members(6_000, 'b') },
      ],
      [{ op: 'remove', path: 'members', value: members(10_001, 'a') }],
      [{ op: 'replace', value: { members: members(10_001, 'a') } }],
    ])
      expect(() => patchResource({ members: [] }, patch(operations), 'Groups')).toThrow(
        expect.objectContaining({ status: 400, scimType: 'invalidValue' }),
      );
    expect(() =>
      patchResource(
        { emails: [] },
        patch([{ op: 'add', path: 'emails', value: members(101, 'e') }]),
        'Users',
      ),
    ).toThrow(expect.objectContaining({ scimType: 'invalidValue' }));
    expect(() =>
      patchResource(
        { members: members(10_000, 'a') },
        patch([{ op: 'add', path: 'members', value: [{ value: 'b' }] }]),
        'Groups',
      ),
    ).toThrow(expect.objectContaining({ scimType: 'invalidValue' }));
  });

  it('selects filtered values in one pass, without rescanning the selection for each value', () => {
    const members = Array.from({ length: 5_000 }, (_, index) => ({
      value: `m${index}`,
      type: index % 2 ? 'User' : 'Group',
    }));
    const includes = vi.spyOn(Array.prototype, 'includes');
    const result = patchResource(
      { members },
      patch([{ op: 'remove', path: 'members[type eq "Group"]' }]),
      'Groups',
    );
    const calls = includes.mock.calls.length;
    includes.mockRestore();
    expect(result.members).toHaveLength(2_500);
    expect(calls).toBeLessThan(10);
  });

  it('succeeds for an add or remove whose filter matches nothing, and adds the typed email', () => {
    expect(
      patchResource(
        { members: [{ value: 'first' }] },
        patch([{ op: 'remove', path: 'members[value eq "absent"]' }]),
        'Groups',
      ),
    ).toEqual({ members: [{ value: 'first' }] });
    expect(
      patchResource(
        { emails: [{ type: 'home', value: 'home@example.test' }] },
        patch([
          { op: 'add', path: 'emails[type eq "work"].value', value: 'work@example.test' },
          { op: 'add', path: 'emails[type eq "work"].value', value: 'second@example.test' },
          { op: 'remove', path: 'emails[type eq "other"]' },
        ]),
        'Users',
      ),
    ).toEqual({
      emails: [
        { type: 'home', value: 'home@example.test' },
        { type: 'work', value: 'second@example.test' },
      ],
    });
  });

  it('ignores unknown and read-only attributes but still rejects malformed paths', () => {
    expect(
      patchResource(
        { displayName: 'Before' },
        patch([
          {
            op: 'replace',
            value: { id: 'other', meta: {}, schemas: [], title: 'Lead', displayName: 'After' },
          },
          { op: 'add', path: 'phoneNumbers[type eq "work"].value', value: '555-0100' },
          { op: 'replace', path: 'name.middleName', value: 'J' },
          {
            op: 'replace',
            path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:costCenter',
            value: '1',
          },
          { op: 'remove', path: 'nickName' },
        ]),
        'Users',
      ),
    ).toEqual({ displayName: 'After' });
    for (const path of ['emails[type eq "work"', 'displayName[type eq "x"]', 'emails[bogus eq "x"].value'])
      expect(() => patchResource({}, patch([{ op: 'replace', path, value: 'x' }]), 'Users')).toThrow(
        expect.objectContaining({ scimType: 'invalidPath' }),
      );
  });

  it('reads string booleans when choosing the primary email', () => {
    expect(
      patchResource(
        { emails: [{ type: 'home', value: 'home@example.test', primary: true }] },
        patch([
          {
            op: 'add',
            path: 'emails',
            value: [{ type: 'work', value: 'work@example.test', primary: 'True' }],
          },
        ]),
        'Users',
      ).emails,
    ).toEqual([
      { type: 'home', value: 'home@example.test', primary: false },
      { type: 'work', value: 'work@example.test', primary: 'True' },
    ]);
  });

  it('answers a remove without a path with noTarget', () => {
    expect(() => patchResource({}, patch([{ op: 'remove' }]), 'Users')).toThrow(
      expect.objectContaining({ status: 400, scimType: 'noTarget' }),
    );
  });

  it('refuses a path that names a read-only attribute with mutability', () => {
    for (const path of ['id', 'meta', `${USER_SCHEMA}:schemas`])
      expect(() => patchResource({}, patch([{ op: 'replace', path, value: 'x' }]), 'Users')).toThrow(
        expect.objectContaining({ status: 400, scimType: 'mutability' }),
      );
  });

  it('caps the comparisons one PATCH’s filters may make, however the work is split', () => {
    const members = Array.from({ length: 10_000 }, (_, index) => ({ value: `member${index}` }));
    const wide = Array.from({ length: 64 }, (_, index) => `value eq "nomatch${index}"`).join(' or ');
    const heavy = patch(Array.from({ length: 100 }, () => ({ op: 'remove', path: `members[${wide}]` })));
    const refusal = (() => {
      try {
        patchResource({ members }, heavy, 'Groups');
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(ScimError);
    expect(refusal).toMatchObject({ status: 400, scimType: 'invalidValue' });
    // What directories send, one comparison against every member, fits many times over.
    const light = patch(
      Array.from({ length: 100 }, (_, index) => ({
        op: 'remove',
        path: `members[value eq "member${index}"]`,
      })),
    );
    expect((patchResource({ members }, light, 'Groups').members as unknown[]).length).toBe(9_900);
    // The limit counts operations times values times comparisons.
    const exact = Array.from({ length: FILTER_WORK_LIMIT / 10_000 }, () => ({
      op: 'remove',
      path: 'members[value eq "x"]',
    }));
    expect(() => patchResource({ members }, patch(exact), 'Groups')).not.toThrow();
    expect(() => patchResource({ members }, patch([...exact, exact[0]]), 'Groups')).toThrow(ScimError);
  });

  it('merges a complex replace into what’s there, whatever case its names use', () => {
    const resource = {
      name: { givenName: 'Rita', familyName: 'Field' },
      [ENTERPRISE_SCHEMA]: { department: 'Ops', manager: { value: 'boss', displayName: 'Boss' } },
    };
    const changed = patchResource(
      resource,
      patch([
        { op: 'replace', path: 'name', value: { GIVENNAME: 'Rae' } },
        { op: 'replace', value: { [ENTERPRISE_SCHEMA]: { manager: { value: 'new-boss' } } } },
      ]),
      'Users',
    );
    expect(changed.name).toEqual({ givenName: 'Rae', familyName: 'Field' });
    expect(changed[ENTERPRISE_SCHEMA]).toEqual({
      department: 'Ops',
      manager: { value: 'new-boss', displayName: 'Boss' },
    });
    expect(resource.name.givenName).toBe('Rita');
  });
});
