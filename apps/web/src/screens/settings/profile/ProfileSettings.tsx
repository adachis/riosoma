import { useRef, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { ChangeEmail, type PersonalProfile, type OrganizationCommandResult } from '@riosoma/contracts';
import {
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Form,
  Modal,
  Spinner,
  Text,
  TextField,
  Tooltip,
  TooltipTrigger,
  toast,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { Setting, defineSettingsPage } from '../Setting';
import { useSettingsSection, useSettingsStoredAction } from '../SettingsDraft';
import { setAdminSearch, useAdminSearch } from '../admin-search';
import { PictureCrop } from './PictureCrop';
import './ProfileSettings.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'profile',
  label: msg({ id: 'settings.nav.profile', message: 'Profile' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.profile',
    message: 'profile name picture avatar email account',
  }),
});
export const profileQuery = {
  queryKey: ['me', 'profile'],
  queryFn: () => api<PersonalProfile>('/api/me/profile'),
};

export function ProfileSettings() {
  const { t } = useLingui();
  const person = useSession();
  const message = useServerMessage();
  const cache = useQueryClient();
  const search = useAdminSearch();
  const storedAction = useSettingsStoredAction();
  const current = useQuery(profileQuery);
  const [name, setName] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null | undefined>();
  const [crop, setCrop] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const saved = current.data;
  const save = useMutation({
    mutationFn: () =>
      api<OrganizationCommandResult>('/api/me/profile', {
        method: 'PATCH',
        body: {
          revision: saved?.revision,
          ...(name === null ? {} : { name: name.trim() }),
          ...(picture === undefined ? {} : { picture }),
        },
      }),
    onSuccess: async (result) => {
      if (result.profile) cache.setQueryData(profileQuery.queryKey, result.profile);
      if (result.undoable)
        toast.show({
          tone: 'success',
          title: t({ id: 'profile.saved', message: 'Profile saved' }),
          action: {
            label: t({ id: 'people.actions.undo', message: 'Undo' }),
            onPress: () => {
              void api<OrganizationCommandResult>('/api/me/profile/undo', {
                body: { eventId: result.eventId },
              })
                .then((undone) => {
                  if (undone.profile) cache.setQueryData(profileQuery.queryKey, undone.profile);
                })
                .catch((error: unknown) => {
                  const info = errorInfo(error);
                  toast.show({
                    tone: 'danger',
                    title: message(info?.key ?? 'errors.internal', info?.params),
                  });
                });
            },
          },
        });
      setName(null);
      setPicture(undefined);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['session'] }),
        cache.invalidateQueries({ queryKey: ['org'] }),
      ]);
    },
  });
  const shownName = name ?? saved?.name ?? '';
  const draft = useSettingsSection({
    stored: saved,
    dirty: Boolean(saved && (shownName.trim() !== saved.name || picture !== undefined)),
    validate: () =>
      shownName.trim().length > 0 && shownName.trim().length <= 120
        ? null
        : t({ id: 'profile.name.invalid', message: 'Enter a display name between 1 and 120 characters.' }),
    discard: () => {
      setName(null);
      setPicture(undefined);
    },
    save: () => save.mutateAsync(),
  });
  if (current.isPending)
    return <Spinner label={t({ id: 'profile.loading', message: 'Loading your profile' })} />;
  if (!saved) return <ErrorBanner error={errorInfo(current.error)} />;
  const managed = (field: 'name' | 'email' | 'picture') => saved.managedFields.includes(field);
  const add = t({ id: 'profile.picture.upload', message: 'Upload a profile picture' });
  const remove = t({ id: 'profile.picture.remove', message: 'Remove profile picture' });
  const url = picture === undefined ? saved.pictureUrl : picture;
  return (
    <div className="rio-profile">
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void draft.save?.();
        }}
      >
        <Setting page={settingsPage} id="name" label={msg({ id: 'profile.name', message: 'Display name' })}>
          <TextField
            label={t({ id: 'profile.name', message: 'Display name' })}
            value={shownName}
            onChange={setName}
            isRequired
            maxLength={120}
            isDisabled={managed('name') || save.isPending}
          />
          {managed('name') ? (
            <Text>
              <Trans id="profile.field.managed">Your organization manages this field.</Trans>
            </Text>
          ) : null}
        </Setting>
        <Setting
          page={settingsPage}
          id="picture"
          label={msg({ id: 'profile.picture', message: 'Profile picture' })}
        >
          <Text>
            <Trans id="profile.picture">Profile picture</Trans>
          </Text>
          <div className="rio-profile__picture">
            <Avatar name={shownName || saved.email} pictureUrl={url} color="blue" />
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={add}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                setUploadError(
                  Boolean(
                    file &&
                    (file.size > 2_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)),
                  ),
                );
                if (
                  file &&
                  file.size <= 2_000_000 &&
                  ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
                )
                  setCrop(file);
              }}
            />
            <TooltipTrigger>
              <Button
                icon={faPlus}
                aria-label={add}
                variant="quiet"
                isDisabled={managed('picture') || save.isPending}
                onPress={() => input.current?.click()}
              />
              <Tooltip>{add}</Tooltip>
            </TooltipTrigger>
            <TooltipTrigger>
              <Button
                icon={faTrash}
                aria-label={remove}
                variant="quiet"
                isDisabled={managed('picture') || !url || save.isPending}
                onPress={() => setPicture(null)}
              />
              <Tooltip>{remove}</Tooltip>
            </TooltipTrigger>
          </div>
          {managed('picture') ? (
            <Text>
              <Trans id="profile.field.managed">Your organization manages this field.</Trans>
            </Text>
          ) : null}
          {uploadError ? (
            <Text role="alert">
              <Trans id="profile.picture.invalid">
                Choose a square PNG, JPEG, or WebP picture under 2 MB that your installation accepts.
              </Trans>
            </Text>
          ) : null}
        </Setting>
        <Setting
          page={settingsPage}
          id="email"
          label={msg({ id: 'profile.email', message: 'Email address' })}
        >
          <TextField
            label={t({ id: 'profile.email', message: 'Email address' })}
            value={saved.email}
            isReadOnly
          />
          <Text>
            {managed('email')
              ? t({ id: 'profile.field.managed', message: 'Your organization manages this field.' })
              : saved.emailChangeAllowed
                ? t({
                    id: 'profile.email.help',
                    message:
                      'Confirm a new address through its emailed link before it takes effect.  Your old address receives a notice.',
                  })
                : t({
                    id: 'profile.email.unavailable',
                    message:
                      'This installation cannot send email confirmation links.  Ask your administrator to change your address.',
                  })}
          </Text>
        </Setting>
        <ErrorBanner error={errorInfo(current.error ?? save.error)} />
      </Form>
      {saved.emailChangeAllowed ? (
        <Button
          onPress={() => {
            if (storedAction()) setAdminSearch({ edit: 'email' });
          }}
        >
          <Trans id="profile.email.change">Change email address</Trans>
        </Button>
      ) : null}
      {crop ? (
        <PictureCrop
          file={crop}
          onClose={() => setCrop(null)}
          onCrop={(picture) => {
            setPicture(picture);
            setCrop(null);
          }}
        />
      ) : null}
      {(search.get('edit') === 'email' || search.has('emailToken')) && saved.emailChangeAllowed && person ? (
        <EmailDialog
          token={search.get('emailToken')}
          onClose={() => setAdminSearch({ edit: undefined, emailToken: undefined })}
        />
      ) : null}
    </div>
  );
}

function EmailDialog({ token, onClose }: { token: string | null; onClose(): void }) {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [email, setEmail] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api(token ? '/api/me/profile/email/confirm' : '/api/me/profile/email', {
        body: token ? { token } : ChangeEmail.parse({ email }),
      }),
    onSuccess: async () => {
      if (token) {
        onClose();
        await Promise.all([
          cache.invalidateQueries(profileQuery),
          cache.invalidateQueries({ queryKey: ['session'] }),
        ]);
      }
    },
  });
  return (
    <Modal
      isOpen
      size="sm"
      isDismissable={!run.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          {token
            ? t({ id: 'profile.email.confirm', message: 'Confirm your new email address' })
            : t({ id: 'profile.email.change', message: 'Change email address' })}
        </DialogTitle>
        <DialogBody>
          {token ? (
            <p>
              <Trans id="profile.email.confirmBody">Use this confirmed address for your account.</Trans>
            </p>
          ) : (
            <TextField
              type="email"
              label={t({ id: 'profile.email.new', message: 'New email address' })}
              value={email}
              onChange={setEmail}
            />
          )}
          {run.isSuccess ? (
            <p role="status">
              <Trans id="profile.email.sent">Check your new address for the confirmation link.</Trans>
            </p>
          ) : null}
          <ErrorBanner error={errorInfo(run.error)} />
        </DialogBody>
        <DialogFooter>
          <Button onPress={onClose} isDisabled={run.isPending}>
            {t({ id: 'ui.confirm.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            isPending={run.isPending}
            isDisabled={!token && (!ChangeEmail.safeParse({ email }).success || run.isSuccess)}
            onPress={() => run.mutate()}
          >
            {token
              ? t({ id: 'profile.email.confirm', message: 'Confirm your new email address' })
              : t({ id: 'profile.email.send', message: 'Send confirmation link' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
