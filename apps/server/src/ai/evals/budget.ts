import { AppError } from '@riosoma/contracts';
import type { ChatRequest, ProviderAdapter, ProviderConfig, RegistryModel } from '@riosoma/ai';

const unavailable = () => new AppError('unavailable', 'rio.paused');

/** Compare the same conservative input and output allowance for every eligible candidate. */
export function cheapestModel(models: readonly RegistryModel[], enabled: readonly string[]) {
  return (
    models
      .filter(
        (entry) =>
          enabled.includes(entry.providerId) &&
          entry.tools &&
          entry.price &&
          entry.tiers.includes('everyday') &&
          entry.contextTokens >= 32_000 &&
          (entry.maxOutputTokens ?? 4096) >= 4096 &&
          Number.isFinite(entry.price.input) &&
          entry.price.input >= 0 &&
          Number.isFinite(entry.price.output) &&
          entry.price.output >= 0,
      )
      .sort(
        (a, b) =>
          a.price!.input * 16_000 +
          a.price!.output * 4096 -
          (b.price!.input * 16_000 + b.price!.output * 4096),
      )[0] ?? null
  );
}

/** A failed call keeps its reservation because an incomplete response may still be billed. */
export class EvalBudget {
  chargedUsd = 0;
  constructor(readonly limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw unavailable();
  }

  wrap(adapter: ProviderAdapter, model: RegistryModel): ProviderAdapter['stream'] {
    const original = adapter.stream.bind(adapter);
    return async function* (this: EvalBudget, config: ProviderConfig, request: ChatRequest) {
      const price = model.price;
      if (!price || request.model !== model.model) throw unavailable();
      const input = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }));
      const output = Math.min(request.maxOutputTokens ?? 4096, model.maxOutputTokens ?? 4096);
      const reserve = (input * price.input + output * price.output) / 1_000_000;
      if (this.chargedUsd + reserve > this.limitUsd) throw unavailable();
      this.chargedUsd += reserve;
      let actual = 0;
      let reported = false;
      for await (const part of original(config, {
        ...request,
        maxOutputTokens: output,
        signal: AbortSignal.any([
          request.signal ?? new AbortController().signal,
          AbortSignal.timeout(60_000),
        ]),
      })) {
        if (part.type === 'usage') {
          if (
            ![part.inputTokens, part.outputTokens].every((count) => Number.isSafeInteger(count) && count >= 0)
          )
            throw unavailable();
          actual += (part.inputTokens * price.input + part.outputTokens * price.output) / 1_000_000;
          reported = true;
          if (actual > reserve) throw unavailable();
        }
        yield part;
      }
      if (reported) this.chargedUsd -= reserve - actual;
    }.bind(this);
  }
}
