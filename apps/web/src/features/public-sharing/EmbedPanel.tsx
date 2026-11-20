import './public-sharing.css';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newId, type PublicEmbedTarget, type SharedViewEmbed } from '@riosoma/contracts';
import { useState } from 'react';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { EmbedChoice } from '../../screens/database/share-view/ShareViewDialog';

export function EmbedPanel({ target, url, name }: { target: PublicEmbedTarget; url: string; name: string }) {
  const { t } = useLingui();
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const key = ['public-sharing', target.kind, target.linkId];
  const settings = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ embed: SharedViewEmbed; embeddingEnabled: boolean }>(
        `/api/public-sharing/${target.kind}/${target.linkId}`,
      ),
  });
  const save = useMutation({
    mutationFn: (embed: SharedViewEmbed) =>
      api('/api/public-sharing/commands', {
        body: { id: newId('command'), action: { kind: 'embed', target, embed } },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  return (
    <div className="rio-public-sharing">
      <ErrorBanner error={errorInfo(settings.error ?? save.error)} />
      {settings.data && (
        <>
          {!settings.data.embeddingEnabled && (
            <p>
              {t({
                id: 'publicSharing.embeddingOff',
                message: 'Embedding is turned off for this organization.',
              })}
            </p>
          )}
          <EmbedChoice
            link={{ settings: { embed: settings.data.embed } }}
            url={url}
            name={name}
            disabled={save.isPending || !settings.data.embeddingEnabled}
            onSave={(update) => {
              if (update.embed) save.mutate(update.embed);
            }}
            onCopy={(code) => {
              void navigator.clipboard.writeText(code).then(
                () => setCopied(true),
                () => undefined,
              );
            }}
          />
        </>
      )}
      <p aria-live="polite">
        {copied ? t({ id: 'shareView.copiedEmbed', message: 'Copied the embed code' }) : ''}
      </p>
    </div>
  );
}
