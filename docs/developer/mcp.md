# MCP request limits

Riosoma’s Streamable HTTP endpoint at `/mcp` admits **120 requests per rolling minute per token** by default.  The database shares the count across replicas.  Personal tokens have separate allowances.  OAuth installations retain their allowance across access-token refreshes.  Initialization, notifications, and other authenticated MCP requests count toward the same allowance as tool calls.

Owners and Integrations administrators change the default on **MCP** in settings and save with the page’s save bar.  **No limit** disables enforcement.  A per-app override takes precedence, including an explicit **No limit** override.  Connected app activity shows all requests in the last rolling minute and refused requests in the last 24 hours.  These settings follow organization-wide OAuth administration.

Before dispatching a request that exceeds its allowance, the server returns HTTP `429` with a `Retry-After` header in whole seconds.  No tool work starts.  The JSON-RPC error uses server error code `-32000`, uses a null request ID because the body has not been read, and includes a plain English message stating the limit and retry delay.  Error data includes `code: "rate_limited"`, `messageKey: "mcp.rateLimited"`, and `params: { limit, seconds }`.

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32000,
    "message": "The MCP limit is 120 calls per minute.  Retry in 12 seconds.",
    "data": {
      "code": "rate_limited",
      "messageKey": "mcp.rateLimited",
      "params": { "limit": 120, "seconds": 12 }
    }
  }
}
```

Honor `Retry-After` before retrying.  Refusals do not consume admission slots or push back their expiry.  Requests from other tokens continue independently.  Audit events are limited to one per token in a rolling minute, while activity counts every refusal.  Counters use the existing database-backed auth mechanism.  Each request prunes that token’s admissions older than a minute and refusals older than a day.  Existing auth cleanup also removes old counters.  No additional infrastructure or schema migration is required.
