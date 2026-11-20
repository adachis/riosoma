import './public-sharing.css';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newId, type AttachmentMeta } from '@riosoma/contracts';
import { Checkbox } from '@riosoma/ui';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';

export function FormFilesPanel({ formId }: { formId: string }) {
  const { t } = useLingui();
  const client = useQueryClient();
  const key = ['public-form-files', formId];
  const files = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ selected: string[]; files: AttachmentMeta[] }>(`/api/public-sharing/form/${formId}/files`),
  });
  const save = useMutation({
    mutationFn: (fileIds: string[]) =>
      api('/api/public-sharing/commands', {
        body: { id: newId('command'), action: { kind: 'formFiles', linkId: formId, fileIds } },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  return (
    <fieldset className="rio-public-sharing__files">
      <legend>{t({ id: 'publicSharing.formFiles', message: 'Supporting files' })}</legend>
      <p>
        {t({
          id: 'publicSharing.formFilesHelp',
          message:
            'Choose up to 20 files for visitors to download.  An administrator must allow public file links first.',
        })}
      </p>
      <ErrorBanner error={errorInfo(files.error ?? save.error)} />
      {files.data?.files.map((file) => (
        <Checkbox
          key={file.id}
          isSelected={files.data.selected.includes(file.id)}
          isDisabled={
            save.isPending || (!files.data.selected.includes(file.id) && files.data.selected.length >= 20)
          }
          onChange={(selected) =>
            save.mutate(
              selected
                ? [...files.data!.selected, file.id]
                : files.data!.selected.filter((id) => id !== file.id),
            )
          }
        >
          {file.name}
        </Checkbox>
      ))}
    </fieldset>
  );
}
