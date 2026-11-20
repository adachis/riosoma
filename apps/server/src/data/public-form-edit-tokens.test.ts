import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { newPublicFormId } from './public-forms.js';
import {
  EDIT_DAY_MS,
  EDIT_SESSION_MS,
  issueFormEditToken,
  readFormEditToken,
  type FormEditClaims,
} from './public-form-edit-tokens.js';

const key = randomBytes(32);
const now = 1790000000000;
const claims: FormEditClaims = {
  purpose: 'link',
  formId: newPublicFormId(),
  recordId: newId('record'),
  version: 2,
  issuedAt: now,
  expires: now + 30 * EDIT_DAY_MS,
};
const target = { purpose: 'link' as const, formId: claims.formId, recordId: claims.recordId, version: 2 };

it('signs a link for exactly one form, record, and revocation version', () => {
  const token = issueFormEditToken(key, claims);
  expect(readFormEditToken(key, token, target, now)).toEqual(claims);
  expect(() => readFormEditToken(key, token, { ...target, formId: newPublicFormId() }, now)).toThrow(
    'forms.edit.invalid',
  );
  expect(() => readFormEditToken(key, token, { ...target, recordId: newId('record') }, now)).toThrow(
    'forms.edit.invalid',
  );
  expect(() => readFormEditToken(key, token, { ...target, version: 3 }, now)).toThrow('forms.edit.revoked');
});

it('rejects tampering, an unrelated key, malformed tokens, and noncanonical signatures', () => {
  const token = issueFormEditToken(key, claims);
  const [payload, signature] = token.split('.') as [string, string];
  const modified = Buffer.from(JSON.stringify({ ...claims, recordId: newId('record') })).toString(
    'base64url',
  );
  for (const value of ['', `${modified}.${signature}`, `${payload}.${signature.slice(1)}`, `${token}.extra`])
    expect(() => readFormEditToken(key, value, target, now)).toThrow('forms.edit.invalid');
  expect(() => readFormEditToken(randomBytes(32), token, target, now)).toThrow('forms.edit.invalid');
});

it('expires at the boundary and refuses future, unlimited, or excessive lifetimes', () => {
  const token = issueFormEditToken(key, claims);
  expect(readFormEditToken(key, token, target, claims.expires - 1)).toEqual(claims);
  expect(() => readFormEditToken(key, token, target, claims.expires)).toThrow('forms.edit.expired');
  for (const input of [{ issuedAt: now + 1 }, { expires: now }, { expires: now + 366 * EDIT_DAY_MS }])
    expect(() =>
      readFormEditToken(key, issueFormEditToken(key, { ...claims, ...input }), target, now),
    ).toThrow('forms.edit.invalid');
});

it('separates short sessions from links and binds a session to its address', () => {
  const session = {
    ...claims,
    purpose: 'session' as const,
    expires: now + EDIT_SESSION_MS,
    address: 'hashed-address',
  };
  const token = issueFormEditToken(key, session);
  const sessionTarget = { ...target, purpose: 'session' as const, address: session.address };
  expect(readFormEditToken(key, token, sessionTarget, now)).toEqual(session);
  expect(() => readFormEditToken(key, token, target, now)).toThrow('forms.edit.invalid');
  expect(() => readFormEditToken(key, issueFormEditToken(key, claims), sessionTarget, now)).toThrow(
    'forms.edit.invalid',
  );
  expect(() => readFormEditToken(key, token, { ...sessionTarget, address: 'another-address' }, now)).toThrow(
    'forms.edit.invalid',
  );
  expect(() => readFormEditToken(key, token, sessionTarget, session.expires)).toThrow('forms.edit.expired');
  expect(() =>
    readFormEditToken(
      key,
      issueFormEditToken(key, { ...session, expires: session.expires + 1 }),
      sessionTarget,
      now,
    ),
  ).toThrow('forms.edit.invalid');
});
