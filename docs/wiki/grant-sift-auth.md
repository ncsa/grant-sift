# Grant Sift: how authentication works

Grant Sift does no OAuth itself. **Keycloak** (NCSA realm) issues identities, **oauth2-proxy** checks them on every request, and the **app** trusts the identity headers the proxy adds. The dashboard (browser) and the MCP endpoint (Claude) go through the same gate and the same app code. They differ only in how the caller proves who they are: a browser uses a cookie, an MCP client sends a bearer token.

## The parts

| Part | Job | Where |
|---|---|---|
| **Keycloak**, realm `NCSA` | Knows who you are; signs tokens with its private key | `keycloak.software-dev.ncsa.illinois.edu` |
| **oauth2-proxy** | Sits in front of the app; checks the cookie or bearer token; adds `X-Forwarded-*` identity headers | `grant-sift-oauth2-proxy` deployment |
| **grant-sift app** | Never sees tokens. Trusts the identity headers, but only from the proxy's address range | `grant-sift` deployment |
| **MCP client** | Claude Code, or Claude Desktop through `mcp-remote`. Logs in to Keycloak itself and holds the token | User's laptop |

Two Keycloak clients, one per kind of caller:

| Client | Type | Used by | Login code is delivered to |
|---|---|---|---|
| `grant-sift` | Confidential (has a secret) | oauth2-proxy, for browser logins | `https://grant-sift.software-dev.ncsa.illinois.edu/oauth2/callback`, the **server** |
| `grant-sift-mcp` | Public (no secret) + PKCE | MCP clients on laptops | `http://localhost:33418/callback`, the **user's own machine** |

The `localhost` redirect is correct for a deployed app. The user's **browser** resolves it, so it reaches the Claude process on that user's laptop that started the login. Desktop apps log in this way (RFC 8252, OAuth for native apps), as `gh auth login` and `gcloud auth login` do.

## Flow 1: browser (dashboard)

```
Browser          oauth2-proxy             Keycloak            grant-sift
   │ GET /            │                        │                    │
   │─────────────────>│ no cookie              │                    │
   │<─ 302 to login ──│                        │                    │
   │──────────────── login page, NCSA SSO ────>│                    │
   │<──────────── 302 back with a code ────────│                    │
   │─────────────────>│── swap code for token ─>│                    │
   │<─ Set-Cookie ────│                        │                    │
   │ GET / + cookie   │                        │                    │
   │─────────────────>│ ── X-Forwarded-Preferred-Username: cwang138 ─>│
```

The browser never holds a token, only the proxy's session cookie.

## Flow 2: MCP client, first connection

An MCP client can't use cookies or follow a login redirect, so it runs the OAuth flow itself:

```
Claude (laptop)           oauth2-proxy           grant-sift              Keycloak
   │ ① POST /mcp (no token)   │                     │                       │
   │─────────────────────────>│ api_routes ^/mcp    │                       │
   │<──────── 401 ────────────│ (401, not a 302)    │                       │
   │ ② GET /.well-known/oauth-protected-resource/mcp│                       │
   │─────────────────────────>│ skip_auth_routes ──>│                       │
   │<── {"authorization_servers": [".../realms/NCSA"]}                      │
   │ ③ GET .../realms/NCSA/.well-known/openid-configuration ───────────────>│
   │ ④ browser: login as client_id=grant-sift-mcp, with PKCE ──────────────>│
   │<──── redirect to http://localhost:33418/callback?code=… ───────────────│
   │ ⑤ POST /token  code + PKCE verifier ──────────────────────────────────>│
   │<──────────── access token (minutes) + refresh token (weeks) ───────────│
```

- **②** is served by the app and passes the proxy unauthenticated (`skip_auth_routes`), because the client has no token yet. It tells the client which realm to log in to.
- **PKCE** replaces a client secret. The client sends a hash of a random value in ④ and reveals the value in ⑤, so an intercepted code is useless to anyone else.

## Flow 3: every MCP call after that

```
Claude                         oauth2-proxy                          grant-sift
   │ POST /mcp                     │                                     │
   │ Authorization: Bearer eyJ…    │ skip_jwt_bearer_tokens:             │
   │──────────────────────────────>│  ✓ signature (Keycloak public key)  │
   │                               │  ✓ iss = NCSA realm                 │
   │                               │  ✓ aud includes "grant-sift"        │
   │                               │  ✓ not expired                      │
   │                               │── X-Forwarded-Preferred-Username ──>│ auth.require_user():
   │                               │   X-Forwarded-Email / -Groups       │  ✓ peer in trusted range?
   │<──────────────── tool result, as cwang138 ──────────────────────────│
```

When the access token expires, the client uses its refresh token to get a new one without a prompt. Users only see a login page again when the refresh token expires.

## What a token is

A JWT that Keycloak signs:

```json
{ "iss": "https://keycloak…/realms/NCSA",
  "aud": ["grant-sift"],
  "preferred_username": "cwang138",
  "email": "cwang138",
  "exp": 1791234567 }
```

Anyone with Keycloak's public key can verify it, and only Keycloak can create one. "Bearer" means whoever holds it gets in, which is why access tokens are short-lived.

| Token | Lifetime | Set by |
|---|---|---|
| Access token | 5–15 min | `grant-sift-mcp` → Advanced → Access Token Lifespan |
| Refresh token | Weeks with `offline_access`, otherwise the SSO session (hours) | Realm settings → Sessions → Offline Session Idle |

## Where each attack is stopped

| Someone tries to… | Stopped by |
|---|---|
| Call the app directly with a forged `X-Forwarded-Preferred-Username` | App: identity headers are refused unless the peer is in `GRANT_SIFT_TRUSTED_PROXIES` |
| Make up a token | Proxy: the signature check fails |
| Reuse a token issued for another NCSA app | Proxy: `aud` doesn't include `grant-sift` |
| Use a stolen access token | It expires within minutes; revoke the refresh token in Keycloak |
| Reach `/mcp` while auth is off | App: `/mcp` returns 503 unless `GRANT_SIFT_AUTH=proxy`. It has no anonymous mode |
| Flood writes | Rate limits per signed-in username, the same for dashboard and MCP |

Every MCP tool calls the same REST handler the dashboard uses, with the tool call's own request. A write from Claude gets the same validation, rate limits and `created_by` attribution as a click in the dashboard.

## Configuration

**oauth2-proxy** (`helm/grant-sift/values-software-dev.yaml`, `configFile`):

```toml
skip_jwt_bearer_tokens = true          # accept "Authorization: Bearer <Keycloak JWT>"
api_routes = [ "^/mcp" ]               # no session → 401, not a 302 to the login page
skip_auth_routes = [ "GET=^/[.]well-known/oauth-protected-resource" ]
```

**App** (ConfigMap / env):

| Variable | Value |
|---|---|
| `GRANT_SIFT_AUTH` | `proxy` |
| `GRANT_SIFT_TRUSTED_PROXIES` | `10.42.0.0/16` (pod network) |
| `GRANT_SIFT_AUTH_USER_HEADER` | `x-forwarded-preferred-username` |
| `GRANT_SIFT_PUBLIC_URL` | `https://grant-sift.software-dev.ncsa.illinois.edu` |
| `GRANT_SIFT_OIDC_ISSUER` | Injected from ConfigMap `grant-sift-keycloak` |

**Keycloak client `grant-sift-mcp`:**

| Setting | Value |
|---|---|
| Client authentication | Off (public) |
| Flows | Standard flow only |
| PKCE | S256 |
| Valid redirect URIs | `http://localhost:33418/callback` |
| **Audience mapper** (dedicated scope) | Included Client Audience `grant-sift`, Add to access token **on** |
| Client scopes | `profile`, `email`; `offline_access` optional |

Without the Audience mapper, tokens carry `aud: ["account"]` and every MCP call returns 401.

## Troubleshooting

Read the proxy log first. It records the reason for every rejected bearer token:

```bash
kubectl -n grant-sift logs deploy/grant-sift-oauth2-proxy --since=15m | grep -E '"/mcp"|jwt_session'
```

| Log or symptom | Cause |
|---|---|
| `audience … [account] does not match … grant-sift` | Audience mapper missing on `grant-sift-mcp` |
| `/mcp` returns 302 to a login page | Proxy is running old config; restart the oauth2-proxy deployment |
| Tool error: `no identity in 'x-forwarded-preferred-username'` | Token lacks `preferred_username`; assign the `profile` scope |
| Tool error: `identity headers refused` | Request didn't come from the proxy; check `GRANT_SIFT_TRUSTED_PROXIES` |
| `/mcp` returns 503 | App is running with `GRANT_SIFT_AUTH` other than `proxy` |
| Keycloak shows "Invalid redirect URI" | Add the exact URI from the error to the client |

To check a token by hand: in Keycloak, open `grant-sift-mcp` → **Client scopes → Evaluate** → pick a user → **Generated access token**. Then send it to the app:

```bash
curl -H "Authorization: Bearer $TOKEN" https://grant-sift.software-dev.ncsa.illinois.edu/api/whoami
```
