"""The open catalogue, filtered, searched, sorted and paged on the server.

This used to live in the dashboard's JavaScript, over a nightly JSON export
of the whole catalogue. It lives here now so the dashboard, the REST API and the
MCP tools ask one implementation the same question and get the same answer:
"via me" cannot mean one thing on the page and another to an assistant.

The catalogue is small (around a thousand live calls), so each request reads
it whole and filters in Python. Two queries, no cache: a cache would have to
be invalidated by every feedback vote, and a vote must show at once.
"""

import re
from datetime import date

from rapidfuzz import fuzz, process

from . import db, llm, pipeline

# ---------------------------------------------------------------------------
# Derived fields
# ---------------------------------------------------------------------------

# Award ceilings arrive as prose, so sorting on the raw string would put
# "$9,000" above "$10,000,000". Take the LARGEST dollar figure in the text:
# most strings with two figures are ranges ("$50,000 to $600,000"), and the
# ceiling is the number a person means when they sort by award size.
#
# Deliberately dollars only. Comparing 15,000 EUR against 15,000 USD as if
# they were the same number is worse than declining to rank them; they sort
# with the unknowns.
_AWARD_RE = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")


def award_usd(text):
    best = None
    for m in _AWARD_RE.finditer(text or ""):
        try:
            n = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if best is None or n > best:
            best = n
    return best


def _award(o):
    """The regex reading of the prose, else the figure the scorer extracted.
    Prose with no dollar sign ("up to 500K", "varies") is most of the
    unknowns, and the model reads those where a regex cannot."""
    a = award_usd(o["award_ceiling"])
    if a is None:
        a = (o.get("facts") or {}).get("award_ceiling_usd")
    return float(a) if isinstance(a, (int, float)) and not isinstance(a, bool) else None


# grants.gov reports an agency CODE, not a name: "HHS-NIH11", "DOD-AMRAA",
# "DOC-DOCNOAAERA". Offering those raw makes a 152-option dropdown of
# acronyms, 69 of them holding a single record. Fold them into the funder a
# person would actually name. HHS is split because it alone is half the
# corpus, so one "HHS" bucket would filter almost nothing.
_FUNDER_FAMILIES = [(re.compile(p), label) for p, label in (
    (r"^HHS-NIH", "NIH"),
    (r"^HHS-CDC", "CDC"),
    (r"^HHS-FDA", "FDA"),
    (r"^HHS-HRSA", "HRSA"),
    (r"^HHS", "HHS (other)"),
    (r"^NSF", "NSF"),
    (r"^DOD", "Defense"),
    (r"^DOS", "State Department"),
    (r"^DOI", "Interior"),
    (r"^USDA", "USDA"),
    (r"^DOC-DOCNOAA", "NOAA"),
    (r"^DOC", "Commerce"),
    (r"^NASA", "NASA"),
    (r"^(DOE|PAMS)", "Energy"),
    (r"^IMLS", "IMLS"),
    (r"^(USDOT|DOT)", "Transportation"),
    (r"^USDOJ", "Justice"),
    (r"^DOL", "Labor"),
    (r"^HUD", "HUD"),
    (r"^ED", "Education"),
    (r"^VA", "Veterans Affairs"),
    (r"^NEH", "NEH"),
    (r"^EPA", "EPA"),
    (r"^SBA", "SBA"),
)]


def funder_family(o):
    # Foundations and feeds already carry a readable name; only grants.gov
    # needs decoding. An unrecognised code falls through to itself rather than
    # into an "Other" bucket, so nothing becomes unfindable.
    if o["source"] != "grants.gov":
        return o["source"] or o["agency"] or ""
    code = (o["agency"] or "").upper()
    for rx, label in _FUNDER_FAMILIES:
        if rx.search(code):
            return label
    return o["agency"] or o["source"] or ""


def days_away(deadline):
    if not deadline:
        return None
    try:
        return (date.fromisoformat(deadline) - date.today()).days
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Who "me" is
# ---------------------------------------------------------------------------

def listed_by(o):
    """Every source carrying this call: the one shown and the copies folded
    into it (db.link_duplicates). A source filter asks "is it on X", and a
    call grants.gov also carries is still on X."""
    return {o["source"]} | {a["source"] for a in o.get("also_listed") or []}


def listed_dates(o):
    """Every upcoming deadline any listing of this call gives.

    A date range asks "what is due then", and a call can be due more than
    once: PAR-27-003 is shown at the Research Board's 17 Nov round but has a
    26 Jan round too, and belongs in a January view. Passed dates are left
    out -- a round that has closed is not due in any window worth asking.
    """
    today = date.today().isoformat()
    dates = {o["deadline"], o.get("listed_deadline")}
    dates |= {a["deadline"] for a in o.get("also_listed") or []}
    return sorted(d for d in dates if d and d >= today)


def is_me(person_email, principal):
    """Is this roster address the signed-in person? Keycloak sometimes puts
    the NetID in the email claim with no @, and staff addresses come as
    NetID@illinois.edu or NetID@ncsa.illinois.edu."""
    pe = (person_email or "").strip().lower()
    if not pe or not principal.authenticated:
        return False
    email = (principal.email or "").strip().lower()
    if "@" in email and pe == email:
        return True
    netid = (email.split("@")[0] if email else principal.username).lower()
    return bool(netid) and pe.startswith(netid + "@")


def _via_me(o, principal):
    people = (o.get("contact") or {}).get("ncsa_contact") or []
    return any(is_me(p.get("email"), principal) for p in people)


def mine(conn, principal):
    """The source names this person added, and the digest feeds they take.
    Read once per request, not per row."""
    if not principal.authenticated:
        return set(), []
    sources = {s["name"] for s in db.source_additions(conn)
               if s.get("created_by") == principal.label}
    email = (principal.email or principal.username).strip().lower()
    if "@" not in email:
        email += "@illinois.edu"
    feeds = [pipeline.FEEDS[f] for f in db.list_feeds_for_email(conn, email)
             if f in pipeline.FEEDS]
    return sources, feeds


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

# The dashboard's chips. Each is a predicate over a row, given the request's
# context (who is asking, what they own).
FILTERS = {
    "soon": lambda o, ctx: (o["_days"] is not None and o["_days"] <= 30),
    "match": lambda o, ctx: bool(o["match_name"]),
    "embedded": lambda o, ctx: o["category"] in ("embedded_software", "domain_subaward"),
    "ci": lambda o, ctx: o["category"] == "ci_program",
    "foundation": lambda o, ctx: o["source"] != "grants.gov",
    # No deadline: rolling, or none stated. A deadline range drops these, so
    # this is the only way to ask for them.
    "rolling": lambda o, ctx: not o["deadline"],
    "voted-up": lambda o, ctx: bool(o["human"] and o["human"]["verdict"] == "up"),
    "voted-down": lambda o, ctx: bool(o["human"] and o["human"]["verdict"] == "down"),
    # Stated as allowed. Unstated is not a no, so "-subaward-ok" keeps those.
    "subaward-ok": lambda o, ctx: (o.get("facts") or {}).get("subaward_ok") is True,
    # Calls matched to a collaborator the signed-in person is the NCSA contact for.
    "via-me": lambda o, ctx: _via_me(o, ctx["principal"]),
    # Calls from funder pages or feeds the signed-in person added.
    "my-sources": lambda o, ctx: bool(listed_by(o) & ctx["my_sources"]),
    # Calls in a digest feed the signed-in person subscribes to, less the ones
    # somebody has marked not for us, as the digest itself would.
    "my-digests": lambda o, ctx: (
        not (o["human"] and o["human"]["verdict"] == "down")
        and any(t(o) for t in ctx["my_feeds"])),
}


def _filter(name):
    """A chip, or its negation written with a leading minus ("-foundation")."""
    if name.startswith("-"):
        f = FILTERS[name[1:]]
        return lambda o, ctx: not f(o, ctx)
    return FILTERS[name]


# Values the scorer is told to use (llm.py). Checked so a typo is a 400, not
# a filter that silently matches nothing.
MATCH_KINDS = ("collaboration", "program", "contact")
MATCH_STATUSES = ("warm", "cold", "prospect", "departed", "do-not-contact")
SOLICITATION_TYPES = ("single-pi", "center", "consortium", "fellowship",
                      "training", "conference", "other")


def _any_of(raw, allowed=None, what=""):
    """A comma list as a lowercase set; empty means no constraint."""
    vals = {v.strip().lower() for v in (raw or "").split(",") if v.strip()}
    bad = sorted(vals - set(allowed)) if allowed else []
    if bad:
        raise ValueError(f"unknown {what} {bad}; use {', '.join(allowed)}")
    return vals


def _axis_floors(raw):
    """"software_depth:70,partner_need:50" -> {axis: floor}."""
    out = {}
    for part in (raw or "").split(","):
        if not part.strip():
            continue
        axis, _, n = part.partition(":")
        axis = axis.strip()
        if axis not in llm.AXES:
            raise ValueError(f"unknown axis {axis!r}; use {', '.join(llm.AXES)}")
        try:
            out[axis] = int(n)
        except ValueError:
            raise ValueError(f"axis floor must be axis:number, got {part.strip()!r}") from None
    return out


def _iso_date(s, what):
    if s:
        try:
            date.fromisoformat(s)
        except ValueError:
            raise ValueError(f"{what} must be an ISO date (YYYY-MM-DD), got {s!r}") from None
    return s


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

# Fuzzy matching runs on words from the short, name-like fields, where a typo
# is the likely failure ("hydrolgy", "Kooper"). Long prose - rationale,
# summary, synopsis - is matched as an exact substring only: a fuzzy match
# against a thousand-word synopsis finds something for nearly any word.
FUZZY_CUTOFF = 85
FUZZY_MIN_LEN = 5
_WORD = re.compile(r"[a-z0-9][a-z0-9'.-]*")


def _short_text(o):
    c = o.get("contact") or {}
    return " ".join(str(x) for x in (
        o["title"], o["agency"], o["source"], o["_funder"], o["match_name"],
        o["match_domain"], o["match_project"], c.get("email"), c.get("unit"),
        # Our own people are searchable too: "kooper" should answer "what is
        # on Rob's plate this month" without him reading all of it.
        *[v for p in c.get("ncsa_contact") or [] for v in (p.get("name"), p.get("email"))],
    ) if x).lower()


def _long_text(o):
    return " ".join(x for x in (o["rationale"], o["summary"]) if x).lower()


def _synopsis_hits(conn, tokens):
    """token -> ids whose captured synopsis contains it. In SQL, so the
    synopsis (most of the database's bytes) never has to be read into Python."""
    out = {}
    for t in tokens:
        out[t] = {r["id"] for r in conn.execute(
            f"SELECT o.id FROM opportunities o WHERE {db.LIVE} AND o.synopsis LIKE ?",
            (f"%{t}%",))}
    return out


def _relevance(o, tokens, syn_hits):
    """Score a row against the query, or None if any word does not match.

    Every word must match somewhere. Exact hits in names and titles count
    most, then hits in prose, then a near-miss spelling.
    """
    short, words = o["_short"], o["_words"]
    long_ = _long_text(o)
    total = 0.0
    for t in tokens:
        if t in short:
            total += 100
        elif t in long_ or o["id"] in syn_hits.get(t, ()):
            total += 60
        elif len(t) >= FUZZY_MIN_LEN and words:
            best = process.extractOne(t, words, scorer=fuzz.ratio, score_cutoff=FUZZY_CUTOFF)
            if best is None:
                return None
            total += best[1] * 0.5
        else:
            return None
    return total


# ---------------------------------------------------------------------------
# Sort
# ---------------------------------------------------------------------------

def _by_award(desc):
    # An unknown award is not a small one: unknowns go last in BOTH
    # directions, which is why this is not a plain numeric sort.
    def key(o):
        a = o["_award"]
        return (a is None, -(a or 0) if desc else (a or 0), -(o["score"] or 0))
    return key


SORTS = {
    "score": lambda o: -(o["score"] or 0),
    "deadline": lambda o: (o["deadline"] or "9999", -(o["score"] or 0)),
    "award-desc": _by_award(True),
    "award-asc": _by_award(False),
    "new": lambda o: _neg_str(o["first_seen"] or ""),
    "relevance": lambda o: (-(o.get("_rel") or 0), -(o["score"] or 0)),
}


def _neg_str(s):
    # Newest first on an ISO string: invert each character.
    return tuple(-ord(ch) for ch in s)


# ---------------------------------------------------------------------------
# The query
# ---------------------------------------------------------------------------

_PRIVATE = ("_days", "_award", "_funder", "_funders", "_short", "_words", "_rel")


def load(conn, contacts):
    rows = pipeline.catalogue_rows(conn, contacts)
    for o in rows:
        o["_days"] = days_away(o["deadline"])
        o["_award"] = _award(o)
        o["_funder"] = funder_family(o)
        # Plus the funder of every copy folded into it, so picking "Illinois
        # Research Board" still finds the calls the Board lists that grants.gov
        # carries too. A folded grants.gov copy has the shown copy's agency.
        o["_funders"] = {o["_funder"]} | {
            a["source"] for a in o.get("also_listed") or [] if a["source"] != "grants.gov"}
        o["_short"] = _short_text(o)
        o["_words"] = sorted(set(_WORD.findall(o["_short"] + " " + (o["summary"] or "").lower())))
    return rows


def public(o):
    out = {k: v for k, v in o.items() if k not in _PRIVATE}
    out["funder"] = o["_funder"]
    # The figure min_award/max_award and the award sorts compare, so a caller
    # can see why a call with "up to 500K" prose made the cut.
    out["award_usd"] = o["_award"]
    if o.get("_rel") is not None:
        out["relevance"] = round(o["_rel"], 1)
    return out


def search(conn, rows, principal, *, q="", ids=(), area="", funder="",
           deadline_from="", deadline_to="", filters=(), category="",
           source="", min_score=0, sort="", min_award=None, max_award=None,
           posted_since="", posted_before="", match_kind="", match_status="",
           solicitation_type="", min_axes=""):
    """Filter, search and sort. Returns the matching rows, best first.

    funder, category, source, match_kind, match_status and solicitation_type
    take a comma list and match any of it. A filter with a leading minus is
    negated. A bound on a field a row does not have (award, deadline, an
    axis) drops that row: an unknown is not inside any range.
    """
    unknown = [f for f in filters if f.removeprefix("-") not in FILTERS]
    if unknown:
        raise ValueError(f"unknown filter(s) {unknown}; use {', '.join(FILTERS)}, "
                         "or any of them with a leading - to exclude")
    sort = sort or ("relevance" if q.strip() else "score")
    if sort not in SORTS:
        raise ValueError(f"unknown sort {sort!r}; use {', '.join(SORTS)}")
    _iso_date(posted_since, "posted_since")
    _iso_date(posted_before, "posted_before")
    funders = _any_of(funder)
    categories = _any_of(category)
    sources = _any_of(source)
    kinds = _any_of(match_kind, MATCH_KINDS, "match_kind")
    statuses = _any_of(match_status, MATCH_STATUSES, "match_status")
    types = _any_of(solicitation_type, SOLICITATION_TYPES, "solicitation_type")
    floors = _axis_floors(min_axes)
    preds = [_filter(f) for f in filters]

    my_sources, my_feeds = (mine(conn, principal)
                            if {"my-sources", "my-digests"} & {f.removeprefix("-") for f in filters}
                            else (set(), []))
    ctx = {"principal": principal, "my_sources": my_sources, "my_feeds": my_feeds}
    wanted = set(ids)
    tokens = [t for t in q.lower().split() if t]
    syn_hits = _synopsis_hits(conn, tokens) if tokens else {}

    out = []
    for o in rows:
        if wanted and o["id"] not in wanted:
            continue
        if (o["score"] or 0) < min_score:
            continue
        if area and o["match_domain"] != area:
            continue
        if funders and not {f.lower() for f in o["_funders"]} & funders:
            continue
        if categories and (o["category"] or "").lower() not in categories:
            continue
        if sources and not {s.lower() for s in listed_by(o)} & sources:
            continue
        if kinds and (o["match_kind"] or "").lower() not in kinds:
            continue
        if statuses and (o["match_status"] or "").lower() not in statuses:
            continue
        if types and ((o.get("facts") or {}).get("solicitation_type") or "").lower() not in types:
            continue
        if (min_award or max_award) and o["_award"] is None:
            continue
        if min_award and o["_award"] < min_award:
            continue
        if max_award and o["_award"] > max_award:
            continue
        # first_seen is a UTC timestamp; the bounds are local dates. posted_before
        # is exclusive, so since/before tile without overlap.
        posted = db.local_date(o["first_seen"]).isoformat() if o["first_seen"] else ""
        if (posted_since or posted_before) and not posted:
            continue
        if posted_since and posted < posted_since:
            continue
        if posted_before and posted >= posted_before:
            continue
        if floors:
            axes = o.get("axes") or {}
            if any(not isinstance(axes.get(a), (int, float)) or axes[a] < n
                   for a, n in floors.items()):
                continue
        # Rolling / unstated deadlines have no date to fall in a range, so they
        # drop out of a bounded view rather than sitting in every window.
        if (deadline_from or deadline_to) and not any(
                (not deadline_from or d >= deadline_from) and (not deadline_to or d <= deadline_to)
                for d in listed_dates(o)):
            continue
        if not all(p(o, ctx) for p in preds):
            continue
        o["_rel"] = None
        if tokens:
            rel = _relevance(o, tokens, syn_hits)
            if rel is None:
                continue
            o["_rel"] = rel
        out.append(o)
    out.sort(key=SORTS[sort])
    return out


def facets(conn, rows):
    """The page header and the pickers: counts over the whole open
    catalogue, not the current filter, so the pickers do not shrink as you
    narrow."""
    areas, funders = {}, {}
    for o in rows:
        if o["match_domain"]:
            areas[o["match_domain"]] = areas.get(o["match_domain"], 0) + 1
        for f in o["_funders"]:
            if f:
                funders[f] = funders.get(f, 0) + 1

    def ranked(d):
        # Commonest first: the list is long and the head is where nearly
        # every record is.
        return [{"name": k, "count": n}
                for k, n in sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))]

    deadlines = sorted(o["deadline"] for o in rows if o["deadline"])
    updated = conn.execute("SELECT MAX(assessed_at) m FROM assessments").fetchone()["m"]
    return {
        "updated_at": updated,
        "open": len(rows),
        "soon": sum(1 for o in rows if o["_days"] is not None and 0 <= o["_days"] <= 30),
        "matched": sum(1 for o in rows if o["match_name"]),
        "areas": ranked(areas),
        "funders": ranked(funders),
        "deadline_min": deadlines[0] if deadlines else None,
        "deadline_max": deadlines[-1] if deadlines else None,
        "filters": list(FILTERS),
        "sorts": list(SORTS),
        "stale_sources": [dict(r) for r in db.stale_sources(conn)],
    }
