import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Select, ListBoxItem } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  fieldsOverlap,
  idsOf,
  SignatureRequestInput,
  type AttachmentMeta,
  type FieldMeta,
  type RowData,
  SignatureField,
} from '@riosoma/contracts';
import { Banner, Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { api, apiFile, ApiError } from '../../api';
import { isDemoSession } from '../../demo';
import { useServerMessage } from '../../messages/useServerMessage';
import { signatureKinds } from './messages';
import './signatures.css';

function PdfPreview({ blob }: { blob: Blob | undefined }) {
  const { t } = useLingui();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!blob || !frame.current) return;
    const url = URL.createObjectURL(blob);
    frame.current.src = `${url}#toolbar=0&navpanes=0&view=Fit`;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return <iframe ref={frame} title={t({ id: 'signatures.placer.preview', message: 'Document preview' })} />;
}

export function RequestDialog({
  tableId,
  row,
  fields: recordFields,
  attachments,
  onClose,
}: {
  tableId: string;
  row: RowData;
  fields: readonly FieldMeta[];
  attachments?: ReadonlyMap<string, AttachmentMeta>;
  onClose(): void;
}) {
  const { t, i18n } = useLingui();
  const demo = isDemoSession();
  const messageFor = useServerMessage();
  const choices = recordFields
    .filter((field) => field.type === 'attachment')
    .flatMap((field) =>
      idsOf(row.values[field.id] ?? null).flatMap((id) => {
        const file = attachments?.get(id);
        return file?.type === 'application/pdf' && file.scanState === 'clean' ? [file] : [];
      }),
    );
  const [attachmentId, setAttachmentId] = useState(choices[0]?.id ?? '');
  const [signers, setSigners] = useState([{ name: '', email: '' }]);
  const [order, setOrder] = useState<'parallel' | 'sequential'>('parallel');
  const [message, setMessage] = useState('');
  const [due, setDue] = useState('');
  const [statusFieldId, setStatusFieldId] = useState('');
  const [statusValue, setStatusValue] = useState('');
  const [dateFieldId, setDateFieldId] = useState('');
  const [fields, setFields] = useState<SignatureField[]>([]);
  const [page, setPage] = useState(0);
  const [kind, setKind] = useState<SignatureField['kind']>('signature');
  const [signer, setSigner] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [overlap, setOverlap] = useState(false);
  const base = `/api/tables/${tableId}/records/${row.id}`;
  const pages = useQuery({
    queryKey: ['signature-document', tableId, row.id, attachmentId],
    queryFn: () =>
      api<{ pages: Array<{ width: number; height: number }> }>(
        `${base}/signature-document?attachmentId=${attachmentId}`,
      ),
    enabled: !demo && Boolean(attachmentId),
    retry: false,
  });
  const send = useMutation({
    mutationFn: (input: SignatureRequestInput) =>
      api(`${base}/signature-requests`, { method: 'POST', body: input }),
    onSuccess: onClose,
  });
  const documentPreview = useQuery({
    queryKey: ['signature-preview', tableId, row.id, attachmentId, page, fields],
    queryFn: ({ signal }) =>
      apiFile(`${base}/signature-preview`, {
        method: 'POST',
        body: { attachmentId, page, fields },
        signal,
      }),
    enabled: !demo && Boolean(pages.data) && fields.every((field) => SignatureField.safeParse(field).success),
    retry: false,
  });
  const active = fields.find((field) => field.id === selected);
  const file = choices.find((file) => file.id === attachmentId);
  const size = pages.data?.pages[page];
  const statusField = recordFields.find((field) => field.id === statusFieldId);
  const failure = pages.error ?? documentPreview.error ?? send.error;
  function add(x = 0.1, y = 0.1) {
    const field: SignatureField = {
      id: crypto.randomUUID(),
      signer,
      kind,
      page,
      x: Math.min(0.72, Math.max(0, x)),
      y: Math.min(0.93, Math.max(0, y)),
      width: 0.28,
      height: 0.07,
    };
    // Fields never overlap, so one signer's answer can't cover another's.
    const overlaps = fields.some((other) => fieldsOverlap(other, field));
    setOverlap(overlaps);
    if (overlaps) return;
    setFields([...fields, field]);
    setSelected(field.id);
  }
  function edit(patch: Partial<SignatureField>) {
    const next = fields.map((field) => (field.id === selected ? { ...field, ...patch } : field));
    const changed = next.find((field) => field.id === selected);
    const overlaps = Boolean(
      changed && next.some((other) => other.id !== changed.id && fieldsOverlap(other, changed)),
    );
    setOverlap(overlaps);
    if (!overlaps) setFields(next);
  }
  return (
    <Modal
      isOpen
      isDismissable={!send.isPending}
      size="lg"
      className="rio-signatures__modal"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'signatures.request.title', message: 'Request signatures' })}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const input = SignatureRequestInput.safeParse({
              attachmentId,
              signers,
              order,
              fields,
              message,
              dueAt: due ? new Date(due).toISOString() : null,
              statusFieldId: statusFieldId || null,
              statusValue,
              dateFieldId: dateFieldId || null,
            });
            setInvalid(!input.success);
            if (input.success) send.mutate(input.data);
          }}
        >
          <DialogBody className="rio-signatures">
            {failure && (
              <Banner tone="danger">
                {failure instanceof ApiError
                  ? messageFor(failure.info.messageKey, failure.info.params)
                  : messageFor('errors.internal')}
              </Banner>
            )}
            {invalid && <Banner tone="danger">{messageFor('signatures.invalid')}</Banner>}
            {overlap && <Banner tone="danger">{messageFor('signatures.overlap')}</Banner>}
            <div>
              {choices.length > 10 ? (
                <Select
                  label={t({ id: 'signatures.request.document', message: 'PDF attachment' })}
                  selectedKey={attachmentId}
                  onSelectionChange={(key) => {
                    setAttachmentId(String(key ?? ''));
                    setFields([]);
                    setPage(0);
                  }}
                >
                  {choices.map((file) => (
                    <ListBoxItem key={file.id} id={file.id}>
                      {file.name}
                    </ListBoxItem>
                  ))}
                </Select>
              ) : (
                <label>
                  {t({ id: 'signatures.request.document', message: 'PDF attachment' })}
                  <select
                    value={attachmentId}
                    onChange={(event) => {
                      setAttachmentId(event.target.value);
                      setFields([]);
                      setPage(0);
                    }}
                  >
                    {choices.map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {!choices.length && (
              <Banner>
                {t({
                  id: 'signatures.request.noPdf',
                  message:
                    'Attach a PDF to this record and wait for its file scan before requesting signatures.',
                })}
              </Banner>
            )}
            {signers.map((person, index) => (
              <fieldset key={index}>
                <legend>
                  {t({ id: 'signatures.request.signerNumber', message: `Signer ${index + 1}` })}
                </legend>
                <label>
                  {t({ id: 'signatures.request.name', message: 'Full name' })}
                  <input
                    required
                    maxLength={120}
                    value={person.name}
                    onChange={(event) =>
                      setSigners(
                        signers.map((value, i) =>
                          i === index ? { ...value, name: event.target.value } : value,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  {t({ id: 'signatures.request.email', message: 'Email address' })}
                  <input
                    required
                    type="email"
                    maxLength={254}
                    value={person.email}
                    onChange={(event) =>
                      setSigners(
                        signers.map((value, i) =>
                          i === index ? { ...value, email: event.target.value } : value,
                        ),
                      )
                    }
                  />
                </label>
                {signers.length > 1 && (
                  <Button
                    onPress={() => {
                      setSigners(signers.filter((_, i) => i !== index));
                      setFields(
                        fields
                          .filter((field) => field.signer !== index)
                          .map((field) => ({
                            ...field,
                            signer: field.signer > index ? field.signer - 1 : field.signer,
                          })),
                      );
                      setSigner(0);
                    }}
                    aria-label={t({ id: 'signatures.request.removeSigner', message: 'Remove signer' })}
                    icon={faXmark}
                  />
                )}
              </fieldset>
            ))}
            <Button
              isDisabled={signers.length >= 20}
              onPress={() => setSigners([...signers, { name: '', email: '' }])}
              aria-label={t({ id: 'signatures.request.addSigner', message: 'Add signer' })}
              icon={faPlus}
            />
            <label>
              {t({ id: 'signatures.request.order', message: 'Signing order' })}
              <select value={order} onChange={(event) => setOrder(event.target.value as typeof order)}>
                <option value="parallel">
                  {t({ id: 'signatures.request.parallel', message: 'All at once' })}
                </option>
                <option value="sequential">
                  {t({
                    id: 'signatures.request.sequential',
                    message: 'One after another, in the order above',
                  })}
                </option>
              </select>
            </label>
            <label>
              {t({ id: 'signatures.request.message', message: 'Message for signers' })}
              <textarea
                value={message}
                maxLength={4000}
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
            <label>
              {t({ id: 'signatures.request.due', message: 'Due date and time' })}
              <input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
            <p>
              {t({
                id: 'signatures.request.defaultExpiry',
                message: 'Without a due date, signing links expire in 30 days.',
              })}
            </p>
            <div>
              {recordFields.length > 10 ? (
                <Select
                  label={t({
                    id: 'signatures.request.statusField',
                    message: 'Set a status field when completed',
                  })}
                  selectedKey={statusFieldId}
                  onSelectionChange={(key) => {
                    setStatusFieldId(String(key ?? ''));
                    setStatusValue('');
                  }}
                >
                  <ListBoxItem id="">
                    {t({ id: 'signatures.request.noField', message: 'No field' })}
                  </ListBoxItem>
                  {recordFields
                    .filter((field) => field.type === 'text' || field.type === 'singleSelect')
                    .map((field) => (
                      <ListBoxItem key={field.id} id={field.id}>
                        {field.name}
                      </ListBoxItem>
                    ))}
                </Select>
              ) : (
                <label>
                  {t({ id: 'signatures.request.statusField', message: 'Set a status field when completed' })}
                  <select
                    value={statusFieldId}
                    onChange={(event) => {
                      setStatusFieldId(event.target.value);
                      setStatusValue('');
                    }}
                  >
                    <option value="">{t({ id: 'signatures.request.noField', message: 'No field' })}</option>
                    {recordFields
                      .filter((field) => field.type === 'text' || field.type === 'singleSelect')
                      .map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            {statusFieldId && (
              <div>
                {statusField?.type === 'singleSelect' ? (
                  statusField.options.choices.length > 10 ? (
                    <Select
                      label={t({ id: 'signatures.request.statusValue', message: 'Completed status' })}
                      isRequired
                      selectedKey={statusValue}
                      onSelectionChange={(key) => setStatusValue(String(key ?? ''))}
                    >
                      <ListBoxItem id="">
                        {t({ id: 'signatures.request.chooseStatus', message: 'Choose a status' })}
                      </ListBoxItem>
                      {statusField.options.choices.map((choice) => (
                        <ListBoxItem key={choice.id} id={choice.id}>
                          {choice.name}
                        </ListBoxItem>
                      ))}
                    </Select>
                  ) : (
                    <label>
                      {t({ id: 'signatures.request.statusValue', message: 'Completed status' })}
                      <select
                        required
                        value={statusValue}
                        onChange={(event) => setStatusValue(event.target.value)}
                      >
                        <option value="">
                          {t({ id: 'signatures.request.chooseStatus', message: 'Choose a status' })}
                        </option>
                        {statusField.options.choices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                ) : (
                  <label>
                    {t({ id: 'signatures.request.statusValue', message: 'Completed status' })}
                    <input
                      required
                      value={statusValue}
                      maxLength={200}
                      onChange={(event) => setStatusValue(event.target.value)}
                    />
                  </label>
                )}
              </div>
            )}
            <div>
              {recordFields.length > 10 ? (
                <Select
                  label={t({
                    id: 'signatures.request.dateField',
                    message: 'Set a completion date field',
                  })}
                  selectedKey={dateFieldId}
                  onSelectionChange={(key) => setDateFieldId(String(key ?? ''))}
                >
                  <ListBoxItem id="">
                    {t({ id: 'signatures.request.noField', message: 'No field' })}
                  </ListBoxItem>
                  {recordFields
                    .filter((field) => field.type === 'date')
                    .map((field) => (
                      <ListBoxItem key={field.id} id={field.id}>
                        {field.name}
                      </ListBoxItem>
                    ))}
                </Select>
              ) : (
                <label>
                  {t({ id: 'signatures.request.dateField', message: 'Set a completion date field' })}
                  <select value={dateFieldId} onChange={(event) => setDateFieldId(event.target.value)}>
                    <option value="">{t({ id: 'signatures.request.noField', message: 'No field' })}</option>
                    {recordFields
                      .filter((field) => field.type === 'date')
                      .map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            {size && file && (
              <>
                <h3>{t({ id: 'signatures.placer.title', message: 'Place signing fields' })}</h3>
                <p>
                  {t({
                    id: 'signatures.placer.help',
                    message:
                      'Choose a signer and field, then click the page to place it.  You can also add a field with the button and adjust its position below.',
                  })}
                </p>
                <label>
                  {t({ id: 'signatures.placer.page', message: 'Page' })}
                  <select value={page} onChange={(event) => setPage(Number(event.target.value))}>
                    {pages.data!.pages.map((_, index) => (
                      <option key={index} value={index}>
                        {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t({ id: 'signatures.placer.assigned', message: 'Assigned signer' })}
                  <select value={signer} onChange={(event) => setSigner(Number(event.target.value))}>
                    {signers.map((person, index) => (
                      <option key={index} value={index}>
                        {person.name || index + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t({ id: 'signatures.placer.kind', message: 'Field type' })}
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as SignatureField['kind'])}
                  >
                    {Object.entries(signatureKinds).map(([key, descriptor]) => (
                      <option key={key} value={key}>
                        {i18n._(descriptor)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  isDisabled={fields.length >= 200}
                  onPress={() => add()}
                  aria-label={t({ id: 'signatures.placer.add', message: 'Add field' })}
                  icon={faPlus}
                />
                <div
                  className="rio-signatures__page"
                  style={{ aspectRatio: `${size.width} / ${size.height}` }}
                >
                  <PdfPreview blob={documentPreview.data?.blob} />
                  <div
                    className="rio-signatures__placement"
                    onPointerDown={(event) => {
                      if (event.target !== event.currentTarget || fields.length >= 200) return;
                      const box = event.currentTarget.getBoundingClientRect();
                      add((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
                    }}
                  />
                </div>
                <ol>
                  {fields.map(
                    (field, index) =>
                      field.page === page && (
                        <li key={field.id} value={index + 1}>
                          <Button aria-pressed={field.id === selected} onPress={() => setSelected(field.id)}>
                            {i18n._(signatureKinds[field.kind])} {signers[field.signer]?.name}
                          </Button>
                        </li>
                      ),
                  )}
                </ol>
                {active && (
                  <fieldset>
                    <legend>{t({ id: 'signatures.placer.adjust', message: 'Adjust selected field' })}</legend>
                    {(['x', 'y', 'width', 'height'] as const).map((coordinate) => (
                      <label key={coordinate}>
                        {coordinate === 'x'
                          ? t({ id: 'signatures.placer.x', message: 'Left (%)' })
                          : coordinate === 'y'
                            ? t({ id: 'signatures.placer.y', message: 'Top (%)' })
                            : coordinate === 'width'
                              ? t({ id: 'signatures.placer.width', message: 'Width (%)' })
                              : t({ id: 'signatures.placer.height', message: 'Height (%)' })}
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={Math.round(active[coordinate] * 1000) / 10}
                          onChange={(event) => edit({ [coordinate]: Number(event.target.value) / 100 })}
                        />
                      </label>
                    ))}
                    <Button
                      onPress={() => {
                        setFields(fields.filter((field) => field.id !== selected));
                        setSelected(null);
                        setOverlap(false);
                      }}
                      aria-label={t({ id: 'signatures.placer.remove', message: 'Remove field' })}
                      icon={faXmark}
                    />
                  </fieldset>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="submit"
              variant="primary"
              isPending={send.isPending}
              isDisabled={!fields.length || !pages.data}
            >
              {t({ id: 'signatures.request.send', message: 'Send signature request' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
