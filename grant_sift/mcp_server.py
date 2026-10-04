"""MCP endpoint at /mcp: the dashboard's REST API, for an assistant.

EVERY TOOL IS A REST ENDPOINT. Each one calls a handler in server.py with the
tool call's own HTTP request, so search, filters, "via me", validation, rate
limits, URL deduplication, the SSRF check and created_by attribution are the
code the dashboard runs, not a second copy that drifts. This file only names
the tools, describes them for a model, and trims what a model need not read.
A write from Claude is stamped with the signed-in username exactly like a click.

Not exposed: chat, focus, rescore and models. Each spends the viewer's own
Lumen key, which would have to travel as a tool argument - through the
model's context and the client's transcript - and the assistant calling these
tools is already a model that can read get_opportunity and reason about it.

AUTH is the same as the rest of the app, and none of it lives in this file.
oauth2-proxy accepts a Keycloak JWT as a bearer token (skip_jwt_bearer_tokens),
turns it into the same X-Forwarded-* headers a browser session gets, and
auth.principal() trusts those headers only from GRANT_SIFT_TRUSTED_PROXIES.
The MCP client obtains the JWT itself, by reading
/.well-known/oauth-protected-resource and running a PKCE login against the
Keycloak realm it names. So an MCP tool and a dashboard request are gated by
the same code, and "mine" means the same person in both.

THERE IS NO ANONYMOUS MODE. With GRANT_SIFT_AUTH anything but proxy, /mcp
answers 503 before the MCP layer sees the request - not even initialize or
tools/list. The rest of the app falls back to "anonymous" when auth is off;
this endpoint does not, so turning auth off can never quietly publish it.

Identity decides attribution on writes, and "mine" on reads: the calls from
sources I added, the calls matched to collaborators I am the contact for.
"""

import os
from urllib.parse import urlparse

from fastapi import HTTPException
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import auth

# Where clients reach this app, e.g. https://grant-sift.software-dev.ncsa.illinois.edu.
# Names the resource in the protected-resource metadata, and its host is added
# to the Host allowlist.
PUBLIC_URL = os.environ.get("GRANT_SIFT_PUBLIC_URL", "").strip().rstrip("/")
# The Keycloak realm MCP clients log in against, e.g.
# https://keycloak.software-dev.ncsa.illinois.edu/realms/NCSA. Without it there
# is no metadata to serve, and a client behind the proxy cannot find a login.
OIDC_ISSUER = os.environ.get("GRANT_SIFT_OIDC_ISSUER", "").strip().rstrip("/")

MAX_LIMIT = 100
SYNOPSIS_CHARS = 8000

_READ = ToolAnnotations(read_only_hint=True, destructive_hint=False,
                        idempotent_hint=True, open_world_hint=False)
_ADD = ToolAnnotations(read_only_hint=False, destructive_hint=False,
                       idempotent_hint=False, open_world_hint=False)
# Retiring hides a row from the pipeline without deleting it, but it does take
# something away, which is what a client's confirmation prompt keys on.
_RETIRE = ToolAnnotations(read_only_hint=False, destructive_hint=True,
                          idempotent_hint=True, open_world_hint=False)

mcp = MCPServer(
    name="grant-sift",
    instructions=(
        "Grant Sift tracks open funding calls and scores each for research "
        "software engineering relevance (0-100) against a roster of past "
        "collaborators. Use search_opportunities to find calls (fuzzy on names "
        "and titles), get_opportunity for one call's full record, and "
        "my_opportunities for calls tied to the signed-in person. A roster match of kind 'contact' "
        "is an outreach lead, NOT a past collaboration: never describe it as "
        "one. Writes (feedback, roster, sources, subscriptions) are stamped "
        "with the signed-in username and shape every later score or digest: "
        "confirm each with the user before calling it."
    ),
)


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------

def _principal(ctx: Context) -> auth.Principal:
    """The same gate the REST endpoints use, applied to the HTTP request that
    carried this tool call. An HTTPException becomes a tool error with the
    same message the dashboard would have shown. ToolError, not ValueError:
    the SDK hides any other exception's text from the client."""
    request = ctx.request_context.request
    if request is None or auth.MODE != "proxy":
        # stdio, an in-process call, or a gate that is off: no verified caller.
        raise ToolError("Grant Sift's MCP endpoint requires GRANT_SIFT_AUTH=proxy")
    try:
        p = auth.require_user(request)
    except HTTPException as exc:
        raise ToolError(str(exc.detail)) from exc
    if not p.authenticated:
        raise ToolError("no signed-in identity on this request")
    return p


def _rest(ctx: Context, handler: str, *args, **kwargs):
    """Run a REST handler from server.py on this tool call's request.

    Imported here, not at the top: server.py imports this module to mount it.
    """
    _principal(ctx)
    from . import server
    try:
        return getattr(server, handler)(ctx.request_context.request, *args, **kwargs)
    except HTTPException as exc:
        raise ToolError(f"{exc.status_code}: {exc.detail}") from exc


# A list row carries its subscores, extracted facts and contact block, which
# is a lot of tokens times 25. A model choosing between calls needs these;
# get_opportunity has the rest.
_BRIEF = ("id", "title", "funder", "deadline", "award_ceiling", "score",
          "category", "summary", "match_name", "match_kind", "human",
          "relevance", "url")


def _brief(page: dict) -> dict:
    return {k: page[k] for k in ("total", "of", "page", "pages", "sort")} | {
        "opportunities": [{k: o.get(k) for k in _BRIEF} for o in page["opportunities"]]}


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool(annotations=_READ)
def whoami(ctx: Context) -> dict:
    """Who this server thinks you are, and whether sign-in is enforced."""
    return _rest(ctx, "whoami")


@mcp.tool(annotations=_READ)
def search_opportunities(
    ctx: Context,
    query: str = "",
    filters: list[str] | None = None,
    category: str = "",
    source: str = "",
    funder: str = "",
    area: str = "",
    min_score: int = 0,
    deadline_from: str = "",
    deadline_to: str = "",
    sort: str = "",
    page: int = 1,
    page_size: int = 25,
) -> dict:
    """Search open funding calls - the same search as the dashboard.

    query: every word must match. Names, titles, funders and people match
    fuzzily (a typo still finds them); rationale, summary and the captured
    synopsis match exactly. filters (all must hold): soon (closes within 30
    days), match (has a roster match), embedded, ci, foundation, and the
    personal ones via-me, my-sources, my-digests. category e.g. ci_program,
    embedded_software, domain_subaward. funder is the family name shown on
    results (NIH, NSF, Defense, ...); area is a roster research area.
    deadline_from/to are ISO dates. sort: relevance (default with a query),
    score (default otherwise), deadline, award-desc, award-asc, new.
    get_catalogue lists the funders, areas and their counts.
    """
    return _brief(_rest(
        ctx, "list_opportunities", q=query, filters=",".join(filters or []),
        category=category, source=source, funder=funder, area=area,
        min_score=min_score, deadline_from=deadline_from,
        deadline_to=deadline_to, sort=sort, page=page,
        page_size=min(max(1, page_size), 50)))


@mcp.tool(annotations=_READ)
def get_catalogue(ctx: Context) -> dict:
    """The catalogue at a glance: open, closing-soon and matched counts, every
    funder family and research area with its count, the deadline range, and
    sources that have stopped updating (the list may be incomplete)."""
    return _rest(ctx, "catalogue_facets")


@mcp.tool(annotations=_READ)
def get_opportunity(ctx: Context, opportunity_id: str) -> dict:
    """One open call in full: the assessment, its subscores and extracted
    facts, the closest roster match with how to reach them, recorded
    feedback, and the synopsis as captured (not a fresh fetch)."""
    return _rest(ctx, "get_opportunity", opportunity_id.strip())


_SCOPES = {"contacts": "via-me", "sources": "my-sources", "subscriptions": "my-digests"}


@mcp.tool(annotations=_READ)
def my_opportunities(ctx: Context, scope: str = "all", page_size: int = 25) -> dict:
    """Open calls tied to you, the signed-in person.

    scope:
      contacts       matched to a collaborator you are the NCSA contact for
      sources        from funder pages or feeds you added in the dashboard
      subscriptions  in the email digests you subscribe to
      all            each of the above, separately

    The same filters as the dashboard's chips (via-me, my-sources, my-digests).
    """
    wanted = list(_SCOPES) if scope == "all" else [scope]
    if any(s not in _SCOPES for s in wanted):
        raise ToolError(f"scope must be one of {', '.join(_SCOPES)} or all")
    return {s: _brief(_rest(ctx, "list_opportunities", filters=_SCOPES[s],
                            page_size=min(max(1, page_size), 50)))
            for s in wanted}


@mcp.tool(annotations=_READ)
def list_sources(ctx: Context, added_by: str | None = None, stale_only: bool = False) -> dict:
    """Funder pages, feeds and APIs Grant Sift reads, with each one's health.
    added_by keeps the ones a given username added in the dashboard (those
    carry the id retire_source takes); stale_only keeps the ones that have
    stopped yielding, which is the failure this list exists to catch."""
    out = _rest(ctx, "sources_list")
    keep = [s for s in out["sources"]
            if (not added_by or s.get("created_by") == added_by)
            and (not stale_only or s["stale"])]
    return {"count": len(keep), "sources": keep}


@mcp.tool(annotations=_READ)
def preview_feed(ctx: Context, feed: str, since_days: int = 7, limit: int = 25) -> dict:
    """What a digest feed holds right now: open calls first seen in the last
    since_days that pass the feed's rule, ignoring what has already been
    emailed. Feeds: closing-soon, roster-match, ci-programs, embedded,
    foundations."""
    return _rest(ctx, "preview_feed", feed, since_days=since_days, limit=limit)


@mcp.tool(annotations=_READ)
def list_roster(ctx: Context) -> dict:
    """Everyone on the roster, the reviewed file and dashboard additions
    together, with how to reach them and who at NCSA already knows them.
    Check here before add_roster_entry: a duplicate splits one person's
    history in two."""
    return _rest(ctx, "roster_list")


@mcp.tool(annotations=_ADD)
def add_roster_entry(
    ctx: Context,
    domain: str,
    collaborator: str,
    project: str = "",
    years: str = "",
    our_role: str = "",
    funders: str = "",
    notes: str = "",
    status: str = "cold",
) -> dict:
    """Add a collaboration to the roster, as the dashboard form does.

    The roster is trusted context in every later classification prompt, so a
    careless entry steers every subsequent score. status is warm, cold
    (default, meaning unreviewed) or do-not-contact. Takes effect on the next
    assess run; already-scored calls are matched only after assess --rematch.
    """
    return _rest(ctx, "roster_add", {
        "domain": domain, "collaborator": collaborator, "project": project,
        "years": years, "our_role": our_role, "funders": funders,
        "notes": notes, "status": status})


@mcp.tool(annotations=_RETIRE)
def retire_roster_entry(ctx: Context, entry_id: int) -> dict:
    """Hide a dashboard-added roster entry (its id from list_roster) from the
    pipeline. The record is kept. Entries from the reviewed roster file are
    changed by editing that file, not here."""
    return _rest(ctx, "roster_retire", entry_id)


@mcp.tool(annotations=_ADD)
def add_source(
    ctx: Context,
    name: str,
    url: str,
    kind: str = "page",
    cadence: str = "weekly",
    notes: str = "",
) -> dict:
    """Add a funder page or RSS feed for the ingester to read.

    kind is page or feed; cadence is daily, weekly or monthly. The URL is
    checked against every existing source after normalising http/https, www,
    trailing slashes and query strings, so a 409 means it is already covered.
    Re-adding a retired source restores it. Read on the next ingest.
    """
    return _rest(ctx, "sources_add", {
        "name": name, "url": url, "kind": kind, "cadence": cadence, "notes": notes})


@mcp.tool(annotations=_RETIRE)
def retire_source(ctx: Context, entry_id: int) -> dict:
    """Stop reading a dashboard-added source (its id from list_sources, which
    shows it for dashboard additions). Sources from config/sources.yaml are
    removed by editing that file."""
    return _rest(ctx, "sources_retire", entry_id)


@mcp.tool(annotations=_ADD)
def add_feedback(
    ctx: Context,
    opportunity_id: str,
    verdict: str,
    aspect: str = "score",
    note: str = "",
) -> dict:
    """Record a thumbs up or down on a call, as the signed-in person.

    verdict is up or down. aspect says what the pipeline got wrong or right:
    score, category, or match (the named collaborator). A down takes the call
    out of digests at once; the note becomes a calibration example in later
    classification prompts, so make it say why.
    """
    return _rest(ctx, "post_feedback", {
        "opportunity_id": opportunity_id, "verdict": verdict,
        "aspect": aspect, "note": note})


@mcp.tool(annotations=_READ)
def get_subscriptions(ctx: Context) -> dict:
    """The email digests the signed-in person receives, and the feeds there are."""
    return _rest(ctx, "get_subscriptions")


@mcp.tool(annotations=_RETIRE)
def set_subscriptions(ctx: Context, feeds: list[str]) -> dict:
    """Replace the signed-in person's digest subscriptions with exactly these
    feeds; an empty list unsubscribes from everything. Always to your own
    address - there is no way to subscribe someone else."""
    return _rest(ctx, "put_subscriptions", {"feeds": feeds})


@mcp.tool(annotations=_READ)
def get_stats(
    ctx: Context,
    metric: str | None = None,
    since_days: int = 90,
) -> dict:
    """Daily pipeline rollups, the numbers behind the Grafana board: counts by
    source, category, feedback aspect, digest feed and score band."""
    _principal(ctx)
    from . import server
    return server.stats(metric=metric, since_days=since_days)


# ---------------------------------------------------------------------------
# HTTP wiring
# ---------------------------------------------------------------------------

def _allowed_hosts() -> list[str]:
    """Host header allowlist (DNS-rebinding protection). Behind oauth2-proxy
    the original Host is passed through, so the public name must be here."""
    hosts = ["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*", "[::1]:*"]
    if PUBLIC_URL:
        h = urlparse(PUBLIC_URL).netloc
        hosts += [h, f"{h}:*"]
    hosts += [h.strip() for h in
              os.environ.get("GRANT_SIFT_MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]
    return hosts


async def _protected_resource(request: Request):
    """RFC 9728 metadata: tells an MCP client which Keycloak realm to log in
    against. oauth2-proxy must let this path through unauthenticated
    (skip_auth_routes), or a client can never get far enough to log in."""
    if not OIDC_ISSUER:
        return JSONResponse({"detail": "GRANT_SIFT_OIDC_ISSUER is not set"}, status_code=404)
    base = PUBLIC_URL or str(request.base_url).rstrip("/")
    return JSONResponse({
        "resource": f"{base}/mcp",
        "authorization_servers": [OIDC_ISSUER],
        "scopes_supported": ["openid", "profile", "email", "offline_access"],
        "bearer_methods_supported": ["header"],
        "resource_name": "Grant Sift",
    })


# Stateless and JSON: every POST is a complete exchange, so nothing breaks
# when a pod restarts or the proxy retries, and no session table grows.
_http = mcp.streamable_http_app(
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_allowed_hosts(),
        # Server-side clients send no Origin; a browser one must be ours.
        allowed_origins=[PUBLIC_URL] if PUBLIC_URL else [],
    ),
)


class _ProxyOnly:
    """Refuse the whole transport unless the proxy gate is on. Checked per
    request, so it reads the same auth.MODE the rest of the app does. A class,
    not a function: Starlette wraps a plain function endpoint as
    request -> response, and this has to stay a raw ASGI app."""

    def __init__(self, endpoint):
        self.endpoint = endpoint

    async def __call__(self, scope, receive, send):
        if auth.MODE != "proxy":
            await JSONResponse(
                {"detail": "Grant Sift's MCP endpoint requires GRANT_SIFT_AUTH=proxy, "
                           "behind oauth2-proxy accepting Keycloak bearer tokens"},
                status_code=503)(scope, receive, send)
            return
        await self.endpoint(scope, receive, send)


# Added to the FastAPI app by server.py, ahead of the static mount at "/".
# The path-suffixed metadata URL is the one RFC 9728 clients try first.
routes = [
    *(Route(r.path, _ProxyOnly(r.endpoint)) for r in _http.routes),
    Route("/.well-known/oauth-protected-resource/mcp", _protected_resource),
    Route("/.well-known/oauth-protected-resource", _protected_resource),
]


def session_manager():
    return mcp.session_manager
