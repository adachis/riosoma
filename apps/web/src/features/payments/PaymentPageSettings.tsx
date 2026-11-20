import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  PAYMENT_CURRENCIES,
  PaymentSettings,
  paymentDecimals,
  type PaymentPage,
  type FieldMeta,
} from '@riosoma/contracts';
import { Button, Checkbox, Heading, ListBoxItem, Select, TextField } from '@riosoma/ui';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import './payments.css';

type PageProps = { kind: 'form' | 'booking'; targetId: string; fields: readonly FieldMeta[] };

export function PaymentPageSettings(props: PageProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(!open)} aria-expanded={open}>
        {t({ id: 'payments.settings', message: 'Payment settings' })}
      </Button>
      {open && <LoadedSettings {...props} />}
    </>
  );
}

function LoadedSettings({ kind, targetId, fields }: PageProps) {
  const path = `/api/payment-pages/${kind}/${targetId}`;
  const settings = useQuery({
    queryKey: ['payment-page', kind, targetId],
    queryFn: () => api<PaymentPage>(path),
  });
  return (
    <>
      <ErrorBanner error={errorInfo(settings.error)} />
      {settings.data && (
        <Editor
          key={JSON.stringify(settings.data)}
          path={path}
          saved={settings.data.settings}
          fields={fields}
          onSaved={() => void settings.refetch()}
        />
      )}
    </>
  );
}

function Editor({
  path,
  saved,
  fields,
  onSaved,
}: {
  path: string;
  saved: PaymentSettings | null;
  fields: readonly FieldMeta[];
  onSaved(): void;
}) {
  const { t } = useLingui();
  const [enabled, setEnabled] = useState(Boolean(saved));
  const [currency, setCurrency] = useState(saved?.currency ?? 'usd');
  const [source, setSource] = useState(saved?.price.kind === 'option' ? saved.price.fieldId : 'fixed');
  const [amount, setAmount] = useState(saved?.price.kind === 'fixed' ? saved.price.amount : '');
  const [amounts, setAmounts] = useState<Record<string, string>>(
    saved?.price.kind === 'option' ? saved.price.amounts : {},
  );
  const [quantity, setQuantity] = useState(saved?.quantityFieldId ?? 'none');
  const code = currency.toUpperCase();
  const minimum = (PAYMENT_CURRENCIES[currency] / 10 ** paymentDecimals(currency)).toFixed(
    paymentDecimals(currency),
  );
  const field = fields.find((field) => field.id === source);
  const choices = field?.type === 'singleSelect' ? field.options.choices : [];
  const save = useMutation({
    mutationFn: () =>
      api(path, {
        method: 'PUT',
        body: {
          settings: enabled
            ? {
                currency,
                price:
                  source === 'fixed'
                    ? { kind: 'fixed', amount }
                    : {
                        kind: 'option',
                        fieldId: source,
                        amounts: Object.fromEntries(
                          choices.map((choice) => [choice.id, amounts[choice.id] ?? '']),
                        ),
                      },
                quantityFieldId: quantity === 'none' ? null : quantity,
              }
            : null,
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <section className="rio-payments">
      <Heading level={3}>{t({ id: 'payments.page.title', message: 'Payment' })}</Heading>
      <Checkbox isSelected={enabled} onChange={setEnabled}>
        {t({ id: 'payments.required', message: 'Require payment' })}
      </Checkbox>
      {enabled && (
        <>
          <p>
            {t({
              id: 'payments.page.help',
              message:
                'Prices use the currency’s regular units, such as 10.50 USD or 500 JPY.  Price and quantity fields must be questions on this page.  Riosoma adds protected payment result fields when you save.',
            })}
          </p>
          <Select
            label={t({ id: 'payments.currency', message: 'Currency' })}
            selectedKey={currency}
            onSelectionChange={(key) => setCurrency(PaymentSettings.shape.currency.parse(key))}
          >
            {Object.keys(PAYMENT_CURRENCIES).map((code) => (
              <ListBoxItem id={code} key={code}>
                {code.toUpperCase()}
              </ListBoxItem>
            ))}
          </Select>
          <p>
            {t({
              id: 'payments.page.minimum',
              message: `Each price has to be at least ${minimum} ${code}, the smallest amount Stripe charges in that currency.`,
            })}
          </p>
          <Select
            label={t({ id: 'payments.priceSource', message: 'Price' })}
            selectedKey={source}
            onSelectionChange={(key) => setSource(String(key))}
          >
            <ListBoxItem id="fixed">{t({ id: 'payments.fixed', message: 'Fixed price' })}</ListBoxItem>
            {fields
              .filter((field) => field.type === 'singleSelect')
              .map((field) => (
                <ListBoxItem id={field.id} key={field.id}>
                  {field.name}
                </ListBoxItem>
              ))}
          </Select>
          {source === 'fixed' ? (
            <TextField
              label={t({ id: 'payments.amount', message: 'Price amount' })}
              value={amount}
              onChange={setAmount}
            />
          ) : (
            choices.map((choice) => (
              <TextField
                key={choice.id}
                label={choice.name}
                value={amounts[choice.id] ?? ''}
                onChange={(value) => setAmounts({ ...amounts, [choice.id]: value })}
              />
            ))
          )}
          <Select
            label={t({ id: 'payments.quantity', message: 'Quantity field' })}
            selectedKey={quantity}
            onSelectionChange={(key) => setQuantity(String(key))}
          >
            <ListBoxItem id="none">
              {t({ id: 'payments.quantity.one', message: 'One per submission' })}
            </ListBoxItem>
            {fields
              .filter((field) => field.type === 'number')
              .map((field) => (
                <ListBoxItem id={field.id} key={field.id}>
                  {field.name}
                </ListBoxItem>
              ))}
          </Select>
        </>
      )}
      <ErrorBanner error={errorInfo(save.error)} />
      <Button isPending={save.isPending} onPress={() => save.mutate()}>
        {t({ id: 'payments.save', message: 'Save payment settings' })}
      </Button>
    </section>
  );
}
