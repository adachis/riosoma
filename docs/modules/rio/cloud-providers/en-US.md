---
id: cloud-providers
title: Cloud model providers
summary: Configure hosted conversation services and discover models for specialized work.
area: rio
order: 6
level: advanced
anchors: [ai.providers, ai.key, ai.key.replace, ai.key.remove, ai.test, ai.test.unverified, settings.ai]
related: [asking-rio, ai-footprint]
routes: [/settings/ai, /settings/*/ai, /admin/*/ai]
sections: [settings.ai=connect-an-ai-gateway]
---

Open AI settings at `/settings/ai` to review {{ui:ai.providers}}.  Existing organization permissions and provider consent apply to cloud conversations.  Store a provider's credential under {{ui:ai.key}}.  Organization endpoint settings use the existing `providers[].baseUrl` REST field.  A stored key belongs to the endpoint it was saved for, so a change to that field has to carry the key again in the same request.  A key set in the server's environment is only ever sent to the provider's own endpoint, and the field can't be set for that provider.

Enter a key and turn on the provider in the same draft.  The {{ui:ai.enabled}} switch, provider consent, keys, and the other settings stay local until you choose {{ui:settings.draft.save}} in the save bar at the bottom of the page.  A provider that needs a key cannot be enabled without one.  Choose {{ui:settings.draft.discard}} to restore the stored values.  Leaving with changes offers {{ui:settings.draft.saveContinue}}, {{ui:settings.draft.discardContinue}}, or {{ui:settings.draft.keep}}.  {{keys:settings.save}} saves the page from the keyboard.

Use {{ui:ai.key.replace}} to enter a different key and {{ui:ai.key.remove}} to delete the stored key.  Replacing a key edits the page draft; choose {{ui:settings.draft.save}} in the save bar to store it.  Removing a key takes effect immediately.

Help links open beside the settings page and preserve edits.  Choose {{ui:docs.close}} to return to the form.  A link that leaves the page asks before discarding unsaved settings.  Choose {{ui:settings.draft.keep}} to keep the edits or {{ui:settings.draft.discardContinue}} to continue.

Bedrock uses [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html) and accepts a runtime bearer key.  Set the endpoint to `https://bedrock-runtime.REGION.amazonaws.com`.  A host can instead supply temporary identity credentials through the adapter's `aws` configuration.  Converse returns the full reply before yielding text, tool calls, usage, and its stop reason.

Vertex uses a bearer access token and a project endpoint ending in `/v1/projects/PROJECT/locations/LOCATION/publishers/google`.  Tokens expire.  The host must refresh them.  Catalog checks count tokens without generating a reply.  The shared conversation format preserves tool signatures, documents, and images.

Azure uses an account endpoint ending in `/openai/deployments/DEPLOYMENT`.  The deployment name is the model reference, including when the underlying model has a different name.  Hosts can also supply an account root and a list of deployment names.  Discovery checks the data catalog.  It does not provision or enumerate management-plane deployments.

FAL exposes a [queue](https://fal.ai/docs/documentation/model-apis/inference/queue) for later media features: submit, status, result, and cancel.  Submission is never retried automatically because an accepted request can outlive a network failure.  Cancellation requests may arrive after processing has started.  The adapter constructs request-management addresses itself and never follows returned addresses with credentials.  Connecting a queue provider does not enable media generation.

{{ui:ai.test}} validates credentials when catalog discovery authenticates the account.  Bedrock bearer keys and FAL have curated catalogs, so their connection tests show {{ui:ai.test.unverified}}.  Seeing models in these catalogs does not confirm that a credential works.  Bedrock identity credentials are checked against the authenticated catalog.  Live suites exercise conversations and one small synthetic image.  Run them with `RIOSOMA_TEST_AI_PROVIDER_KEY`, replacing `PROVIDER` with `BEDROCK`, `VERTEX`, `AZURE`, or `FAL`.  `RIOSOMA_TEST_AI_PROVIDER_URL` and `RIOSOMA_TEST_AI_PROVIDER_MODEL` select the account endpoint and model.

The internal registry separates embeddings, OCR, code, image, and video capabilities from Rio's conversation tiers.  Prices remain unknown until confirmed.  The video candidate currently uses the documented LTX 2.3 Fast endpoint.  Switching to LTX 2.5 requires a confirmed endpoint and a live check.  Specialized executors, deployment picking, token refresh, and media consent controls belong to later units.

## Connect an AI gateway

A gateway routes requests to model services through your organization's endpoint and authentication rules.  In AI settings, choose {{ui:ai.gateway.add}}, enter a display name and the base URL containing the API root (for example, `https://gateway.example.com/rio/v1`), and choose bearer authentication, a custom key header, or network authentication with no key.  Keys and extra header values are encrypted and never returned to the browser.  Gateway names, endpoints, keys, headers, and model routes stay in the page draft until you choose {{ui:settings.draft.save}} in the footer.  Saving a new gateway also grants provider consent.  Its consent switch can then turn it off.  {{ui:ai.test}} tests the drafted endpoint and credentials without saving them.  {{ui:settings.draft.discard}} restores the stored configuration.

A stored key and stored header values belong to the base URL they were saved for.  When you change a gateway's base URL, enter the key and each extra header value again before you test, discover models, or save.  Renaming a gateway, changing its models, or changing how the key is sent keeps them.

Choose {{ui:ai.gateway.discover}} to request `/models`.  When discovery is unavailable, add each route's model name and context size yourself.  Map each alias to its known registry model for cost and footprint estimates.  Leave the mapping unknown when routing can select different underlying models: estimates then stay unavailable.  Pick gateway models for Quick answers and Thorough work as usual.  Classification limits, budgets, AI fields, automations, and audit records use the same provider controls.

For Kong OSS, this DB-less configuration attaches `ai-proxy` and `key-auth` to a conversation route.  Replace the example upstream and credentials before deployment.  Rio's base URL is `https://gateway.example.com/rio/v1`, the key mode is Custom header, the header name is `apikey`, and the model alias is `team-chat`.  See the [Kong plugin reference](https://developer.konghq.com/plugins/ai-proxy/reference/) for your gateway version.

```yaml
_format_version: '3.0'
services:
  - name: rio-conversations
    url: http://model-service.internal:8080
    routes:
      - name: rio-chat
        paths: [/rio/v1/chat/completions]
        plugins:
          - name: key-auth
          - name: ai-proxy
            config:
              route_type: llm/v1/chat
              auth:
                header_name: Authorization
                header_value: Bearer REPLACE_UPSTREAM_KEY
              model:
                provider: openai
                name: team-chat
                options:
                  upstream_url: http://model-service.internal:8080/v1/chat/completions
consumers:
  - username: rio
    keyauth_credentials:
      - key: REPLACE_GATEWAY_KEY
```

Kong's AI proxy reads only request bodies that fit in its request buffer, 8 KB by default, and Rio's requests with their tools are larger.  Set `nginx_http_client_body_buffer_size` to at least `1m` (as an environment variable, `KONG_NGINX_HTTP_CLIENT_BODY_BUFFER_SIZE=1m`), or Kong answers every Rio request with "request body doesn't contain valid prompts."

Choose {{ui:ai.test}} to check the connection with Rio's current tool definitions.  Gateway errors in conversations and during {{ui:rio.compact}} tell admins which setting to change and offer {{ui:ai.gateway.openSettings}}.  If a route only allows one model, set that model in the gateway's model list.  A request size error means the gateway's request limit needs to accept larger requests.  Other members see a short service message, and admins receive a notification linked to the gateway's settings.

This route does not expose `/models`; enter `team-chat` manually.  Embeddings need a separate compatible `/embeddings` route under the same base URL.  {{ui:ai.test}} sends one tiny conversation request and reports the round trip time, or explains an unreachable host, TLS problem, rejected key, wrong path, or missing model.

For LiteLLM, define an alias and a master key in its configuration, then start the proxy with `litellm --config gateway.yaml`.  Set Rio's base URL to the proxy's API root, such as `https://gateway.example.com`, and use Authorization: Bearer with its master key.  Discover or enter `team-chat`.  The upstream and proxy credentials are separate.  See [LiteLLM configuration](https://docs.litellm.ai/docs/proxy/configs).

```yaml
model_list:
  - model_name: team-chat
    litellm_params:
      model: openai/team-chat
      api_base: http://model-service.internal:8080/v1
      api_key: os.environ/UPSTREAM_KEY
general_settings:
  master_key: os.environ/GATEWAY_KEY
```
