"""Source adapters. Each returns a list of normalised records:

    {id, source, external_id, title, synopsis, agency, url,
     deadline, award_ceiling, indirect_cap, raw}

Adapters never write to the database and never call the model except the
foundation-page one, which needs it to read.
"""

import re
from datetime import date, datetime, timedelta
from html import unescape
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import requests

from . import db, llm

# Below this much stripped text, a "successful" fetch is not a real listing:
# a bot wall or a client-rendered shell. Raise instead of extracting nothing.
MIN_PAGE_TEXT = 500

UA = "Grant Sift/1.0 (NCSA research software funding watch; contact: rse@ncsa.illinois.edu)"
HEADERS = {"User-Agent": UA}
TIMEOUT = 45


def _iso(value):
    """Normalise the several date shapes these sources use."""
    if not value:
        return None
    value = str(value).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d %b %Y", "%B %d, %Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:19], fmt).date().isoformat()
        except ValueError:
            continue
    m = re.search(r"(20\d{2})-(\d{2})-(\d{2})", value)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    # "Dec 04, 2026 12:00:00 AM EST" -- the fetchOpportunity date shape
    m = re.match(r"([A-Za-z]{3,9})\s+(\d{1,2}),\s*(20\d{2})", value)
    if m:
        for fmt in ("%b %d %Y", "%B %d %Y"):
            try:
                return datetime.strptime(
                    f"{m.group(1)[:9]} {m.group(2)} {m.group(3)}", fmt).date().isoformat()
            except ValueError:
                continue
    return None


def _strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style|nav|footer|svg)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = unescape(text)
    return re.sub(r"[ \t]*\n[ \t]*", "\n", re.sub(r"[ \t]+", " ", text)).strip()


def _money(value):
    """Grants.gov reports absent award figures as the string "none", and as "0".

    Returning those verbatim would put "up to none" in a digest, so treat them
    as missing and format real numbers readably.
    """
    if value is None:
        return None
    raw = str(value).strip().replace(",", "").replace("$", "")
    if raw.lower() in ("", "none", "null", "n/a", "na", "0", "0.0", "tbd"):
        return None
    try:
        n = float(raw)
    except ValueError:
        return str(value).strip()          # already prose, e.g. "$250,000 over 2 years"
    if n <= 0:
        return None
    return f"${int(n):,}"


# --------------------------------------------------------------------------
# Grants.gov
# --------------------------------------------------------------------------

GRANTS_GOV_URL = "https://api.grants.gov/v1/api/search2"
GRANTS_GOV_DETAIL_URL = "https://api.grants.gov/v1/api/fetchOpportunity"


def grants_gov_detail(oid):
    """Fetch the description and award figures for one opportunity.

    search2 returns only title, agency and dates -- no description and no award
    ceiling -- so without this the classifier scores on a title alone, the
    dashboard has nothing to expand, and no funding amount is ever shown.
    One request per opportunity, so callers must gate it (see db.needs_detail).

    Posted opportunities carry a `synopsis` block, forecasted ones a `forecast`
    block with different key names. Returns only the keys it actually found.
    """
    r = requests.post(GRANTS_GOV_DETAIL_URL, json={"opportunityId": int(oid)},
                      headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    body = r.json()
    if body.get("errorcode") not in (0, None):
        raise RuntimeError(f"fetchOpportunity {oid}: {body.get('msg')}")
    data = body.get("data") or {}
    blk = data.get("synopsis") or data.get("forecast") or {}

    desc = blk.get("synopsisDesc") or blk.get("forecastDesc") or ""
    ceiling = _money(blk.get("awardCeiling")) or _money(blk.get("estimatedFunding"))
    floor = _money(blk.get("awardFloor"))
    if ceiling and floor and floor != ceiling:
        ceiling = f"{floor} to {ceiling}"
    # A listing with no due date is treated downstream as rolling, i.e. open
    # forever. Some are not: NSF posts notices for old solicitations with no
    # responseDate and an archiveDate a day later (issue #34). So the archive
    # date stands in for a missing deadline, and a listing grants.gov already
    # reports as archived or closed is dead no later than today, which is what
    # it says itself: "Funding Opportunity is Archived, Proposals are not
    # accepted". Truly rolling calls carry no archiveDate, so they stay live.
    archived = _iso(blk.get("archiveDate"))
    deadline = _iso(blk.get("responseDate") or blk.get("estApplicationResponseDate")) or archived
    if str(data.get("ost") or "").upper() in ("ARCHIVED", "CLOSED"):
        gone = archived or datetime.utcnow().date().isoformat()
        deadline = min(deadline or gone, gone)

    out = {}
    if desc.strip():
        out["synopsis"] = _strip_html(desc)
    if ceiling:
        out["award_ceiling"] = ceiling
    if deadline:
        out["deadline"] = deadline
    return out


def grants_gov(agencies=None, rows=250):
    """Every forecasted and posted opportunity, a page of `rows` at a time.

    No keyword: relevance is the model's call, so the whole open list is read
    (1,469 calls on 2026-10-30, six requests). A search per keyword capped at
    200 rows each had missed 399 of them. A pull that stops short of the
    reported hitCount raises rather than storing a partial list as if it were
    complete.
    """
    records, start, total = [], 0, None
    while total is None or start < total:
        payload = {"keyword": "", "rows": rows, "startRecordNum": start,
                   "oppStatuses": "forecasted|posted"}
        if agencies:
            payload["agencies"] = "|".join(agencies)
        r = requests.post(GRANTS_GOV_URL, json=payload, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json().get("data") or {}
        total = int(data.get("hitCount") or 0)
        hits = data.get("oppHits") or []
        if not hits:
            break
        start += len(hits)
        for h in hits:
            oid = str(h.get("id") or h.get("number") or "")
            if not oid:
                continue
            records.append({
                "id": f"gg:{oid}",
                "source": "grants.gov",
                "external_id": oid,
                "title": h.get("title") or "",
                "synopsis": h.get("description") or h.get("synopsis") or "",
                "agency": h.get("agencyName") or h.get("agencyCode"),
                "url": f"https://grants.gov/search-results-detail/{oid}",
                "deadline": _iso(h.get("closeDate")),
                "award_ceiling": h.get("awardCeiling"),
                "indirect_cap": None,
                "raw": h,
            })
    if start < total:
        raise RuntimeError(f"grants.gov returned {start} of {total} opportunities")
    return _dedupe(records)


# --------------------------------------------------------------------------
# SAM.gov
# --------------------------------------------------------------------------

# Research contract calls -- DARPA, ONR, AFRL and ARPA-H Broad Agency
# Announcements -- are posted to SAM.gov and never reach grants.gov. Before
# this source the Illinois Research Board's copy was the only one we had.
SAM_URL = "https://api.sam.gov/opportunities/v2/search"
SAM_DESC_URL = "https://api.sam.gov/prod/opportunities/v1/noticedesc"

# The notice types that can be a call: solicitation, combined
# synopsis/solicitation, presolicitation, special notice. Award notices,
# sources sought, surplus sales and justifications cannot.
SAM_PTYPES = {
    "o": "solicitation",
    "k": "combined synopsis/solicitation",
    "p": "presolicitation",
    "s": "special notice",
}


class SamBudgetSpent(RuntimeError):
    """The run's SAM.gov request budget is used up. Not a failure of the
    notice: its description is fetched on a later run, so nothing is cached."""


class SamClient:
    """Counts every request against one per-run budget.

    A personal key for a non-federal user with no SAM.gov role allows 10
    requests a day (open.gsa.gov, API key rate limits). A 429 mid-run would
    fail the search, so the searches are spent first and descriptions get
    whatever is left; the rest are read on later runs.
    """

    def __init__(self, api_key, max_requests=9):
        if not api_key:
            raise RuntimeError("sam.gov: no API key; set GRANT_SIFT_SAM_API_KEY")
        self.key = api_key
        self.left = int(max_requests)

    def get(self, url, params):
        if self.left <= 0:
            raise SamBudgetSpent("sam.gov request budget spent for this run")
        self.left -= 1
        # requests puts the full URL, api_key included, into its exception
        # messages, and those are stored in sources.last_error and printed.
        # So nothing from requests is re-raised as is.
        try:
            r = requests.get(url, params={**params, "api_key": self.key},
                             headers=HEADERS, timeout=TIMEOUT)
        except requests.RequestException as exc:
            raise RuntimeError(f"sam.gov {urlsplit(url).path}: {type(exc).__name__}") from None
        if r.status_code == 429:
            self.left = 0
            raise RuntimeError("sam.gov: daily rate limit reached (429)")
        if r.status_code >= 400:
            raise RuntimeError(f"sam.gov {urlsplit(url).path}: HTTP {r.status_code} "
                               f"{r.text[:160].replace(self.key, '***')}")
        return r

    def detail(self, notice_id):
        """The description of one notice, which search returns only as a link.

        A notice posted without one answers 404 "Description not found"; that
        is an answer, cached like any other, not a failure to retry.
        """
        try:
            r = self.get(SAM_DESC_URL, {"noticeid": notice_id})
        except RuntimeError as exc:
            if "HTTP 404" in str(exc):
                return {}
            raise
        try:
            desc = r.json().get("description") or ""
        except ValueError:
            desc = r.text
        desc = _strip_html(desc)
        return {"synopsis": desc} if desc else {}


def _sam_keep(n, cfg):
    """Whether one notice is a research call worth reading.

    SAM.gov is overwhelmingly procurement, so the search is narrowed by office
    in config and this narrows again: a callable notice type, still active,
    not an announcement about a call (`exclude_terms`: RFIs, proposers'
    days), and either a BAA-like title or an R&D NAICS code (5417).
    """
    if str(n.get("active") or "").lower() not in ("yes", "true"):
        return False
    kind = str(n.get("baseType") or n.get("type") or "").strip().lower()
    if kind not in SAM_PTYPES.values():
        return False
    title = n.get("title") or ""
    if _sam_terms(cfg.get("exclude_terms"), title):
        return False
    naics = str(n.get("naicsCode") or "")
    if any(naics.startswith(p) for p in cfg.get("naics", ["5417"])):
        return True
    return _sam_terms(cfg.get("title_terms"), title)


def _sam_terms(terms, title):
    """Whether `title` holds any of `terms` as whole words, any case."""
    if not terms:
        return False
    pattern = r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")(?!\w)"
    return bool(re.search(pattern, title, re.I))


def sam_gov(cfg, client, today=None):
    """Active research calls from the offices named in `cfg["queries"]`.

    One search per query, posted within `lookback_days` (the API allows a
    year at most). A query with more notices than one page holds is refused,
    not truncated: narrow it in config.
    """
    today = today or date.today()
    look = min(int(cfg.get("lookback_days") or 364), 364)
    span = {"postedFrom": (today - timedelta(days=look)).strftime("%m/%d/%Y"),
            "postedTo": today.strftime("%m/%d/%Y")}
    limit = min(int(cfg.get("limit") or 1000), 1000)

    records = []
    for q in cfg.get("queries") or []:
        q = dict(q)
        name = q.pop("name")
        agency = q.pop("agency", name)
        path_re = q.pop("match", None)
        body = client.get(SAM_URL, {**q, **span, "limit": limit, "offset": 0}).json()
        total = int(body.get("totalRecords") or 0)
        if total > limit:
            raise RuntimeError(
                f"sam.gov {name}: {total} notices, over one page of {limit}. "
                "Narrow the query in config/sources.yaml -- reading the first "
                "page would be a quietly incomplete list")
        for n in body.get("opportunitiesData") or []:
            nid = str(n.get("noticeId") or "")
            if not nid or not _sam_keep(n, cfg):
                continue
            path = f"{n.get('fullParentPathName') or ''} {n.get('fullParentPathCode') or ''}"
            if path_re and not re.search(path_re, path, re.I):
                continue
            records.append({
                "id": f"sam:{nid}",
                "source": "sam.gov",
                "external_id": nid,
                "title": unescape(n.get("title") or "").strip(),
                "synopsis": "",
                "agency": agency,
                "url": f"https://sam.gov/opp/{nid}/view",
                # A BAA with no response date closes when SAM archives it.
                "deadline": _iso(n.get("responseDeadLine")) or _iso(n.get("archiveDate")),
                "award_ceiling": None,
                "indirect_cap": None,
                "raw": {
                    "number": n.get("solicitationNumber"),
                    "type": n.get("type"),
                    "naics": n.get("naicsCode"),
                    "path": n.get("fullParentPathName"),
                    "posted": n.get("postedDate"),
                    "archive": n.get("archiveDate"),
                },
            })
    return _dedupe(records)


# --------------------------------------------------------------------------
# RSS / Atom (CURIOSS, ReSA, and any funder that publishes a feed)
# --------------------------------------------------------------------------

def rss(name, url):
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    root = ElementTree.fromstring(r.content)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    entries = root.findall(".//item") or root.findall(".//a:entry", ns)

    records = []
    for e in entries:
        def get(*tags):
            for t in tags:
                node = e.find(t) if not t.startswith("a:") else e.find(t, ns)
                if node is not None:
                    return (node.text or node.get("href") or "").strip()
            return ""

        title = get("title", "a:title")
        if not title:
            continue
        link = get("link", "a:link")
        records.append({
            "id": f"rss:{db.synthetic_id(url, title)}",
            "source": name,
            "external_id": None,
            "title": title,
            "synopsis": _strip_html(get("description", "a:summary", "a:content"))[:4000],
            "agency": name,
            "url": link or url,
            "deadline": None,
            "award_ceiling": None,
            "indirect_cap": None,
            "raw": {"feed": url},
        })
    return _dedupe(records)


# --------------------------------------------------------------------------
# Foundation pages, fetch, strip, let the model read it
# --------------------------------------------------------------------------

def foundation_page(conn, name, url, force=False, min_text=None):
    """No CSS selectors. A redesign changes the text, not the contract.

    Returns a list of records, or None when the page has not moved since the
    last run. None and [] mean different things and callers must not conflate
    them: None is "we did not read it", [] is "we read it and there were no
    calls in it". Counting the first as the second makes every stable page look
    like it is failing, which is how the stale banner stops being read.

    `min_text` raises the floor for one source. A global 500 cannot serve both
    a 43k corporate page and a 636-char programme list, and the pages that sit
    just over it -- Gates at 1,011, Cisco's index at 507 -- are exactly the ones
    that parse fine and contain no calls.
    """
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    text = _strip_html(r.text)
    floor = min_text or MIN_PAGE_TEXT

    # A crawler that dies loudly is fine; one that reports success on an empty
    # page is how you end up trusting a list that stopped being complete.
    # A bot wall (Wellcome answers 202 with no body) and a client-rendered page
    # (Sloan ships 4KB of JavaScript) both land here, and both used to be
    # recorded as a success with zero calls found.
    if len(text) < floor:
        raise RuntimeError(
            f"page text only {len(text)} chars (under {floor}); "
            "likely a bot wall or a JavaScript-rendered page, not a real listing"
        )

    if not db.page_changed(conn, url, text) and not force:
        return None  # hash before you spend; NOT the same as finding nothing

    calls = llm.extract_calls(text, name)
    records = []
    for c in calls:
        program = (c.get("program_name") or "").strip()
        if not program:
            continue
        records.append({
            "id": f"fnd:{db.synthetic_id(url, program)}",
            "source": name,
            "external_id": None,
            "title": program,
            "synopsis": c.get("synopsis") or "",
            # An aggregator lists other funders' calls; the page owner is only
            # the fallback.
            "agency": (c.get("funder") or "").strip() or name,
            "url": c.get("url") or url,
            "page_url": url,
            "deadline": _iso(c.get("deadline")),
            "award_ceiling": c.get("award_ceiling"),
            "indirect_cap": c.get("indirect_cap"),
            "raw": c,
        })
    return _dedupe(records)


# --------------------------------------------------------------------------
# Sitemap-expanded sources
# --------------------------------------------------------------------------

# A sitemap can be enormous -- gatesfoundation.org/sitemap_grants.xml lists
# 41,507 committed grants. Without a ceiling, one loose `include` is tens of
# thousands of fetches and model calls in a single night. Refuse loudly instead:
# silently taking the first N is the "reports success while going incomplete"
# failure this tool exists to avoid.
SITEMAP_MAX = 200


def _sitemap_urls(url, depth=0, seen=None):
    """Read a sitemap, descending into a <sitemapindex> at most two levels.

    Match nesting on the PATH, not the whole URL: Wellcome paginates its index
    as sitemap.xml?page=1, which an endswith(".xml") test mistakes for content.
    """
    seen = seen if seen is not None else set()
    if url in seen:
        return []
    seen.add(url)
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    body = r.text
    is_index = "<sitemapindex" in body[:2000].lower()
    out = []
    for loc in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body):
        path = loc.split("?", 1)[0].split("#", 1)[0]
        nested = path.endswith((".xml", ".xml.gz")) or "sitemap" in path.lower()
        if (is_index or nested) and depth < 2:
            out += _sitemap_urls(loc, depth + 1, seen)
        else:
            out.append(loc)
    return sorted(set(out))


def sitemap_pages(conn, cfg, force=False):
    """Expand ONE pinned sitemap into the call pages it lists, and read each.

    This exists because some funders publish a listing their own visitors can
    read but a fetcher cannot: Wellcome's schemes page is 1,947 chars of filter
    chrome around a result count, with all 13 titles injected by JavaScript.
    Their individual scheme pages are plain server-rendered HTML, and the
    sitemap is where you find out which ones exist.

    It is also the answer to churn. 63 of Wellcome's 112 scheme pages are
    already closed; pinning the live ones by hand means pruning 404s forever,
    and never seeing a scheme published next week. Here the reviewed thing is
    the RULE -- one domain, one include, one exclude, one ceiling -- and the
    URLs follow from it.

    Returns None when every page was unchanged, for the reason foundation_page
    does: "nothing was re-read" is not "nothing is there".
    """
    name = cfg["name"]
    urls = _sitemap_urls(cfg["sitemap"])
    inc, exc = cfg.get("include"), cfg.get("exclude")
    if inc:
        urls = [u for u in urls if re.search(inc, u)]
    if exc:
        urls = [u for u in urls if not re.search(exc, u)]
    cap = int(cfg.get("max") or SITEMAP_MAX)
    if len(urls) > cap:
        raise RuntimeError(
            f"{name}: sitemap matched {len(urls)} urls, over the cap of {cap}. "
            "Tighten `include`/`exclude` or raise `max` deliberately -- this is "
            "not truncated, because a quietly shortened list is the worse bug"
        )
    if not urls:
        raise RuntimeError(
            f"{name}: sitemap matched no urls for include={inc!r}. The site was "
            "reachable, so the pattern is stale, not the source"
        )

    records, read, failed = [], 0, []
    for u in urls:
        try:
            got = foundation_page(conn, name, u, force=force, min_text=cfg.get("min_text"))
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{u.rsplit('/', 1)[-1]}: {str(exc)[:60]}")
            continue
        if got is None:
            continue                       # unchanged since last run
        read += 1
        records += got
    # A closed scheme 404s (Wellcome moves it to a -closed slug), so a handful
    # of failures is the normal state of a healthy source, not an outage. All
    # of them failing is not.
    if failed and len(failed) == len(urls):
        raise RuntimeError(f"{name}: all {len(urls)} pages failed; first: {failed[0]}")
    if read == 0:
        return None
    return _dedupe(records)


# --------------------------------------------------------------------------
# Listing-expanded sources
# --------------------------------------------------------------------------

# Same reasoning as SITEMAP_MAX: a ceiling that refuses, never one that trims.
LISTING_PAGES_MAX = 20


def _listing_html(cfg):
    """The pinned listing and every ?<param>=N page after it, as raw HTML.

    The pager is read from the HTML's own next-page link, not counted in
    config: a fixed count silently misses page 8 the week the list grows.
    """
    url, name = cfg["listing"], cfg["name"]
    pg = cfg.get("paginate")
    pg = pg if isinstance(pg, dict) else ({} if pg else None)
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    out = [r.text]
    if pg is None:
        return out
    param = pg.get("param", "page")
    n = int(pg.get("start", 0)) + 1
    cap = int(pg.get("max") or LISTING_PAGES_MAX)
    sep = "&" if "?" in url else "?"
    while re.search(rf"[?&;]{re.escape(param)}={n}(?![0-9])", out[-1]):
        if len(out) >= cap:
            raise RuntimeError(
                f"{name}: pager goes past {cap} pages. Raise `paginate.max` "
                f"deliberately -- reading the first {cap} would be a quietly "
                "incomplete list"
            )
        r = requests.get(f"{url}{sep}{param}={n}", headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        out.append(r.text)
        n += 1
    return out


def listing_pages(conn, cfg, force=False):
    """Expand ONE pinned listing into the call pages it links to, and read each.

    The sitemap rule with the listing as the index. The Illinois Research Board
    lists 200+ calls, 30 to a page, each linking to its own /rfp/ page; the
    sitemap lists none of them. Reading the listing text instead meant one
    model call per page returning 30-46 calls, and the first such call timed
    out at 120s. A detail page is ~2k chars holding ONE call with the amount,
    funder and the funder's own link, which the listing row does not carry.

    Bounded like a sitemap rule: links on the listing's own domain only, one
    `include`, one `exclude`, and `max` as a refusal. Links are taken from
    href attributes by pattern, not by CSS selector, so a redesign that keeps
    the URL scheme keeps working. Duplicate links (UIUC shows each call under
    both View All and External) collapse here, before anything is fetched.
    """
    name = cfg["name"]
    base = urlsplit(cfg["listing"])
    inc, exc = cfg.get("include"), cfg.get("exclude")
    urls = set()
    for html in _listing_html(cfg):
        for href in re.findall(r"""href\s*=\s*["']([^"'#]+)""", html):
            u = urljoin(cfg["listing"], unescape(href))
            if urlsplit(u).netloc != base.netloc:
                continue
            path = urlsplit(u).path
            if inc and not re.search(inc, path):
                continue
            if exc and re.search(exc, path):
                continue
            urls.add(f"{base.scheme}://{base.netloc}{path}")
    urls = sorted(urls)
    cap = int(cfg.get("max") or SITEMAP_MAX)
    if len(urls) > cap:
        raise RuntimeError(
            f"{name}: listing linked {len(urls)} urls, over the cap of {cap}. "
            "Tighten `include`/`exclude` or raise `max` deliberately"
        )
    if not urls:
        raise RuntimeError(
            f"{name}: listing linked no urls for include={inc!r}. The site was "
            "reachable, so the pattern is stale, not the source"
        )

    records, read, failed = [], 0, []
    for u in urls:
        try:
            got = foundation_page(conn, name, u, force=force, min_text=cfg.get("min_text"))
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{u.rsplit('/', 1)[-1]}: {str(exc)[:60]}")
            continue
        if got is None:
            continue                       # unchanged since last run
        read += 1
        records += got
    if failed and len(failed) == len(urls):
        raise RuntimeError(f"{name}: all {len(urls)} pages failed; first: {failed[0]}")
    if read == 0:
        return None
    return _dedupe(records)


# --------------------------------------------------------------------------

def _dedupe(records):
    seen, out = set(), []
    for r in records:
        if r["id"] in seen or not r.get("title"):
            continue
        seen.add(r["id"])
        out.append(r)
    return out


def is_expired(rec, grace_days=1):
    """True when this record's deadline has already passed.

    Checked twice: once on the search response, and again after enrichment,
    because search2 often omits closeDate while the detail endpoint supplies a
    responseDate that is already in the past. Without the second check such a
    record is stored, pruned, and re-fetched every single run.
    """
    deadline = rec.get("deadline")
    if not deadline:
        return False
    cutoff = (datetime.utcnow() - timedelta(days=grace_days)).date().isoformat()
    return deadline < cutoff


def drop_expired(records, grace_days=1):
    return [r for r in records if not is_expired(r, grace_days)]
