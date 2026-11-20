import { faDownload, faCopy } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { Banner, Button, toast } from '@riosoma/ui';
import { saveFile } from '../database/view/download';
import './mfa.css';

/**
 * A new set of recovery codes, shown this once.  The server keeps only their hashes, so the
 * person saves them now: as a text file, or copied somewhere of their own.
 */
export function RecoveryCodesList({ codes, email }: { codes: string[]; email: string }) {
  const { t } = useLingui();

  function download() {
    const text = [
      t({ id: 'mfa.codes.fileTitle', message: `Riosoma recovery codes for ${email}` }),
      '',
      t({
        id: 'mfa.codes.fileBody',
        message:
          'Each code works once, in place of a passkey or an authenticator app.  Keep them somewhere safe.',
      }),
      '',
      ...codes,
      '',
    ].join('\n');
    saveFile(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
      t({ id: 'mfa.codes.fileName', message: 'riosoma-recovery-codes.txt' }),
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
    } catch {
      // A browser that refuses the clipboard still shows the codes, and the download still works.
      return;
    }
    toast.show({
      tone: 'success',
      title: t({ id: 'mfa.codes.copied', message: 'Copied the recovery codes' }),
    });
  }

  return (
    <div className="rio-mfa-codes">
      <Banner tone="warning">
        <Trans id="mfa.codes.saveNow">
          {'Save these codes now.  Each one works once, and you won’t see them again.'}
        </Trans>
      </Banner>
      <ol
        className="rio-mfa-codes__list"
        aria-label={t({ id: 'mfa.codes.label', message: 'Recovery codes' })}
      >
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div className="rio-mfa__buttons">
        <Button
          onPress={download}
          aria-label={t({ id: 'mfa.codes.download', message: 'Download' })}
          icon={faDownload}
        />
        <Button
          onPress={() => void copy()}
          aria-label={t({ id: 'mfa.codes.copy', message: 'Copy' })}
          icon={faCopy}
        />
      </div>
    </div>
  );
}
