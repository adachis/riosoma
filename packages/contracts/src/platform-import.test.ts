import { describe, expect, it } from 'vitest';
import {
  IMPORT_PLATFORMS,
  PLATFORM_CLOUD_URLS,
  PLATFORM_NAMES,
  ImportPlatform,
  PlatformImportRequest,
  PlatformPreview,
} from './platform-import.js';
import { IMPORT_PLATFORMS as LIGHTWEIGHT_PLATFORMS } from './import-platforms.js';

describe('shared platform import contracts', () => {
  it('keeps the lightweight platform list in step with all import schemas', () => {
    for (const platform of ['clickup', 'asana', 'notion', 'monday']) {
      expect(LIGHTWEIGHT_PLATFORMS).toContain(platform);
      expect(ImportPlatform.safeParse(platform).success).toBe(true);
    }
    expect(LIGHTWEIGHT_PLATFORMS).toEqual(IMPORT_PLATFORMS);
  });

  it('keeps database and task platforms together', () => {
    const platforms = [
      'nocodb',
      'baserow',
      'grist',
      'teable',
      'seatable',
      'clickup',
      'asana',
      'notion',
      'monday',
      'smartsheet',
    ];
    expect(IMPORT_PLATFORMS).toEqual(platforms);
    for (const platform of platforms) {
      const parsed = ImportPlatform.parse(platform);
      expect(PLATFORM_NAMES[parsed]).toBeTruthy();
      expect(new URL(PLATFORM_CLOUD_URLS[parsed]).protocol).toBe('https:');
    }
  });

  it('preserves multiple selections and typed localized field names', () => {
    const request = {
      address: 'https://api.example.com',
      token: ['test', 'token'].join('-'),
      baseId: 'first',
      additionalBaseIds: ['second'],
      fieldNames: {
        name: 'Name',
        parent: 'Parent',
        body: 'Page body',
        group: 'Group',
        children: 'Subitems',
        attachments: 'Files',
        attachmentName: 'File name',
        attachmentParent: 'Source location',
        predecessorDetails: 'Dependency details',
      },
    };
    expect(PlatformImportRequest.parse(request)).toEqual(request);
    expect(PlatformImportRequest.safeParse({ ...request, fieldNames: { unknown: 'Unknown' } }).success).toBe(
      false,
    );
  });

  it('preserves field types, view counts, and fidelity notes in one preview', () => {
    const preview = {
      tables: [{ id: 'tasks', name: 'Tasks', fields: [{ name: 'Name', type: 'text' }], views: 2 }],
      notes: [
        {
          status: 'changed',
          subject: 'field',
          table: 'Tasks',
          name: 'Page body',
          messageKey: 'import.platform.report.pageBody',
          params: {},
        },
      ],
    };
    expect(PlatformPreview.parse(preview)).toEqual(preview);
    expect(
      PlatformPreview.safeParse({ ...preview, tables: [{ ...preview.tables[0], fields: 1 }] }).success,
    ).toBe(false);
  });
});
