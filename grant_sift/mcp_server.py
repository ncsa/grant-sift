"""MCP endpoint at /mcp: the dashboard, for an assistant.

Reads are written here, shaped for a model (filters, limits, one call in full).
WRITES ARE NOT. Feedback, roster and source additions, retirements and
subscriptions each call the dashboard's own handler in server.py with the
tool call's HTTP request, so validation, rate limits, URL deduplication, the
SSRF check and created_by attribution are the same code, not a second copy
that drifts. A write from Claude is stamped with the signed-in username
exactly like a click.

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

import json
import os
from datetime import date
from urllib.parse import urlparse

from fastapi import HTTPException
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import auth, db, pipeline

DB_PATH = os.environ.get("GRANT_SIFT_DB", "grant-sift.db")

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
        "collaborators. Use search_opportunities to find calls, "
        "get_opportunity for one call's full record, and my_opportunities for "
        "calls tied to the signed-in person. A roster match of kind 'contact' "
        "is an outreach lead, NOT a past collaboration: never describe it as "
        "one. Writes (feedback, roster, sources, subscriptions) are stamped "
        "with the signed-in username and shape every later score or digest: "
        "confirm each with the user before calling it."
    ),
)


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------

def _conn():
    return db.connect(DB_PATH)


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


def _rest(ctx: Context, handler: str, *args):
    """Run a dashboard handler from server.py on this tool call's request.

    Imported here, not at the top: server.py imports this module to mount it.
    """
    _principal(ctx)
    from . import server
    try:
        return getattr(server, handler)(ctx.request_context.request, *args)
    except HTTPException as exc:
        raise ToolError(f"{exc.status_code}: {exc.detail}") from exc


def _limit(n: int) -> int:
    return max(1, min(int(n or 25), MAX_LIMIT))


_ROSTER = None


def _roster():
    """Normalised roster, once per process; a missing file degrades to no
    contact details rather than failing every tool call."""
    global _ROSTER
    if _ROSTER is None:
        try:
            _ROSTER = pipeline.load_config()[1]
        except Exception:  # noqa: BLE001
            _ROSTER = []
    return _ROSTER


_CONTACTS = None


def _contacts():
    global _CONTACTS
    if _CONTACTS is None:
        _CONTACTS = pipeline.contact_index(_roster())
    return _CONTACTS


def _loads(blob):
    try:
        v = json.loads(blob) if blob else None
    except (TypeError, ValueError):
        return None
    return v if isinstance(v, dict) else None


_SUMMARY_COLS = """o.id, o.source, o.title, o.agency, o.url, o.deadline,
                   o.award_ceiling, a.score, a.category, a.summary,
                   a.match_name, a.match_kind"""


def _summary_row(r, verdicts) -> dict:
    """One line's worth of a call: enough to choose, not enough to read."""
    out = {k: r[k] for k in ("id", "title", "agency", "source", "deadline",
                             "award_ceiling", "score", "category", "summary",
                             "match_name", "match_kind", "url")}
    v = verdicts.get(r["id"])
    if v:
        out["human_verdict"] = v["verdict"]
    return out


def _live_rows(conn, where: str = "", params: tuple = ()):
    return conn.execute(
        f"""SELECT {_SUMMARY_COLS}
            FROM opportunities o JOIN assessments a ON a.opportunity_id = o.id
            WHERE {db.LIVE} {('AND ' + where) if where else ''}
            ORDER BY a.score DESC, (o.deadline IS NULL), o.deadline ASC""",
        params,
    ).fetchall()


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool(annotations=_READ)
def whoami(ctx: Context) -> dict:
    """Who this server thinks you are, and whether sign-in is enforced."""
    p = _principal(ctx)
    return auth.status() | {"username": p.label, "email": p.email or None,
                            "groups": p.groups}


@mcp.tool(annotations=_READ)
def search_opportunities(
    ctx: Context,
    query: str = "",
    category: str | None = None,
    source: str | None = None,
    min_score: int = 0,
    closing_within_days: int | None = None,
    roster_match_only: bool = False,
    limit: int = 25,
) -> dict:
    """Search open funding calls, best score first.

    query matches title, funder, generated summary and captured synopsis
    (case-insensitive substring; several words must all appear). category is
    one of the pipeline's categories, e.g. ci_program, embedded_software,
    domain_subaward. source is a source name such as grants.gov, nsf or a
    foundation's name. Calls a person has marked "not for us" carry
    human_verdict "down".
    """
    _principal(ctx)
    where, params = ["a.score >= ?"], [int(min_score or 0)]
    for word in (query or "").split():
        where.append("(o.title LIKE ? OR o.agency LIKE ? OR a.summary LIKE ? "
                     "OR o.synopsis LIKE ?)")
        params += [f"%{word}%"] * 4
    if category:
        where.append("a.category = ?")
        params.append(category.strip())
    if source:
        where.append("o.source = ? COLLATE NOCASE")
        params.append(source.strip())
    if closing_within_days is not None:
        where.append("o.deadline IS NOT NULL AND o.deadline <= date('now', ?)")
        params.append(f"+{int(closing_within_days)} days")
    if roster_match_only:
        where.append("a.match_name IS NOT NULL AND a.match_name != ''")
    conn = _conn()
    try:
        rows = _live_rows(conn, " AND ".join(where), tuple(params))
        verdicts = db.human_verdicts(conn)
    finally:
        conn.close()
    n = _limit(limit)
    return {"total": len(rows), "returned": min(n, len(rows)),
            "opportunities": [_summary_row(r, verdicts) for r in rows[:n]]}


@mcp.tool(annotations=_READ)
def get_opportunity(ctx: Context, opportunity_id: str) -> dict:
    """One call in full: the assessment, its subscores and extracted facts,
    the closest roster match with how to reach them, recorded feedback, and
    the synopsis as captured (not a fresh fetch of the funder's page)."""
    _principal(ctx)
    conn = _conn()
    try:
        r = conn.execute(
            """SELECT o.id, o.source, o.title, o.agency, o.url, o.deadline,
                      o.award_ceiling, o.indirect_cap, o.first_seen, o.synopsis,
                      a.score, a.category, a.rationale, a.summary, a.axes_json,
                      a.facts_json, a.match_name, a.match_kind, a.match_domain,
                      a.match_project, a.match_status, a.match_rationale
               FROM opportunities o
               LEFT JOIN assessments a ON a.opportunity_id = o.id
               WHERE o.id = ?""",
            (opportunity_id.strip(),),
        ).fetchone()
        if r is None:
            raise ToolError(f"unknown opportunity_id {opportunity_id!r}")
        feedback = [dict(f) for f in conn.execute(
            """SELECT verdict, aspect, note, created_by, created_at FROM feedback
               WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 20""",
            (r["id"],))]
    finally:
        conn.close()
    out = {k: r[k] for k in r.keys() if k not in ("axes_json", "facts_json", "synopsis")}
    out["axes"] = _loads(r["axes_json"])
    out["facts"] = _loads(r["facts_json"])
    out["contact"] = _contacts().get((r["match_name"] or "").strip().lower())
    out["feedback"] = feedback
    out["synopsis"] = (r["synopsis"] or "")[:SYNOPSIS_CHARS]
    return out


def _mine_by_sources(conn, p: auth.Principal):
    names = [s["name"] for s in db.source_additions(conn)
             if s.get("created_by") == p.label]
    if not names:
        return names, []
    marks = ",".join("?" * len(names))
    return names, _live_rows(conn, f"o.source IN ({marks})", tuple(names))


def _is_me(person: dict, p: auth.Principal) -> bool:
    email = (person.get("email") or "").strip().lower()
    if not email:
        return False
    if p.email and email == p.email.lower():
        return True
    # Keycloak usernames here are NetIDs, and staff addresses are NetID@illinois.edu.
    return email.split("@")[0] == p.username.lower()


def _mine_by_contacts(conn, p: auth.Principal):
    mine = {name for name, c in _contacts().items()
            if any(_is_me(x, p) for x in c.get("ncsa_contact") or [])}
    rows = [r for r in _live_rows(conn, "a.match_name IS NOT NULL")
            if (r["match_name"] or "").strip().lower() in mine]
    return sorted({r["match_name"] for r in rows}), rows


def _mine_by_subscriptions(conn, p: auth.Principal):
    email = (p.email or p.username).strip().lower()
    if "@" not in email:
        email += "@illinois.edu"
    feeds = db.list_feeds_for_email(conn, email)
    tests = [pipeline.FEEDS[f] for f in feeds if f in pipeline.FEEDS]
    rows = [r for r in _live_rows(conn) if any(t(r) for t in tests)]
    return feeds, rows


_SCOPES = {
    "sources": _mine_by_sources,
    "contacts": _mine_by_contacts,
    "subscriptions": _mine_by_subscriptions,
}


@mcp.tool(annotations=_READ)
def my_opportunities(ctx: Context, scope: str = "all", limit: int = 25) -> dict:
    """Open calls tied to you, the signed-in person.

    scope:
      sources        calls from funder pages or feeds you added in the dashboard
      contacts       calls matched to a collaborator you are the NCSA contact for
      subscriptions  calls in the email digests you subscribe to
      all            each of the above, separately

    Down-voted calls are left out.
    """
    p = _principal(ctx)
    wanted = list(_SCOPES) if scope == "all" else [scope]
    unknown = [s for s in wanted if s not in _SCOPES]
    if unknown:
        raise ToolError(f"scope must be one of {', '.join(_SCOPES)} or all")
    n = _limit(limit)
    conn = _conn()
    try:
        verdicts = db.human_verdicts(conn)
        out = {"username": p.label}
        for s in wanted:
            via, rows = _SCOPES[s](conn, p)
            rows = [r for r in rows if not pipeline._suppressed(r, verdicts)]
            out[s] = {"via": via, "total": len(rows),
                      "opportunities": [_summary_row(r, verdicts) for r in rows[:n]]}
    finally:
        conn.close()
    return out


@mcp.tool(annotations=_READ)
def list_sources(ctx: Context, added_by: str | None = None, stale_only: bool = False) -> dict:
    """Funder pages, feeds and APIs Grant Sift reads, with each one's health.
    Dashboard additions carry the id retire_source takes.

    added_by filters to sources a given username added in the dashboard.
    stale_only keeps the ones that have stopped yielding, which is the failure
    this list exists to catch.
    """
    _principal(ctx)
    try:
        cfg = pipeline.load_config()[0]
    except Exception:  # noqa: BLE001
        cfg = {}
    conn = _conn()
    try:
        runs = {r["name"]: dict(r) for r in conn.execute(
            "SELECT name, last_success, last_yield, last_error FROM sources")}
        stale = {s["name"] for s in db.stale_sources(conn)}
        additions = db.source_additions(conn)
    finally:
        conn.close()
    out = []

    def add(name, kind, url, origin, by=None, sid=None):
        r = runs.get(name, {})
        out.append({"id": sid, "name": name, "kind": kind, "url": url, "origin": origin,
                    "added_by": by, "stale": name in stale,
                    "last_success": r.get("last_success"),
                    "last_yield": r.get("last_yield"),
                    "last_error": r.get("last_error")})

    if not added_by:
        for f in cfg.get("feeds") or []:
            add(f["name"], "feed", f.get("url"), "file")
        for f in cfg.get("foundations") or []:
            add(f["name"], "page", f.get("url"), "file")
    for a in additions:
        if not added_by or a.get("created_by") == added_by:
            add(a["name"], a["kind"], a["url"], "dashboard", a.get("created_by"), a["id"])
    if stale_only:
        out = [s for s in out if s["stale"]]
    return {"count": len(out), "sources": out}


@mcp.tool(annotations=_READ)
def preview_feed(ctx: Context, feed: str, since_days: int = 7, limit: int = 25) -> dict:
    """What a digest feed holds right now: open calls first seen in the last
    since_days that pass the feed's rule, ignoring what has already been
    emailed. Feeds: closing-soon, roster-match, ci-programs, embedded,
    foundations."""
    _principal(ctx)
    if feed not in pipeline.FEEDS:
        raise ToolError(f"feed must be one of {', '.join(pipeline.FEEDS)}")
    conn = _conn()
    try:
        items = pipeline.build_digest(
            conn, feed, since_days=max(1, min(int(since_days), 90)),
            respect_sent_log=False, roster=_roster())
    finally:
        conn.close()
    # build_digest only looks at first_seen; a digest run is days fresh, but a
    # preview over a long window would otherwise list calls already closed.
    today = date.today().isoformat()
    items = [i for i in items if not i.get("deadline") or i["deadline"] >= today]
    keep = ("id", "title", "agency", "source", "deadline", "score", "category",
            "match_name", "match_kind", "url")
    return {"feed": feed, "label": pipeline.FEED_LABELS.get(feed, feed),
            "count": len(items),
            "items": [{k: i.get(k) for k in keep} for i in items[:_limit(limit)]]}


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
