import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button, TextField } from '@riosoma/ui';
import { Link } from '@tanstack/react-router';
import { listModules, loadModule, type DocModule } from '../../docs/loader';
import { searchHelp } from './demo-help';
import './DemoAssistant.css';

/** Built-in help is searched locally, so demo questions never reach a model or records. */
export function DemoAssistant({ onClose }: { onClose(): void }) {
  const { t, i18n } = useLingui();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<ReturnType<typeof searchHelp> | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    try {
      const index = await listModules(i18n.locale);
      const modules = (await Promise.all(index.map((topic) => loadModule(topic.id, i18n.locale)))).filter(
        (topic): topic is DocModule => topic !== null,
      );
      setAnswer(searchHelp(modules, question));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside
      className="rio-assistant__dock rio-demo-help"
      aria-label={t({ id: 'demo.help.title', message: 'Ask the help topics' })}
    >
      <div className="rio-demo-help__heading">
        <strong>
          <Trans id="demo.help.title">Ask the help topics</Trans>
        </strong>
        <Button variant="quiet" size="sm" onPress={onClose}>
          <Trans id="common.close">Close</Trans>
        </Button>
      </div>
      <p>
        {t({
          id: 'demo.help.disclosure',
          message:
            'This demo does not use AI.  I search the built-in help topics and show matching passages and links.',
        })}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <TextField
          label={t({ id: 'demo.help.question', message: 'What would you like to learn?' })}
          value={question}
          onChange={setQuestion}
        />
        <Button type="submit" isDisabled={busy || !question.trim()}>
          <Trans id="demo.help.search">Search help</Trans>
        </Button>
      </form>
      <div aria-live="polite">
        {answer?.length === 0 && (
          <p>
            {t({
              id: 'demo.help.noMatch',
              message: 'I couldn’t find a matching help topic.  Open Help to browse the documentation.',
            })}
          </p>
        )}
        {answer?.map((passage) => (
          <article key={passage.id}>
            <Link to="." search={(previous) => ({ ...previous, help: passage.id })}>
              {passage.title}
            </Link>
            <p>{passage.text}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}
