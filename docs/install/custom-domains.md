# Custom domains for public pages

Keep `RIOSOMA_BASE_URL` pointed at the main signed-in app.  Organization owners and administrators with the Integrations role add hosts under Settings → Custom domains.  Each host needs its own TXT challenge and routes only the selected public page kinds for that organization.  Wildcards, IP addresses, ports, and URL paths cannot be registered as custom domains, and a host can be at most 237 characters, so its TXT record's name fits in DNS.  Each organization can have up to `RIOSOMA_CUSTOM_DOMAIN_LIMIT` hosts added at once, 50 unless you set it, which keeps one organization from using up the certificate authority's rate limits for the others.

Only hosts an organization has verified are custom domains.  Requests for any other host, such as the main address, a service name, an IP address, or `localhost`, reach the main app as they always have, so health checks, in-cluster clients, and local commands keep working.  That includes a host that's added but not verified yet, so adding a name, which proves nothing, can't take it away from anyone.  Once a host is verified, it stays a custom domain even after it loses its verification or is removed, and then answers 404 for everything, since certificates and links for it may still be out there.

The TXT name is `_riosoma-public.<host>`.  Keep its value published after verification.  Riosoma shares the DNS TXT checker used for single sign-on verification, with a separate challenge namespace.  Verification is rechecked daily, starting after 23 hours.  A lookup that fails without an answer, such as a timeout, is tried three times.  A check that doesn't find the record counts a failure and keeps the domain serving, and three failed checks in a row take verification away and notify the organization's owner and Integrations administrators.  A domain not checked for a day cannot serve pages or authorize certificates, including when the scheduler is unavailable.  Use Verify domain again after correcting DNS.

A host can be verified by only one organization on an instance.  If several verified hosts serve a page kind, new links use the earliest-added host.  Removing a host stops requests immediately and changes new links to another eligible host or the main address.  Existing certificates may remain cached at the proxy, but they confer no permission to serve pages.  Existing links on a removed host return 404.

## Docker Compose with Caddy

The `caddy` profile uses `deploy/compose/Caddyfile` and the pinned Caddy image.  It serves the main host normally and obtains certificates for verified custom hosts on demand.  Its private ask request goes to the server over the dedicated `domains` network.  Both public listeners refuse `/internal/*`.

1. Set `CADDY_DOMAIN` to the main host and `RIOSOMA_BASE_URL` to its HTTPS address.
2. Generate `RIOSOMA_TLS_ASK_TOKEN` with `openssl rand -hex 32`, and save it in the Compose `.env` file with mode `600`.  Compose gives the same value to Caddy and Riosoma.  Use letters, digits, underscores, or hyphens only, so it can safely appear in Caddy's ask URL.  An unset token disables custom certificate issuance while the main host continues working.
3. Set `RIOSOMA_TRUST_PROXY=172.30.52.2`.  The bundled private network assigns this address to Caddy and `172.30.52.3` to Riosoma.  `RIOSOMA_TLS_ASK_ADDRESSES` defaults to Caddy's address in Compose.  If this subnet conflicts with your network, change the subnet, both static addresses, the trust setting, and the ask allowlist together.
4. Run `docker compose --profile caddy up -d`.  Allow inbound ports 80 and 443, and keep the application port bound to loopback.
5. Add and verify a host in Riosoma.  Point its CNAME at the displayed target, or use A and AAAA records for the proxy's public addresses when your DNS provider requires them.  Set `RIOSOMA_CUSTOM_DOMAIN_TARGET` when the proxy has a different DNS name or IP address from the main app.
6. Visit the public link over HTTPS.  Caddy requests permission before obtaining the certificate.  Keep its `/data` volume across upgrades so certificates and account state persist.

The ask endpoint reads current database state and does no DNS lookup during a TLS handshake.  Caddy's [on-demand TLS options](https://caddyserver.com/docs/caddyfile/options#on-demand-tls) describe the ask protocol.  Its [automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https#on-demand-tls) describes certificate issuance during a first connection.

The bundled Caddy configuration also replaces `X-Riosoma-Public-Authority` with the connection's TLS server name and `X-Riosoma-Authority-Token` with the shared token.  Together with the allowed socket address, these bind a site's form submission to its HTTPS authority when public demo mode is on.  A direct HTTP request to the application listener cannot use a supplied Host to claim this exception.

## Kubernetes with cert-manager

The chart's main Ingress stays on the main host.  Cert-manager uses explicit Ingress hosts rather than an ask hook, so a cluster operator adds each host after the organization verifies it in Riosoma.  Install cert-manager, configure a ClusterIssuer for your ingress controller, and use the chart's `ingress.customDomains` list:

```yaml
ingress:
  enabled: true
  className: nginx
  host: riosoma.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  customDomains:
    - host: forms.example.org
      secretName: public-forms-tls
```

Upgrade the Helm release with these values.  The chart creates a separate Ingress and TLS secret reference for each custom host.  Cert-manager issues and renews its certificate automatically.  Point each host at the ingress controller's load balancer and preserve the original Host header when forwarding to Riosoma.  See cert-manager's [annotated Ingress documentation](https://cert-manager.io/docs/usage/ingress/).

Remove the host from Riosoma first, then remove its Helm entry and unused TLS Secret.  Database removal immediately blocks content even while an old Ingress or certificate remains.  The chart does not watch organization domain changes or provision Ingress resources from the application.  Keep ingress configuration under operator control.

For site forms beside a public demo, configure the ingress controller to replace `X-Riosoma-Public-Authority` with its TLS server name and `X-Riosoma-Authority-Token` with `RIOSOMA_TLS_ASK_TOKEN`.  Set the same token in the application's Secret, and set `RIOSOMA_TLS_ASK_ADDRESSES` to the controller's actual socket addresses or dedicated network range.  Trusting forwarded client addresses alone does not authorize this exception.

An operator-managed ingress-nginx controller can use these annotations through the chart's `ingress.annotations`.  Replace the token placeholder in a protected values file before deploying, restrict access to the resulting Ingress, and keep the token out of logs.  Snippet annotations must be available only to the cluster operator:

```yaml
nginx.ingress.kubernetes.io/server-snippet: |
  if ($scheme = http) { return 308 https://$host$request_uri; }
  if ($ssl_server_name != $host) { return 421; }
nginx.ingress.kubernetes.io/configuration-snippet: |
  proxy_set_header X-Riosoma-Public-Authority $ssl_server_name;
  proxy_set_header X-Riosoma-Authority-Token "<RIOSOMA_TLS_ASK_TOKEN>";
```

Other ingress controllers need the same authority assertion from their TLS connection.  If the controller cannot provide it, site forms remain refused while demo mode is on.  The [ingress-nginx snippet documentation](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/#configuration-snippet) describes controller configuration.

For Caddy in Kubernetes, use the same ask protocol as Compose, with an internal Service address and `RIOSOMA_TLS_ASK_TOKEN` from a Secret.  Set `RIOSOMA_TLS_ASK_ADDRESSES` to the actual Caddy pod addresses or its dedicated network range.  Use a NetworkPolicy to allow only those proxy pods to reach the application, and block `/internal/` on every public listener.  Do not allow the entire cluster network when unrelated workloads share it.

## Other proxies and existing hosting

For a proxy with an ask hook, call `GET /internal/tls/allow?domain=<host>` on a private backend address.  Supply the shared token in `X-TLS-Ask-Token`, or in a `token` query parameter if headers are unavailable.  Only a 200 response authorizes issuance.  Unknown, unverified, expired, or removed hosts, a missing or incorrect token, and a socket address outside `RIOSOMA_TLS_ASK_ADDRESSES` receive 404.  Forwarded client addresses never grant access.  Keep ask tokens out of proxy access logs and tracing.

The proxy must preserve the original Host header, overwrite client-supplied forwarding headers, terminate HTTPS, reject a Host that disagrees with TLS SNI, and redirect public HTTP to HTTPS.  Configure `RIOSOMA_TRUST_PROXY` narrowly for the proxy's addresses.  Do not rewrite custom requests to the main app's Host, since that would bypass tenant selection.  Keep the backend private, restrict the ask endpoint by firewall, and refuse `/internal/` on the public edge.  Disable shared caching for custom-domain pages and JSON responses so removal is immediately effective.

When demo mode is on, a site's form POST also requires `X-Riosoma-Public-Authority` from the proxy's TLS server name, `X-Riosoma-Authority-Token` matching `RIOSOMA_TLS_ASK_TOKEN`, and a socket peer allowed by `RIOSOMA_TLS_ASK_ADDRESSES`.  The proxy must replace both headers, including when visitors supply their own values.  Missing authority proof, a Host mismatch, or an unauthorized peer refuses the submission before admission, even when forwarded headers claim a verified domain.  Verification, a check within the last day, and site hosting are checked again under a domain row lock during submission authorization.

If your hosting provider or existing proxy cannot issue certificates through an ask hook, register each verified host with that provider's certificate and routing system.  Configure renewal there, and remove the mapping after removing the domain in Riosoma.  Riosoma does not configure a third-party proxy automatically.  Set `RIOSOMA_CUSTOM_DOMAIN_TARGET` to the provider's required routing target.  For an apex domain, use the provider's A, AAAA, or supported alias records instead of a CNAME when necessary.

Custom hosts allow only public page routes, their anonymous JSON endpoints, and the assets they need.  App, sign-in, setup, administration, authenticated APIs, and other organizations' content return 404.  Session and CSRF cookies are neither read nor set.  Password-protected views use a pass held in the open tab's memory and ask for the password again after a reload.  The browser does not install a service worker on a custom host.
