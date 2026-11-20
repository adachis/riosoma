import { newId } from '@riosoma/contracts';
import { expect, it } from 'vitest';
import { attachmentMeta, type FileRow } from '../data/files/metadata.js';
import { demoRequest } from './boundary.js';

it.each(['postgres', 'local', 's3', 'azure-blob'] as const)(
  'advertises only accessible %s attachment media in demo metadata',
  (storage) => {
    const file: FileRow = {
      id: newId('attachment'),
      org_id: newId('org'),
      table_id: newId('table'),
      field_id: newId('field'),
      name: 'sample.png',
      size: '100',
      type: 'image/png',
      width: 20,
      height: 10,
      sha256: '',
      storage,
      storage_key: 'sample',
      thumbnails: {
        small: { key: 'small', size: 10, sha256: '' },
        large: { key: 'large', size: 20, sha256: '' },
      },
      created_by: null,
      created_at: new Date(),
      scan_state: 'clean',
      scan_signature: null,
      scan_attempts: 0,
      attached_at: new Date(),
    };
    const ordinary = attachmentMeta(file);
    expect(ordinary.url).toBe(`/api/files/${file.id}/sample.png`);
    expect(ordinary.thumbnails).toEqual({
      small: `/api/files/${file.id}/thumbnails/small`,
      large: `/api/files/${file.id}/thumbnails/large`,
    });
    const demo = demoRequest(() => attachmentMeta(file));
    const cloud = storage === 's3' || storage === 'azure-blob';
    expect(demo).toEqual(
      cloud ? { ...ordinary, url: '', thumbnails: { small: null, large: null } } : ordinary,
    );
    // A scan exemption still cannot make a cloud download accessible to a demo visitor.
    const allowed = { ...file, scan_state: 'too_large_allowed' as const };
    expect(demoRequest(() => attachmentMeta(allowed)).url).toBe(cloud ? '' : ordinary.url);
    expect(attachmentMeta(file)).toEqual(ordinary);
  },
);
