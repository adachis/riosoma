import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { AttachmentMeta } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { ServerFixture } from '../../test/fixture.js';

/** Cloud fixtures retain real thumbnail metadata without contacting outside storage. */
export async function demoMedia(server: ServerFixture, tableId: string, fieldIds: readonly string[]) {
  const image = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  const upload = async (fieldId: string, name: string, bytes: Buffer, type: string) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/fields/${fieldId}/files`,
      headers: { ...server.owner.headers, 'content-type': type, 'x-file-name': name },
      payload: bytes,
    });
    if (response.statusCode !== 200) throw new Error(`Demo attachment upload failed: ${response.body}`);
    return AttachmentMeta.parse(response.json());
  };
  const s3 = await upload(fieldIds[0]!, 's3-image.png', image, 'image/png');
  const azure = await upload(fieldIds[1]!, 'azure-image.png', image, 'image/png');
  const local = await upload(fieldIds[2]!, 'local-image.png', image, 'image/png');
  const pdf = await upload(
    fieldIds[3]!,
    'agreement.pdf',
    Buffer.from(await document.save()),
    'application/pdf',
  );
  for (const [file, storage] of [
    [s3, 's3'],
    [azure, 'azure-blob'],
  ] as const)
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'files')} SET storage = ${storage} WHERE id = ${file.id}`,
    );
  return { local, s3, azure, pdf };
}
