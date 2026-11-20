import { REST_LIMITS } from '@riosoma/contracts';
import { Trans, useLingui } from '@lingui/react/macro';
import { NumberField, Radio, RadioGroup, Switch, TextArea, TextField } from '@riosoma/ui';
import type { SourceConnectionFormProps } from './SourceConnectionForm';

export function NoSqlConnectionForm({
  kind,
  values,
  onChange,
  fieldError,
  isDisabled,
}: SourceConnectionFormProps) {
  const { t } = useLingui();
  const state = (name: string) => ({
    isDisabled,
    isInvalid: Boolean(fieldError(name)),
    errorMessage: fieldError(name),
  });
  return (
    <>
      <TextField
        label={t({ id: 'sources.nosql.endpoint', message: 'Service address' })}
        description={t({
          id: 'sources.nosql.endpointHint',
          message:
            'The HTTP or HTTPS address of the service.  Leave blank for the standard DynamoDB or Firestore address.',
        })}
        value={values.endpoint}
        onChange={(endpoint) => onChange({ endpoint })}
        isRequired={!['dynamodb', 'firestore'].includes(kind) || values.emulator}
        {...state('endpoint')}
      />
      {kind === 'dynamodb' && (
        <>
          <TextField
            label={t({ id: 'sources.field.region', message: 'Region' })}
            value={values.region}
            onChange={(region) => onChange({ region })}
            isRequired
            {...state('region')}
          />
          <NumberField
            label={t({ id: 'sources.nosql.segments', message: 'Parallel scan segments' })}
            value={values.segments}
            minValue={1}
            maxValue={16}
            onChange={(segments) => onChange({ segments })}
            {...state('segments')}
          />
        </>
      )}
      {(kind === 'couchdb' || kind === 'couchbase') && (
        <TextField
          label={t({ id: 'sources.field.user', message: 'User' })}
          value={values.user}
          onChange={(user) => onChange({ user })}
          isRequired
          {...state('user')}
        />
      )}
      {(kind === 'firestore' || kind === 'cosmosdb') && (
        <TextField
          label={t({ id: 'sources.field.database', message: 'Database' })}
          value={values.database}
          onChange={(database) => onChange({ database })}
          isRequired={kind === 'cosmosdb'}
          {...state('database')}
        />
      )}
      {kind === 'firestore' && (
        <>
          <TextField
            label={t({ id: 'sources.nosql.project', message: 'Project ID' })}
            value={values.projectId}
            onChange={(projectId) => onChange({ projectId })}
            isRequired
            {...state('projectId')}
          />
          <Switch
            isSelected={values.emulator}
            onChange={(emulator) => onChange({ emulator })}
            isDisabled={isDisabled}
          >
            <Trans id="sources.nosql.emulator">Use the local emulator</Trans>
          </Switch>
          <TextArea
            label={t({ id: 'sources.nosql.groups', message: 'Collection groups' })}
            description={t({
              id: 'sources.nosql.groupsHint',
              message: 'Optional collection IDs, one per line, to read across parent documents.',
            })}
            value={values.collectionGroups}
            onChange={(collectionGroups) => onChange({ collectionGroups })}
            {...state('collectionGroups')}
          />
        </>
      )}
      {kind === 'cosmosdb' && (
        <RadioGroup
          label={t({ id: 'sources.nosql.auth', message: 'Sign-in method' })}
          value={values.noSqlAuth}
          onChange={(value) => {
            if (value === 'master-key' || value === 'entra') onChange({ noSqlAuth: value });
          }}
          isDisabled={isDisabled}
        >
          <Radio value="master-key">
            <Trans id="sources.nosql.masterKey">Master key</Trans>
          </Radio>
          <Radio value="entra">
            <Trans id="sources.nosql.entra">Entra access token</Trans>
          </Radio>
        </RadioGroup>
      )}
      <NumberField
        label={t({ id: 'sources.nosql.depth', message: 'Nested document levels' })}
        value={values.flattenDepth}
        minValue={0}
        maxValue={REST_LIMITS.flattenDepth}
        onChange={(flattenDepth) => onChange({ flattenDepth })}
        {...state('flattenDepth')}
      />
      <Switch
        isSelected={values.arrays === 'json'}
        onChange={(json) => onChange({ arrays: json ? 'json' : 'text' })}
        isDisabled={isDisabled}
      >
        <Trans id="sources.nosql.arrays">Keep lists as JSON</Trans>
      </Switch>
    </>
  );
}
