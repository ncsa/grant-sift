"""Model calls at ingest: extraction and assessment, run offline by the pipeline.

The gateway settings below (BASE_URL, API_KEY, MODEL) are also the web app's
default for Idea match and chat on a call, so those work without the viewer
bringing a key. That request-path code lives in server.py, not here: nothing
in this module is called from a request.
"""

import json
import os
import re
import time

import requests

from . import profile

# NCSA Lumen, the default gateway: a self-hosted OpenAI-compatible proxy.
# BASE_URL is the prefix only, "/chat/completions" is appended below.
DEFAULT_BASE_URL = "https://lumen.ncsa.illinois.edu/v1"

# Lumen proxies different backends per deployment, so a default model id is a
# guess about that routing table, not a fact. Confirm it is in /v1/models and
# override GRANT_SIFT_LLM_MODEL if your key routes elsewhere.
#
# gemma-4-31b-it over glm-5.2: benchmarked on real records from this pipeline
# it produced identical scores for about a seventh of the cost, and it is not
# a reasoning model, so it does not spend the token budget thinking.
DEFAULT_MODEL = "gemma-4-31b-it"

BASE_URL = os.environ.get("GRANT_SIFT_LLM_BASE_URL", DEFAULT_BASE_URL)
API_KEY = os.environ.get("GRANT_SIFT_LLM_API_KEY", "")
MODEL = os.environ.get("GRANT_SIFT_LLM_MODEL") or DEFAULT_MODEL
# What the page calls the shared gateway ("NCSA Lumen"); its host otherwise.
GATEWAY_NAME = (os.environ.get("GRANT_SIFT_LLM_NAME") or "").strip() or (
    BASE_URL.split("//", 1)[-1].split("/", 1)[0])
TIMEOUT = int(os.environ.get("GRANT_SIFT_LLM_TIMEOUT", "120"))

# Reasoning models (glm-5.2 among them) bill their thinking against max_tokens
# and return it in a separate `reasoning_content` field. At max_tokens=800 the
# assess prompt spent the entire budget on reasoning and returned empty
# content, so every record scored 0 with "unparseable response". Measured: the
# assess call needs roughly 1,100 reasoning tokens plus about 250 of JSON.
ASSESS_MAX_TOKENS = int(os.environ.get("GRANT_SIFT_LLM_MAX_TOKENS", "4000"))

# Chain of thought is billed as output and, at a tight budget, can consume the
# whole allowance before any JSON is emitted. This task does not benefit from
# it: the answer is a score, a category and a roster match. Measured on
# glm-5.2 over real records, completion tokens fell from about 1,350 to 180
# with identical scores. Set GRANT_SIFT_LLM_THINKING=on to restore it.
THINKING = os.environ.get("GRANT_SIFT_LLM_THINKING", "off").strip().lower() in (
    "1", "on", "true", "yes")
EXTRACT_MAX_TOKENS = int(os.environ.get("GRANT_SIFT_LLM_EXTRACT_MAX_TOKENS", "8000"))


class TruncatedResponse(RuntimeError):
    """The budget ran out before the model emitted any answer.

    Not retryable: the same request with the same budget fails identically, so
    retrying only spends tokens. Raised rather than returned so the caller
    leaves the record unassessed and picks it up next run.
    """


def _require_config():
    """Fail once, clearly, instead of retrying three times into a 400."""
    if API_KEY:
        return
    raise RuntimeError(
        "LLM gateway not configured: GRANT_SIFT_LLM_API_KEY is unset.\n"
        f"Needs an API key for {GATEWAY_NAME} - for NCSA Lumen, a project key\n"
        "('sk_...') from the Lumen UI, not your OAuth login.\n\n"
        f"Gateway is {BASE_URL}\n"
        f"Model is {MODEL}\n"
        "Check that model is one your key can reach:\n"
        f'  curl -sS "{BASE_URL.rstrip("/")}/models" '
        '-H "Authorization: Bearer $GRANT_SIFT_LLM_API_KEY"\n'
        "See .env.example."
    )


def _post(messages, system, max_tokens=2000, retries=3):
    """OpenAI-compatible chat completions. Point BASE_URL at your in-house gateway."""
    _require_config()
    url = f"{BASE_URL.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }
    payload = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "temperature": 0,
        "messages": [{"role": "system", "content": system}] + messages,
    }
    if not THINKING:
        # Understood by the vLLM/SGLang-style backends Lumen proxies. Gateways
        # that do not recognise it ignore it; if yours rejects unknown fields,
        # set GRANT_SIFT_LLM_THINKING=on.
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    last = None
    for attempt in range(retries):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=TIMEOUT)
            r.raise_for_status()
            data = r.json()
            choice = (data.get("choices") or [{}])[0]
            content = ((choice.get("message") or {}).get("content") or "").strip()
            if content:
                return content
            usage = data.get("usage") or {}
            raise TruncatedResponse(
                f"model returned no content (finish_reason="
                f"{choice.get('finish_reason')}, reasoning_tokens="
                f"{usage.get('reasoning_tokens')}, max_tokens={max_tokens}). "
                "A reasoning model spent the whole budget thinking; raise "
                "GRANT_SIFT_LLM_MAX_TOKENS."
            )
        except TruncatedResponse:
            raise                      # deterministic, so do not burn retries
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2 ** attempt)
    raise RuntimeError(f"LLM call failed after {retries} attempts: {last}")


def _json(text, default):
    """Models sometimes fence their JSON. Strip and parse defensively."""
    if not text:
        return default
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"(\[.*\]|\{.*\})", cleaned, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass
    return default


# --------------------------------------------------------------------------
# 1. Foundation page extraction
# --------------------------------------------------------------------------

EXTRACT_SYSTEM = """You read funding pages and extract the open calls on them.

Return ONLY a JSON array. No preamble, no markdown fences. Empty array if the page
lists no open or upcoming funding calls.

Each element:
{
  "program_name":  "exact name of the call as written",
  "synopsis":      "2-3 sentences on what it funds and who is eligible",
  "deadline":      "YYYY-MM-DD, or null if rolling, unstated, or already passed",
  "award_ceiling": "as written, e.g. '$250,000 over 2 years', or null",
  "indirect_cap":  "as written, e.g. '10% of direct costs', or null",
  "url":           "application or details URL if one appears on the page, else null",
  "opportunity_number": "the funder's identifier for this call as written on the page,
                    e.g. 'RFA-OD-24-011', 'NSF 24-569', 'DE-FOA-0003200', else null",
  "funder":        "the organisation funding this call if it is not the page owner
                    (e.g. an aggregator listing NIH or Pfizer calls), else null"
}

Rules:
- Only calls that are open or announced as upcoming. Skip closed rounds, skip lists
  of past awardees, skip general programme descriptions with no application route.
- Do not infer a deadline that is not stated. null is correct and useful.
- indirect_cap matters and is often buried in the fine print. Look for it.
- opportunity_number only when the page or the link states it. Never invent one,
  and never give a related call's number (a companion or superseded notice).
- If the same call appears twice on the page, return it once."""


def extract_calls(page_text: str, source_name: str) -> list:
    text = page_text[:60000]
    out = _post(
        [{"role": "user", "content": f"Source: {source_name}\n\n---\n{text}"}],
        EXTRACT_SYSTEM,
        max_tokens=EXTRACT_MAX_TOKENS,
    )
    result = _json(out, [])
    return result if isinstance(result, list) else []


# --------------------------------------------------------------------------
# 2. Relevance classification + 3. Collaborator matching (one call, one pass)
# --------------------------------------------------------------------------

# The scoring prompt. Who the group is, its categories, score guide and axes
# come from config/profile.yaml (scoring:); how to match the roster, write the
# summary, extract facts and shape the JSON stays here, because the code reads
# that JSON. The default profile rebuilds the prompt the RSE instance has always
# used, byte for byte (tests/test_profile.py), so its stored scores stay valid.
# Changing scoring: in a profile means re-scoring that instance's calls.

_ROSTER_AND_SUMMARY = """Then match against the roster. Pick at most ONE person: the closest fit by domain
and by the kind of work involved. Copy match_domain verbatim from that roster
line's first field so it can be grouped on. If nobody on the roster is a real fit,
return null for every match field rather than reaching.

The roster has three sections and they mean different things.

  PAST COLLABORATIONS  work we actually did with an outside partner. Set
                       match_kind to "collaboration" and fill match_project.
  PROGRAMS WE RUN      platforms and communities we own. Set match_kind to
                       "program" and fill match_project. There is no outside
                       partner here, so never phrase it as one; the honest
                       framing is that the call could fund work on this.
  KNOWN CONTACTS       researchers we have only emailed. We have NOT worked with
                       them. Set match_kind to "contact" and match_project to
                       null. Never describe one of these as a past project, a
                       prior award, or an existing relationship; the honest
                       phrasing is that their research area lines up.

Prefer a real past collaboration when one fits comparably: an existing project is
worth more than a name we once emailed. Reach for a contact when their area is a
clearly better fit than anything in the first section, or when the first section
has nothing.

Also describe and measure the call itself.

"summary" is 2-3 sentences on what it funds and who is eligible. Write it for
someone who has not seen the call and is deciding whether to read it. It is NOT
a justification of the score: do not mention us, the roster, or fit.

Return null for "summary" when the synopsis is too thin to describe the call --
an RSS teaser such as "Read more...", a bare title, or a couple of words. Do
not reconstruct one from the title: an invented summary is read as fact.
This applies to "summary" ALONE. Always return a numeric score, a category and
a rationale, however thin the text; judge those from the title if that is all
there is.

"""

_AXES_INTRO = """"axes" are five INDEPENDENT 0-100 ratings. They measure different things and
are expected to disagree; a call can be high on one and near zero on another.
Do not smooth them toward each other or toward the score. Rate the call as
written, not its fit for us.

"""

_FACTS_AND_JSON_HEAD = """"facts" are extracted, not judged. Use null for anything the text does not
state; do not infer.

  call_domain       the call's OWN subject area, 2-4 words, lowercase
                    ("genomics and bioinformatics", "arctic science")
  award_ceiling_usd the largest dollar figure, as a plain integer, or null
  subaward_ok       true if subawards or collaborative proposals are allowed
  solicitation_type "single-pi" | "center" | "consortium" | "fellowship" |
                    "training" | "conference" | "other"

Return ONLY JSON, no fences:
{
  "score": 0-100,
  "category": "one of the above",
  "rationale": "one sentence, concrete, naming what makes it fit or not",
  "match_name": "collaborator name or null",
  "match_kind": "collaboration | program | contact | null",
  "match_domain": "the domain field of the roster line you matched, copied verbatim, or null",
  "match_project": "the past project, or null for a contact",
  "match_status": "warm | cold | prospect | departed | do-not-contact | null",
  "match_rationale": "one sentence on why this person, or null",
  "summary": "2-3 sentences on what it funds and who is eligible",
"""

_JSON_TAIL = """  "facts": {"call_domain": "...", "award_ceiling_usd": null,
            "subaward_ok": null, "solicitation_type": "..."}
}"""

_COUNT = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
          7: "seven", 8: "eight", 9: "nine", 10: "ten"}


def _hang(label, text, width):
    """'  label     first line' with later lines under the first."""
    lines = text.rstrip("\n").split("\n")
    pad = max(width, len(label) + 1)
    out = [f"  {label:<{pad}}{lines[0]}"]
    out += [" " * (pad + 2) + ln if ln else "" for ln in lines[1:]]
    return "\n".join(out)


def build_assess_system(scoring):
    """The scoring prompt for a profile's scoring: block."""
    parts = [scoring["prompt"].rstrip("\n"), "", "Categories:"]
    parts += [_hang(f'"{c["id"]}"', c["description"], 20) for c in scoring["categories"]]
    parts += ["", "Scoring guide:"]
    parts += ["  " + ln if ln else "" for ln in scoring["guide"].rstrip("\n").split("\n")]
    parts += ["", ""]
    text = "\n".join(parts) + _ROSTER_AND_SUMMARY
    axes = scoring["axes"]
    if axes:
        n = len(axes)
        text += _AXES_INTRO.replace("are five", f"are {_COUNT.get(n, n)}", 1)
        text += "\n".join(_hang(a["id"], a["description"], 19) for a in axes) + "\n\n"
    text += _FACTS_AND_JSON_HEAD
    if axes:
        items = [f'"{a["id"]}": 0-100' for a in axes]
        rows = [", ".join(items[i:i + 2]) for i in range(0, len(items), 2)]
        text += '  "axes": {' + ",\n           ".join(rows) + "},\n"
    return text + _JSON_TAIL


ASSESS_SYSTEM = build_assess_system(profile.PROFILE["scoring"])
AXES = tuple(a["id"] for a in profile.PROFILE["scoring"]["axes"])
# The category a call gets when the model names none.
CATCH_ALL = profile.PROFILE["scoring"]["categories"][-1]["id"]
FACTS = ("call_domain", "award_ceiling_usd", "subaward_ok", "solicitation_type")


def _clean_axes(result):
    """Keep the axis block only if it is complete and numeric.

    A partial block is worse than none. The dashboard's fallback for a missing
    block is to project the scalar score across all five axes, which is honest
    and orders records exactly as today; a block with two real numbers and
    three zeros silently ranks those records at the bottom of three lenses.

    Never raises. Axes are an enhancement, and a record that would otherwise
    score fine must not go back in the unassessed queue because one of them
    came back as a string.
    """
    raw = result.get("axes")
    if not isinstance(raw, dict):
        result["axes"] = None
        return result
    out = {}
    for k in AXES:
        try:
            out[k] = max(0, min(100, int(float(raw[k]))))
        except (KeyError, TypeError, ValueError):
            result["axes"] = None
            return result
    result["axes"] = out
    return result


def _clean_facts(result):
    """Facts are independent of each other, so unlike axes they degrade field
    by field: an unparseable award figure should not discard a good domain."""
    raw = result.get("facts")
    if not isinstance(raw, dict):
        result["facts"] = None
        return result
    out = {}
    for k in FACTS:
        v = raw.get(k)
        if isinstance(v, str) and v.strip().lower() in ("", "null", "none", "n/a", "unknown"):
            v = None
        out[k] = v
    if isinstance(out["award_ceiling_usd"], str):
        digits = re.sub(r"[^\d]", "", out["award_ceiling_usd"])
        out["award_ceiling_usd"] = int(digits) if digits else None
    if not isinstance(out["award_ceiling_usd"], (int, float)):
        out["award_ceiling_usd"] = None
    if not isinstance(out["subaward_ok"], bool):
        out["subaward_ok"] = None
    result["facts"] = out if any(v is not None for v in out.values()) else None
    return result


def assess(opportunity: dict, roster_block: str, corrections: str = "") -> dict:
    """Roster goes in the prompt whole. At a few hundred entries this beats
    embeddings on both match quality and explanation, and costs nothing."""
    parts = [f"COLLABORATOR ROSTER:\n{roster_block}"]
    if corrections:
        parts.append(
            "CALIBRATION, cases where our people disagreed with earlier scores. "
            "Weigh these:\n" + corrections
        )
    parts.append(
        "OPPORTUNITY:\n"
        f"Title: {opportunity.get('title')}\n"
        f"Agency/Funder: {opportunity.get('agency')}\n"
        f"Deadline: {opportunity.get('deadline')}\n"
        f"Award ceiling: {opportunity.get('award_ceiling')}\n"
        f"Synopsis: {(opportunity.get('synopsis') or '')[:6000]}"
    )
    out = _post([{"role": "user", "content": "\n\n".join(parts)}], ASSESS_SYSTEM,
                max_tokens=ASSESS_MAX_TOKENS)
    result = _json(out, {})
    # _json returns its default ({}) when parsing fails, and an empty dict is a
    # dict, so an isinstance check alone lets a scoreless result through.
    #
    # Raise rather than returning a score of 0. A 0 is indistinguishable from a
    # real judgement, sinks to the bottom of every list, and is never re-assessed,
    # so a parse failure would bury a live opportunity permanently. Raising
    # leaves the record unassessed and it is retried on the next run.
    if not isinstance(result, dict) or result.get("score") is None:
        raise ValueError(f"no score in model response: {str(out)[:200]!r}")
    try:
        result["score"] = max(0, min(100, int(float(result["score"]))))
    except (TypeError, ValueError):
        raise ValueError(f"non-numeric score {result.get('score')!r}")
    # After the score, never before: a malformed axis block must not cost us a
    # record whose score parsed cleanly.
    return _clean_facts(_clean_axes(result))


def format_corrections(rows) -> str:
    """Render calibration examples.

    Says which part of the answer was wrong when the reviewer specified it:
    a thumbs-down can mean the score, the category or the named collaborator,
    and a bare direction leaves the model guessing which.

    A reviewer's free text is quoted and flattened to one line. It reaches the
    prompt verbatim otherwise, which is an injection surface once anyone
    outside the group can click.
    """
    if not rows:
        return ""
    lines = []
    for r in rows:
        score = r["score"]
        verdict = r["verdict"]
        aspect = (r["aspect"] or "").strip().lower()
        agreed = (verdict == "down" and score < 50) or (verdict == "up" and score >= 70)

        if agreed:
            head = f'CONFIRMED: "{r["title"]}" scored {score}, and that was right'
        elif aspect == "category":
            head = (f'"{r["title"]}" scored {score} as {r["category"]}, '
                    f"the CATEGORY is wrong")
        elif aspect == "match":
            head = (f'"{r["title"]}" was matched to {r["match_name"]}, '
                    f"the WRONG collaborator")
        else:
            direction = "should score HIGHER" if verdict == "up" else "should score LOWER"
            head = f'"{r["title"]}" scored {score}, {direction}'

        note = (r["note"] or "").strip()
        if note:
            note = " ".join(note.split())[:200].replace('"', "'")
            head += f' (reviewer: "{note}")'
        lines.append("- " + head)
    return "\n".join(lines)
