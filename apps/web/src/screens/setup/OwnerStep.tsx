import { Trans, useLingui } from '@lingui/react/macro';
import { useState, type FormEvent } from 'react';
import { DEFAULT_LEVEL, LEVELS, PASSWORD_MIN_LENGTH, type Level } from '@riosoma/contracts';
import {
  Button,
  Form,
  FormActions,
  Heading,
  PasswordField,
  Radio,
  RadioGroup,
  Switch,
  Text,
  TextField,
} from '@riosoma/ui';
import { LEVEL_NAMES, LEVEL_SUMMARIES } from '../../levels/words';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo, type useSetupFlow } from './useSetup';

export function OwnerStep({
  flow,
  defaultLocale,
}: {
  flow: ReturnType<typeof useSetupFlow>;
  defaultLocale: string;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const [orgName, setOrgName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const min = PASSWORD_MIN_LENGTH;

  const error = errorInfo(flow.createOwner.error);
  const values = { orgName, name, email, password };
  const fieldError = (path: keyof typeof values) => {
    const key = error?.fields?.[path];
    // A rejected value must not keep its replacement invalid.
    return key && flow.createOwner.variables?.[path] === values[path] ? message(key) : undefined;
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    flow.createOwner.mutate(
      // Keeping Standard makes no choice, so the owner follows the organization's default.
      {
        orgName,
        name,
        email,
        password,
        locale: defaultLocale,
        ...(level !== DEFAULT_LEVEL ? { level } : {}),
      },
      // Setup goes on to the usage counts step, which then leads home or to the import.
    );
  };

  return (
    <Form onSubmit={onSubmit}>
      <Heading level={1} data-anchor="setup.owner">
        <Trans id="setup.owner.title">Create the owner account</Trans>
      </Heading>
      <Text>
        <Trans id="setup.owner.body">
          The owner can do everything, including choosing who else helps run this server.
        </Trans>
      </Text>
      <TextField
        label={t({ id: 'setup.owner.orgName', message: 'Organization name' })}
        value={orgName}
        onChange={setOrgName}
        isRequired
        autoFocus
        autoComplete="organization"
        errorMessage={fieldError('orgName')}
        isInvalid={Boolean(fieldError('orgName'))}
      />
      <TextField
        label={t({ id: 'setup.owner.name', message: 'Your name' })}
        value={name}
        onChange={setName}
        isRequired
        autoComplete="name"
        errorMessage={fieldError('name')}
        isInvalid={Boolean(fieldError('name'))}
      />
      <TextField
        label={t({ id: 'setup.owner.email', message: 'Email address' })}
        type="email"
        value={email}
        onChange={setEmail}
        isRequired
        autoComplete="email"
        errorMessage={fieldError('email')}
        isInvalid={Boolean(fieldError('email'))}
      />
      <PasswordField
        label={t({ id: 'setup.owner.password', message: 'Password' })}
        description={t({
          id: 'setup.owner.passwordHelp',
          message: `At least ${min} characters. A few unrelated words make a strong one.`,
        })}
        value={password}
        onChange={setPassword}
        isRequired
        minLength={PASSWORD_MIN_LENGTH}
        autoComplete="new-password"
        errorMessage={fieldError('password')}
        isInvalid={Boolean(fieldError('password'))}
      />
      <RadioGroup
        label={t({ id: 'levels.settings.label', message: 'How much to show' })}
        description={t({ id: 'join.level.help', message: 'You can change this anytime in your settings.' })}
        value={level}
        onChange={(value) => {
          const next = LEVELS.find((item) => item === value);
          if (next) setLevel(next);
        }}
      >
        {LEVELS.map((choice) => (
          <Radio key={choice} value={choice} description={i18n._(LEVEL_SUMMARIES[choice])}>
            {i18n._(LEVEL_NAMES[choice])}
          </Radio>
        ))}
      </RadioGroup>
      {error && !error.fields ? <ErrorBanner error={error} /> : null}
      <Switch isSelected={flow.importRequested} onChange={flow.setImportRequested}>
        <Trans id="organizationArchive.setupImport">
          Import an organization archive after creating the owner account
        </Trans>
      </Switch>
      <FormActions>
        <Button type="submit" variant="primary" isPending={flow.createOwner.isPending}>
          <Trans id="setup.owner.submit">Create account</Trans>
        </Button>
      </FormActions>
    </Form>
  );
}
