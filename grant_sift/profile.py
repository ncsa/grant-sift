"""The deployment's profile: its organisation, how calls are scored, its
wording, digests and call-type chips.

Read from config/profile.yaml (or GRANT_SIFT_PROFILE) once, at import. Digests
and chips are declarative rules over columns every scored call already has, so
a different group can change them without touching code or re-scoring.

A rule is compiled to a predicate over a row (a dict or sqlite3.Row). Unknown
keys are an error at load: a typo must not become a rule that matches
everything.
"""

import os
from datetime import date, timedelta
from pathlib import Path

import yaml

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "profile.yaml"

RULE_KEYS = {"category", "source", "exclude_source", "min_score",
             "deadline_within_days", "has_match"}


class ProfileError(ValueError):
    pass


def _score(r):
    """A missing or unparseable score counts as 0, so a rule degrades to
    leaving the row out instead of raising TypeError."""
    s = r["score"]
    return s if isinstance(s, (int, float)) else 0


def _within(deadline, days):
    """Deadline on or before today + days. Rolling or unparseable: False."""
    if not deadline:
        return False
    try:
        return date.fromisoformat(deadline) <= date.today() + timedelta(days=days)
    except ValueError:
        return False


def _names(spec, key, where):
    v = spec[key]
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
        raise ProfileError(f"{where}: {key} must be a list of names")
    return frozenset(v)


def _int(spec, key, where):
    v = spec[key]
    if isinstance(v, bool) or not isinstance(v, int):
        raise ProfileError(f"{where}: {key} must be a whole number")
    return v


def compile_rule(spec, where="rule"):
    """A rule mapping -> predicate(row) -> bool. Every key given must hold."""
    unknown = set(spec) - RULE_KEYS - {"id", "label", "title"}
    if unknown:
        raise ProfileError(f"{where}: unknown key(s) {sorted(unknown)}; "
                           f"rules take {', '.join(sorted(RULE_KEYS))}")
    tests = []
    if "category" in spec:
        cats = _names(spec, "category", where)
        tests.append(lambda r: r["category"] in cats)
    if "source" in spec:
        srcs = _names(spec, "source", where)
        tests.append(lambda r: r["source"] in srcs)
    if "exclude_source" in spec:
        out = _names(spec, "exclude_source", where)
        tests.append(lambda r: r["source"] not in out)
    if "min_score" in spec:
        floor = _int(spec, "min_score", where)
        tests.append(lambda r: _score(r) >= floor)
    if "deadline_within_days" in spec:
        days = _int(spec, "deadline_within_days", where)
        tests.append(lambda r: _within(r["deadline"], days))
    if "has_match" in spec:
        want = spec["has_match"]
        if not isinstance(want, bool):
            raise ProfileError(f"{where}: has_match must be true or false")
        tests.append(lambda r: bool(r["match_name"]) == want)
    return lambda r: all(t(r) for t in tests)


def _entries(raw, key):
    """A list of {id, label, ...rule} with unique ids, in file order."""
    items = raw.get(key) or []
    if not isinstance(items, list):
        raise ProfileError(f"{key} must be a list")
    seen, out = set(), []
    for i, spec in enumerate(items):
        where = f"{key}[{i}]"
        if not isinstance(spec, dict) or not spec.get("id") or not spec.get("label"):
            raise ProfileError(f"{where}: needs an id and a label")
        if spec["id"] in seen:
            raise ProfileError(f"{where}: duplicate id {spec['id']!r}")
        seen.add(spec["id"])
        out.append({"id": str(spec["id"]), "label": str(spec["label"]),
                    "title": str(spec.get("title") or ""),
                    "test": compile_rule(spec, f"{where} ({spec['id']})")})
    return out


def _text(d, key, where):
    v = d.get(key)
    if not isinstance(v, str) or not v.strip():
        raise ProfileError(f"{where}.{key} is required")
    return v


def _described(raw, where, required):
    """[{id, description}] with unique ids, in file order."""
    items = raw if raw is not None else []
    if not isinstance(items, list) or (required and not items):
        raise ProfileError(f"{where} must be a {'non-empty ' if required else ''}list")
    seen, out = set(), []
    for i, it in enumerate(items):
        w = f"{where}[{i}]"
        if not isinstance(it, dict) or not isinstance(it.get("id"), str) or not it["id"]:
            raise ProfileError(f"{w}: needs an id")
        if it["id"] in seen:
            raise ProfileError(f"{w}: duplicate id {it['id']!r}")
        seen.add(it["id"])
        out.append({"id": it["id"], "description": _text(it, "description", w)})
    return out


def _scoring(raw):
    if not isinstance(raw, dict):
        raise ProfileError("scoring is required")
    return {"label": _text(raw, "label", "scoring").strip(),
            "prompt": _text(raw, "prompt", "scoring"),
            "guide": _text(raw, "guide", "scoring"),
            "categories": _described(raw.get("categories"), "scoring.categories", True),
            "axes": _described(raw.get("axes"), "scoring.axes", False)}


def parse(raw):
    """A loaded YAML mapping -> the profile the app reads."""
    if not isinstance(raw, dict):
        raise ProfileError("profile must be a mapping")
    org = raw.get("org") or {}
    group = raw.get("group") or {}
    scoring = _scoring(raw.get("scoring"))
    out = {"org": {k: _text(org, k, "org").strip()
                   for k in ("name", "email_domain", "contact_email", "ai_gateway")},
           "group": {k: _text(group, k, "group").strip()
                     for k in ("tagline", "description", "match_phrase")},
           "scoring": scoring,
           "digests": _entries(raw, "digests"),
           "call_types": _entries(raw, "call_types")}
    # A rule naming a category the scorer never assigns would match nothing,
    # silently. Most likely a typo, or a scoring change that left it behind.
    cats = {c["id"] for c in scoring["categories"]}
    for key in ("digests", "call_types"):
        for spec in raw.get(key) or []:
            names = spec.get("category") or []
            bad = sorted(set([names] if isinstance(names, str) else names) - cats)
            if bad:
                raise ProfileError(f"{key} {spec.get('id')!r}: category {bad} is not "
                                   f"a scoring category ({', '.join(sorted(cats))})")
    return out


def load(path=None):
    path = Path(path or os.environ.get("GRANT_SIFT_PROFILE") or DEFAULT_PATH)
    try:
        with open(path) as f:
            raw = yaml.safe_load(f)
    except FileNotFoundError:
        raise ProfileError(f"missing profile at {path}; see config/profile.yaml "
                           "or set GRANT_SIFT_PROFILE") from None
    try:
        return parse(raw)
    except ProfileError as exc:
        raise ProfileError(f"{path}: {exc}") from None


PROFILE = load()


def public():
    """What the page needs: wording and the chips, without the predicates."""
    return {"org": {k: PROFILE["org"][k] for k in ("name", "ai_gateway")},
            "group": PROFILE["group"],
            "score_label": PROFILE["scoring"]["label"],
            "call_types": [{k: c[k] for k in ("id", "label", "title")}
                           for c in PROFILE["call_types"]]}
