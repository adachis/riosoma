# Build the outbound Teams flow

This flow receives an automation message and posts it as a Microsoft Copilot Studio agent.  Keep the flow and agent in the same Power Platform environment.  Publish the agent to Teams first, share it with the recipients, and have each recipient install it.

1. Create a cloud flow with the Request trigger When an HTTP request is received.  Paste `trigger.schema.json` into its request body schema.
2. Configure the trigger to accept its signed URL from Riosoma.  Tenant-user-only trigger authentication needs an additional authenticated bridge and is not supported by this step.  Treat the complete signed URL as a secret.
3. Add the Teams action Post message in a chat or channel.  Set Post as to Microsoft Copilot Studio agent, Post in to Chat with agent, and select the published agent.
4. Map `recipient` from the trigger to Recipient.  It normally contains a person's email address.
5. Build the Message from optional `title`, `message`, and `recordUrl`.  Omit the title or link when empty.  These are plain text values.  Escape `&`, `<`, `>`, and quotes before inserting them into Teams HTML.  Do not interpret record text as instructions, expressions, mentions, or HTML.  Validate a link's scheme as HTTPS before making it clickable.
6. Add a Response action after the Teams action succeeds, returning HTTP 200 with an empty JSON object.  Configure a failure path returning HTTP 400 with `{"error":{"code":"InvalidRequestContent"}}`.  Keep provider response bodies, signed URLs, and credentials out of the response.  A trigger's immediate 202 means accepted for processing, not delivered to Teams.  The flow run history is the delivery check if you use 202.
7. Save, copy the trigger's full signed HTTP URL, and paste it into the Riosoma automation step Post through Copilot Studio.  Fill in the recipient, optional title, message, and record link.  Record triggers start with the trigger record's link.  For schedules and incoming webhooks, supply a record link when one exists or leave it empty.
8. Test with an approved recipient, inspect the flow run, and confirm the message in Teams.  Publish and enable the automation after the test succeeds.

The request body is:

```json
{
  "message": "The record is ready for review.",
  "title": "Review requested",
  "recipient": "person@example.invalid",
  "recordUrl": ""
}
```

`message`, `recipient`, and `recordUrl` are always present.  `title` is omitted when empty.  `recordUrl` is empty when there is no associated record.  Riosoma sends JSON strings without adding Teams markup.

A channel reference uses `channel:<team-id>/<channel-id>`.  The flow can validate and route this value.  Microsoft's documented proactive agent action currently supports personal chats only, despite its chat-or-channel action name.  Reject channel references explicitly until your tenant supports agent channel posting, or use the existing Teams Workflows step for channel delivery.  Never report a channel message as delivered when it was dropped.

Riosoma accepts the same HTTPS host suffixes as the Teams Workflows step: subdomains of `environment.api.powerplatform.com`, `logic.azure.com`, and `webhook.office.com`.  Custom ports, embedded credentials, fragments, and unrelated hosts are refused.  The server also checks resolved addresses and does not follow redirects.  The address is sealed outside the automation configuration and never appears in run output.  Only the HTTP status and a recognized provider error code are retained.

HTTP 429 and 5xx responses receive up to two retries.  A response lost after delivery can produce a duplicate, so use a flow-side deduplication rule where repeated messages matter.  Keep trigger and action Secure inputs and Secure outputs enabled if your organization requires message content to remain hidden from flow history.

The live test is skipped without `RIOSOMA_TEST_COPILOT_FLOW_URL`.  Set it only to an owner-approved test trigger, and set `RIOSOMA_TEST_FLOW_RECIPIENT` to the approved recipient.  Without a recipient, the flow must map the reserved `test` value to its approved test chat.  Run `pnpm --filter @riosoma/server exec vitest run src/automations/studio-flow.live.test.ts --maxWorkers=4`.  The test checks acceptance by the trigger.  Confirm final delivery in the flow history and Teams separately.

See [Microsoft's proactive messaging requirements](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-proactive-message).
