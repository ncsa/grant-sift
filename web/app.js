const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// Search, filters, sort and paging are the server's (/api/opportunities,
// grant_sift/catalogue.py): the page, the API and the MCP tools share one
// implementation. SEEN keeps every row this tab has been sent, so the Idea
// match shelf can paint a call without asking again.
let SEEN = new Map(), GONE = new Set(), ACTIVE = new Set(), QUERY = "", SORT = "score", AREA = "", FUNDER = "";
let SORT_CHOSEN = false;
const PERSONAL = ["via-me", "my-sources", "my-digests"];
let DL_FROM = "", DL_TO = "", DL_MIN = "", DL_MAX = "";
// Award bounds in USD, "Added" as a number of days back, and the match pickers.
let AW_MIN = "", AW_MAX = "", POSTED_DAYS = "", M_KIND = "", M_STATUS = "";
// Minimum fit score, on the same bands as the Fit badge on each row.
let MIN_FIT = "";
let PAGE = 1, PAGE_SIZE = 25;

const daysAway = d => d ? Math.ceil((new Date(d + "T00:00:00") - new Date().setHours(0,0,0,0)) / 864e5) : null;
const esc = s => (s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// Some feeds hand over titles already entity-encoded ("Systems &amp; Services"),
// which esc() would then double. Decode once, before escaping for display.
const _ent = document.createElement("textarea");
function decode(s) {
  if (!s || !/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) return s;
  _ent.innerHTML = s;
  return _ent.value;
}

// "Oct 23, 2026", from an ISO date or timestamp.
function longDate(iso) {
  if (!iso) return "";
  const dt = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  return isNaN(dt) ? iso : `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

// A deadline decades out is a placeholder some listings use for "open until
// further notice"; a countdown of 18,000 days reads as a bug, not a date.
const SENTINEL_DAYS = 3650;

// "$4,000,000 – $12,000,000 per award over 5 years" -> head "$4M – $12M",
// note "per award over 5 years". The headline figure is what gets scanned;
// whatever qualifies it stays readable underneath.
function money(cur, n) {
  const fix = (v, u) => `${cur}${+v.toFixed(v < 10 ? 1 : 0)}${u}`;
  if (n >= 1e9) return fix(n / 1e9, "B");
  if (n >= 1e6) return fix(n / 1e6, "M");
  if (n >= 1e3) return fix(n / 1e3, "K");
  return `${cur}${n}`;
}
function awardParts(s) {
  if (!s) return null;
  const re = /([$€£])\s?(\d[\d,]*(?:\.\d+)?)/g;
  const hits = [...s.matchAll(re)];
  if (!hits.length) return { head: s, note: "" };
  const fig = h => money(h[1], Number(h[2].replace(/,/g, "")));
  const first = hits[0];
  let head = fig(first), end = first.index + first[0].length;
  const second = hits[1];
  if (second && /^\s*(to|–|—|-)\s*$/i.test(s.slice(end, second.index))) {
    head += " – " + fig(second);
    end = second.index + second[0].length;
  }
  const pre = s.slice(0, first.index).trim();
  if (/^up to$/i.test(pre)) head = "Up to " + head;
  else if (pre) return { head, note: s };
  const note = s.slice(end).replace(/^[\s,;.]+/, "").trim();
  return { head, note };
}

// Illinois Experts areas are often long comma-joined concept lists. Keep the
// full string as the filter value; shorten only what the browser paints.
function shortArea(d, max = 42) {
  if (!d) return "";
  if (d.length <= max) return d;
  const first = d.split(",")[0].trim();
  if (first.length >= 10 && first.length <= max) return first;
  return d.slice(0, max - 1).replace(/\s+\S*$/, "").trimEnd() + "…";
}

function shortDate(iso) {
  if (!iso) return "";
  const dt = new Date(iso + "T00:00:00");
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`;
}

function deadlineRangeLabel() {
  if (!DL_FROM && !DL_TO) return "";
  if (DL_FROM && DL_TO) return ` due ${shortDate(DL_FROM)}–${shortDate(DL_TO)}`;
  if (DL_FROM) return ` due from ${shortDate(DL_FROM)}`;
  return ` due by ${shortDate(DL_TO)}`;
}

const usd = n => n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`;

function awardRangeLabel() {
  if (AW_MIN && AW_MAX) return `award ${usd(AW_MIN)}–${usd(AW_MAX)}`;
  if (AW_MIN) return `award ${usd(AW_MIN)}+`;
  if (AW_MAX) return `award up to ${usd(AW_MAX)}`;
  return "";
}

// "Past N days" as the ISO date the server compares first_seen against.
// Local date, as the deadline pickers are.
function postedSince() {
  if (!POSTED_DAYS) return "";
  const d = new Date();
  d.setDate(d.getDate() - Number(POSTED_DAYS));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Both ends of the introduction: the researcher to approach, and whoever here
// already has a line to them. A match that leaves you hunting for an address
// in a spreadsheet has not saved anyone any work.
function mailto(name, email, extra) {
  // Name, then the address as its own visible link: an address hidden in a
  // title attribute is invisible on touch and cannot be copied.
  const link = email
    ? `<b>${esc(name)}</b> · <a href="mailto:${esc(email)}">${esc(email)}</a>`
    : `<b>${esc(name)}</b> <span class="noaddr">· no address on file</span>`;
  return link + (extra ? ` <span class="dept">· ${esc(extra)}</span>` : "");
}

function reach(o) {
  const c = o.contact || {};
  const lines = [];
  // Nothing to act on: no address, nobody here who knows them, nothing to
  // check. A row saying "no address on file" under a match that is a team
  // rather than a person is just a line of grey text.
  const anyInternal = (c.ncsa_contact || []).some(p => p.name);
  if (!c.email && !anyInternal && !c.review) {
    return `<div class="reach">${ROSTER_LINK}</div>`;
  }
  const where = [c.unit, c.org && c.org !== "UIUC" ? c.org : null]
    .filter(Boolean).join(", ");
  // A program is something we run, so there is no "them" to write to. Showing
  // one anyway produced "reach out to Luigi Marini, via us: Luigi Marini".
  // The internal row below is the whole answer.
  if (c.kind !== "program") {
    lines.push(`<div><span class="who">Them</span><span>${
      mailto(o.match_name, c.email, where)}</span></div>`);
  }

  if (c.ncsa_contact && c.ncsa_contact.length) {
    lines.push(`<div><span class="who">Via us</span><span>${
      c.ncsa_contact.map(p => mailto(p.name, p.email)).join(", ")}</span></div>`);
  }
  // Only shown when it changes what you would do: a bad address, or a person
  // who has left. Never sent to the model.
  if (c.review) {
    lines.push(`<div><span class="who">Check</span><span class="flag">${
      esc(c.review)}</span></div>`);
  }
  return `<div class="reach">${lines.join("")}${ROSTER_LINK}</div>`;
}
const ROSTER_LINK = `<button type="button" class="linkbtn rosterlink" data-open-roster>Who we know →</button>`;

// Bands carry the meaning: the score is a model estimate, so the word
// ("Strong fit") is the real resolution and the number sits beside it.
const SCORE_BANDS = [
  [80, "hi", "Strong fit"],
  [60, "mid", "Good fit"],
  [40, "lo", "Partial fit"],
  [0, "min", "Weak fit"],
];
const band = score => SCORE_BANDS.find(([min]) => score >= min) || SCORE_BANDS[3];
function scoreSignal(score) {
  return `<div class="score ${band(score)[1]}" title="How well this matches the group's work, scored 0 to 100 by the model">
      <div class="eyebrow">Fit</div>
      <div class="num" aria-label="Fit score ${score} of 100"><b>${score}</b><span>/100</span></div>
      <span class="fitpill ${band(score)[1]}">${band(score)[2]}</span>
    </div>`;
}

const ICON_CHAT = `<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`;
const ICON_UP = `<svg class="ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>`;
const ICON_DOWN = `<svg class="ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

// Countdown first, date second: "13 days / Due Nov 4, 2026". The old layout
// put the day of the month in the big figure, which read as a count.
// The dates the call's other listings give, where they differ from the one
// shown. The soonest is not always the one that applies -- grants.gov's is an
// announcement's expiry, the Research Board's may be a campus internal
// deadline or one round of several -- so each is shown with its source.
function otherDatesHTML(o) {
  const shownFrom = o.deadline_from || o.source;
  const seen = new Set([`${shownFrom}|${o.deadline || ""}`]);
  const lines = [{ source: o.source, deadline: o.listed_deadline }, ...(o.also_listed || [])]
    .filter(l => {
      const k = `${l.source}|${l.deadline || ""}`;
      if (seen.has(k) || (l.deadline || "") === (o.deadline || "")) return false;
      seen.add(k);
      return true;
    })
    .map(l => `<li><span class="src">${esc(l.source)}</span> ${l.deadline
      ? esc(longDate(l.deadline)) + (daysAway(l.deadline) < 0 ? " (passed)" : "")
      : "no date"}</li>`);
  return lines.length ? `<ul class="others" aria-label="Other listings' dates">${lines.join("")}</ul>` : "";
}

function whenHTML(o) {
  const away = daysAway(o.deadline);
  const others = otherDatesHTML(o);
  if (!o.deadline || away > SENTINEL_DAYS) {
    return `<div class="d word">Rolling</div><div class="m">No fixed date</div>${others}`;
  }
  // A sooner date from another listing (an NIH receipt date or a campus
  // internal deadline, where grants.gov has the expiry) names its source.
  const from = o.deadline_from ? `<div class="m per">per ${esc(o.deadline_from)}</div>` : "";
  const due = `<div class="m">Due ${esc(longDate(o.deadline))}</div>${from}${others}`;
  if (away < 0) return `<div class="d word">Passed</div>${due}`;
  if (away === 0) return `<div class="d word">Today</div>${due}`;
  return `<div class="d">${away}<span class="u">${away === 1 ? "day" : "days"}</span></div>${due}`;
}

// Asking without a key opens the key field where the chat would have been,
// rather than sending people off to a settings panel and back.
function keycardHTML(id, kind) {
  const ask = kind === "ask";
  return `<section class="keycard" data-keycard="${esc(id)}" hidden aria-labelledby="kc-${esc(id)}">
      <div>
        <h3 id="kc-${esc(id)}">${ask ? "Connect AI chat to ask about this call" : "Connect AI chat to match your idea"}</h3>
        <p>One-time step. The same key also turns on ${ask ? "Idea match" : "Ask about this call"}.</p>
      </div>
      <form class="keyf" data-keyform="${esc(id)}">
        <label class="flbl2" for="kk-${esc(id)}">Lumen API key</label>
        <span class="keyrow">
          <input id="kk-${esc(id)}" type="password" placeholder="sk_…" autocomplete="off">
          <button type="submit" class="primary">${ask ? "Save and ask" : "Save and match"}</button>
        </span>
        <span class="help">Your Lumen project key. Kept in this browser tab only; never stored on the server.</span>
      </form>
      <button type="button" class="linkbtn" data-provider>Use a different provider</button>
    </section>`;
}

function rowHTML(o, opts = {}) {
  const away = daysAway(o.deadline);
  const soon = away !== null && away >= 0 && away <= 30;
  // Idea match is narrower, so award and fit ride in the meta line there.
  const compact = !!opts.shelf;
  const title = decode(o.title);

  const award = awardParts(o.award_ceiling);
  const cap = o.indirect_cap
    ? `<span class="cap">Indirect capped at ${esc(o.indirect_cap)}</span>` : "";

  const hv = o.human;
  const verdict = hv
    ? `<span class="verdict ${hv.verdict === "down" ? "down" : ""}">Your group: ${
        hv.verdict === "down"
          ? "not for us" + (hv.aspect && hv.aspect !== "score" ? ` (${esc(hv.aspect)})` : "")
          : "useful"}</span>`
    : "";
  const kept = !opts.shelf && shelfHas(o.id) ? `<span class="kept">In Idea match</span>` : "";

  const meta = [`<span class="funder">${esc(o.agency || o.source)}</span>`];
  if (compact) {
    meta.push(award ? `<span>${esc(award.head)}</span>` : `<span>Award not stated</span>`);
    meta.push(`<span class="mininum" aria-label="Fit score ${o.score} of 100"><b>${o.score}</b>/100</span>`);
    meta.push(`<span class="fitpill ${band(o.score)[1]}">${band(o.score)[2]}</span>`);
  }
  // Other listings of this same call, folded in server-side. Worth a link:
  // the Research Board's copy is where a campus limited submission shows.
  const alsoOn = new Map();
  for (const a of o.also_listed || []) {
    if (a.source !== o.source && !alsoOn.has(a.source)) alsoOn.set(a.source, a.url);
  }
  if (alsoOn.size) {
    meta.push(`<span class="also">also on ${[...alsoOn].map(([src, url]) => url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="This call's listing on ${esc(src)}">${esc(src)}</a>`
      : esc(src)).join(", ")}</span>`);
  }
  if (kept) meta.push(kept);
  if (verdict) meta.push(verdict);
  if (cap) meta.push(cap);

  const area = o.match_domain
    ? `<button class="areatag" data-area="${esc(o.match_domain)}" title="Show calls in ${esc(o.match_domain)}">${esc(shortArea(o.match_domain))}</button>`
    : "";
  const flags = [
    o.match_status && o.match_status !== "warm" ? esc(o.match_status) : "",
    o.match_kind === "contact"
      ? `<span title="On the outreach list. We have emailed them; we have not worked with them.">lead, not a past project</span>` : "",
    o.match_kind === "program"
      ? `<span title="Something we run. There is no outside partner to approach; this call could fund work on it.">our own program</span>` : "",
  ].filter(Boolean).map(f => `<span class="cold"> · ${f}</span>`).join("");
  const fit = o.match_name ? `
    <div class="fit">
      <div class="fithead">
        <div class="fitwho"><span class="eyebrow">Closest fit</span><b>${esc(o.match_name)}</b>${
          o.match_project ? `<span class="proj"> — ${esc(o.match_project)}</span>` : ""}${flags}</div>
        ${area}
      </div>
      ${o.match_rationale ? `<p class="reason">${esc(o.match_rationale)}</p>` : ""}
      ${reach(o)}
    </div>` : "";

  const side = compact ? "" : `
    <aside class="side">
      <div>
        <div class="eyebrow">Award</div>
        ${award
          ? `<div class="amt">${esc(award.head)}</div>${award.note ? `<div class="amtnote">${esc(award.note)}</div>` : ""}`
          : `<div class="noamt">Not stated</div>`}
      </div>
      ${scoreSignal(o.score)}
    </aside>`;

  return `<li class="row${soon ? " soon" : ""}" id="${opts.shelf ? "sh-" : "c-"}${esc(o.id)}">
    <div class="when">${whenHTML(o)}</div>
    <div class="body">
      <div class="meta">${meta.join("")}</div>
      <h2 class="title">${o.url
        ? `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(title)}</a>`
        : esc(title)}</h2>
      ${o.rationale ? `<p class="why"><span class="tag">Why it fits</span>${esc(o.rationale)}</p>` : ""}
      ${o.summary ? `<p class="sumry">${esc(o.summary)}</p>` : ""}
      ${fit}
      <div class="acts">
        <button class="act" data-chat="${esc(o.id)}" aria-expanded="false">${ICON_CHAT}Ask about this call</button>
        ${opts.shelf ? `<button class="act" data-shrm="${esc(o.id)}">Remove</button>` : ""}
        <span class="spacer"></span>
        <span class="votes">
          <button class="vote" data-vote="up"   data-id="${esc(o.id)}" aria-pressed="false" title="Good find: score it higher next time">${ICON_UP}Useful</button>
          <button class="vote" data-vote="down" data-id="${esc(o.id)}" aria-pressed="false" title="Not for us: score it lower next time">${ICON_DOWN}Not for us</button>
        </span>
        <span class="votenote" data-fb="${esc(o.id)}"></span>
      </div>
      <div class="fbbox" data-fbbox="${esc(o.id)}">
        <select data-fbaspect="${esc(o.id)}" aria-label="what was wrong">
          <option value="score">the score</option>
          <option value="category">the category</option>
          <option value="match">the named collaborator</option>
        </select>
        <input type="text" maxlength="500" placeholder="one comment, optional: why?" data-fbnote="${esc(o.id)}">
        <button class="vote" data-fbsend="${esc(o.id)}">Send</button>
      </div>
      ${keycardHTML(o.id, "ask")}
      <div class="chat" data-chatbox="${esc(o.id)}">
        <div class="chathead">
          <b>Ask about this call</b>
          <span class="meta">model <span class="model" data-chatmodel="${esc(o.id)}"></span>
            · not stored on the server</span>
        </div>
        <div class="privacy">Not recorded. This conversation lives only in this
          browser tab, goes to your own API key through a proxy that stores
          nothing, and is gone when you close or reload the tab. Copy or export
          it if you want to keep it.</div>
        <div class="log" data-chatlog="${esc(o.id)}"></div>
        <form data-chatform="${esc(o.id)}">
          <input type="text" placeholder="e.g. what would we need a domain PI for here?" data-chatinput="${esc(o.id)}" aria-label="Your question">
          <button class="vote" type="submit">Ask</button>
        </form>
        <div class="chatfoot">
          <button class="vote" data-copy="${esc(o.id)}" type="button">Copy</button>
          <button class="vote" data-export="${esc(o.id)}" type="button">Export .md</button>
          <button class="vote" data-clear="${esc(o.id)}" type="button">Clear</button>
          <span class="hint" data-chathint="${esc(o.id)}"></span>
        </div>
      </div>
    </div>
    ${side}
  </li>`;
}

// How many filters inside the folded Advanced search section are on, so a
// closed section still says it is narrowing the list.
const ADV_CHIPS = ["rolling", "-voted-down"];
function paintAdvancedCount() {
  const n = [MIN_FIT, DL_FROM || DL_TO, AW_MIN || AW_MAX, POSTED_DAYS, M_KIND, M_STATUS]
    .filter(Boolean).length + ADV_CHIPS.filter(f => ACTIVE.has(f)).length;
  const el = document.getElementById("adv-count");
  el.textContent = n;
  el.hidden = !n;
  el.setAttribute("aria-label", `${n} on`);
}

function queryParams() {
  paintAdvancedCount();
  const p = new URLSearchParams({ sort: SORT, page: PAGE, page_size: PAGE_SIZE });
  if (QUERY) p.set("q", QUERY);
  if (AREA) p.set("area", AREA);
  if (FUNDER) p.set("funder", FUNDER);
  if (DL_FROM) p.set("deadline_from", DL_FROM);
  if (DL_TO) p.set("deadline_to", DL_TO);
  if (MIN_FIT) p.set("min_score", MIN_FIT);
  if (AW_MIN) p.set("min_award", AW_MIN);
  if (AW_MAX) p.set("max_award", AW_MAX);
  if (POSTED_DAYS) p.set("posted_since", postedSince());
  if (M_KIND) p.set("match_kind", M_KIND);
  if (M_STATUS) p.set("match_status", M_STATUS);
  if (ACTIVE.size) p.set("filters", [...ACTIVE].join(","));
  return p;
}

let RENDER_SEQ = 0;

async function render() {
  // Typing fires a query per keystroke; only the newest answer may paint, or
  // a slow early response would overwrite the results for what was typed last.
  const seq = ++RENDER_SEQ;
  let data;
  try {
    const r = await fetch("api/opportunities?" + queryParams());
    data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `search failed (${r.status})`);
  } catch (e) {
    if (seq !== RENDER_SEQ) return;
    document.getElementById("list").innerHTML =
      `<li class="empty"><b>Could not load calls.</b> ${esc(String(e.message || e))}</li>`;
    return;
  }
  if (seq !== RENDER_SEQ) return;
  PAGE = data.page;
  data.opportunities.forEach(o => SEEN.set(o.id, o));

  const ctx = [
    data.total !== data.of ? `of ${data.of} open` : "",
    AREA ? `in "${shortArea(AREA)}"` : "",
    deadlineRangeLabel().trim(),
    MIN_FIT ? `fit ${MIN_FIT}+` : "",
    awardRangeLabel(),
    POSTED_DAYS ? `added in the past ${POSTED_DAYS} days` : "",
    data.total ? `Page ${data.page} of ${data.pages}` : "",
  ].filter(Boolean).join(" · ");
  document.getElementById("tally").innerHTML =
    `<span class="cnt">${data.total} ${data.total === 1 ? "call" : "calls"}</span>` +
    (ctx ? `<span class="ctx">${esc(ctx)}</span>` : "");

  document.getElementById("list").innerHTML = data.opportunities.length
    ? data.opportunities.map(o => rowHTML(o)).join("")
    : `<li class="empty"><b>Nothing matches those filters.</b>
         Clear a filter, or widen the search.</li>`;

  renderPager(data.pages, data.total);

  // Restore open chat panels that were on this page before re-render.
  for (const id of Object.keys(CHATS)) {
    const box = document.querySelector(`[data-chatbox="${CSS.escape(id)}"]`);
    const log = document.querySelector(`[data-chatlog="${CSS.escape(id)}"]`);
    if (!box || !log || !(CHATS[id] || []).length) continue;
    box.classList.add("on");
    paintChatModel(id);
    log.innerHTML = CHATS[id].map(turnHTML).join("");
  }

  if (API) { paintFeedback(); } else {
    document.querySelectorAll("[data-vote],[data-chat],[data-fbsend]")
      .forEach(b => { b.disabled = true; });
  }
}

function renderPager(pages, total) {
  const nav = document.getElementById("pager");
  if (total <= PAGE_SIZE) {
    nav.hidden = true;
    nav.innerHTML = "";
    return;
  }
  nav.hidden = false;
  const btns = [];
  btns.push(`<button type="button" data-page="${PAGE - 1}" ${PAGE <= 1 ? "disabled" : ""}>Previous</button>`);
  btns.push(`<span class="pages">`);
  const window = 2;
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || (p >= PAGE - window && p <= PAGE + window)) {
      btns.push(`<button type="button" data-page="${p}" ${p === PAGE ? 'aria-current="page"' : ""}>${p}</button>`);
    } else if (p === PAGE - window - 1 || p === PAGE + window + 1) {
      btns.push(`<span>…</span>`);
    }
  }
  btns.push(`</span>`);
  btns.push(`<button type="button" data-page="${PAGE + 1}" ${PAGE >= pages ? "disabled" : ""}>Next</button>`);
  nav.innerHTML = btns.join("");
}

document.getElementById("pager").addEventListener("click", e => {
  const b = e.target.closest("[data-page]");
  if (!b || b.disabled) return;
  const p = Number(b.dataset.page);
  if (!p || p === PAGE) return;
  PAGE = p;
  render();
  document.getElementById("list").scrollIntoView({ behavior: "smooth", block: "start" });
});


// ---------------------------------------------------------------------------
// Writes and chat. The list above already needs `run.py serve`; these also
// need a signed-in identity when auth is on. Without one the controls disable
// themselves rather than failing on click, so the list stays usable.
// ---------------------------------------------------------------------------
let API = false;
const CHATS = {};                       // opportunity id -> [{role, content}]

// The key lives in this variable and nowhere else: not in storage, not on
// the server. Saving it only makes it the one Ask and Idea match use.
let CHAT_KEY = "";
const keyBar = () => ({
  key:   CHAT_KEY,
  model: document.getElementById("k-model").value.trim(),
  base:  document.getElementById("k-base").value.trim(),
});

function saveChatSettings() {
  try {
    const { model, base } = keyBar();
    sessionStorage.setItem("gs.chat", JSON.stringify({ model, base }));
  } catch (e) {}
  document.querySelectorAll("[data-chatmodel]").forEach(el => {
    el.textContent = keyBar().model || "—";
  });
}

// sessionStorage, not localStorage: the key should not outlive the tab.
try {
  const saved = JSON.parse(sessionStorage.getItem("gs.chat") || "{}");
  if (saved.base) document.getElementById("k-base").value = saved.base;
  if (saved.model) document.getElementById("k-model").value = saved.model;
} catch (e) {}

["k-base", "k-model"].forEach(id =>
  document.getElementById(id).addEventListener("change", saveChatSettings));

function saveKey(value) {
  CHAT_KEY = (value || "").trim();
  document.getElementById("k-key").value = CHAT_KEY;
  paintChatStatus();
  return !!CHAT_KEY;
}

// "Set up AI chat" stays the loudest thing in the top bar until a key is
// saved; then it quietens to an ordinary "AI chat" button.
function paintChatStatus() {
  const ready = !!CHAT_KEY;
  const btn = document.getElementById("chatbtn");
  btn.classList.toggle("solid", !ready);
  document.getElementById("chatbtn-lbl").textContent = ready ? "AI chat" : "Set up AI chat";
  document.getElementById("conn").classList.toggle("notready", !ready);
  document.querySelectorAll("[data-chatstatus]").forEach(el => {
    el.classList.toggle("ready", ready);
    el.textContent = ready ? "Ready" : "Not set up";
  });
}

document.getElementById("k-form").addEventListener("submit", e => {
  e.preventDefault();
  const ok = saveKey(document.getElementById("k-key").value);
  document.getElementById("k-note").textContent = ok
    ? "Saved for this tab. Ask about this call and Idea match are on."
    : "Your Lumen project key. Kept in this browser tab only; never stored on the server.";
});
paintChatStatus();

// ---- Idea match: idea text -> matching calls -> shortlist (browser-only) --
//
// Lives in this browser and nowhere else. The server stores no part of it -
// not the idea, not the calls, not the notes. Search results stay inside this
// panel and do not filter the homepage list.

const SHELF_KEY = "gs.shortlist";
const SHELF_KEYCARD = "__idea";
let SHELF = { idea: "", items: [], recommendation: "" };
let _scoreBusy = false;
let _scoredIdea = "";
let _searchBusy = false;

function loadShelf() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHELF_KEY) || "null");
    if (raw && Array.isArray(raw.items)) SHELF = { recommendation: "", ...raw };
    _scoredIdea = SHELF.idea || "";
  } catch (e) {}
}
function saveShelf() {
  try { localStorage.setItem(SHELF_KEY, JSON.stringify(SHELF)); } catch (e) {}
}
const shelfHas = id => SHELF.items.some(i => i.id === id);

function paintShelfBtn() {
  const n = SHELF.items.length;
  // The label carries the count, so it survives the button going icon-only.
  document.getElementById("shelfbtn").setAttribute("aria-label",
    n ? `Idea match, ${n} in shortlist` : "Idea match");
  const el = document.getElementById("shelf-n");
  if (!el) return;
  if (n) {
    el.hidden = false;
    el.textContent = n;
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

function setShelfHint(text, busy) {
  const hint = document.getElementById("sh-hint");
  const btn = document.getElementById("sh-search");
  if (hint) hint.textContent = text || "";
  if (btn) {
    btn.disabled = !!busy;
    btn.textContent = busy ? "Matching\u2026" : "Match with all open calls";
  }
}

function shelfCardHTML(it) {
  const o = SEEN.get(it.id);
  if (!o) {
    return `<li class="row" id="sh-${esc(it.id)}">
      <div class="when"><div class="d word">Closed</div></div>
      <div class="body">
        <h2 class="title">${esc(it.id)}</h2>
        <p class="mute">No longer in the open catalogue.</p>
        <div class="acts">
          <button class="act" data-shrm="${esc(it.id)}">Remove</button>
        </div>
      </div>
    </li>`;
  }
  return rowHTML(o, { shelf: true });
}

function renderShelf() {
  // Shelf ids come from localStorage or a focus run, so they may not be on
  // any page this tab has loaded. Fetch those once, then paint again; an id
  // the server no longer returns has closed and paints as "gone".
  const missing = SHELF.items.map(it => it.id).filter(id => !SEEN.has(id) && !GONE.has(id));
  if (missing.length) {
    fetch("api/opportunities?" + new URLSearchParams({ ids: missing.join(","), page_size: 200 }))
      .then(r => r.ok ? r.json() : { opportunities: [] })
      .then(d => {
        d.opportunities.forEach(o => SEEN.set(o.id, o));
        missing.filter(id => !SEEN.has(id)).forEach(id => GONE.add(id));
        renderShelf();
      })
      .catch(() => {});
  }
  const body = document.getElementById("shelf-body");
  const n = SHELF.items.length;
  const cards = n
    ? `<div class="shelfhead"><span>Matching calls</span><span>Shortlist · ${n}</span></div>
       <ol id="shelf-list">${SHELF.items.map(shelfCardHTML).join("")}</ol>`
    : "";
  body.innerHTML = `
    <div class="ideaf">
      <label class="eyebrow" for="sh-idea">Your idea</label>
      <textarea id="sh-idea" rows="6" maxlength="4000"
        placeholder="What are you working on? Describe the idea in your own words.">${esc(SHELF.idea || "")}</textarea>
      <div class="shelfacts">
        <button type="button" class="primary" id="sh-search"
          title="Describe the work, then match. Rematches the catalogue and ranks what it finds (~1 min). Editing the idea and leaving the field also re-ranks kept calls.">Match with all open calls</button>
        <span class="hint" id="sh-hint" aria-live="polite"></span>
      </div>
      ${keycardHTML(SHELF_KEYCARD, "match")}
    </div>
    ${SHELF.recommendation ? recommendationHTML(SHELF.recommendation) : ""}
    ${cards}`;
}

// The model names calls by id ("gg:363852"). Swap each id it mentions for
// the call's title, linked to its row below; the first sentence is the pick,
// the rest (usually the runner-up) reads smaller.
function recommendationHTML(text) {
  const ids = SHELF.items.map(i => i.id).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const link = chunk => {
    let out = esc(chunk);
    for (const id of ids) {
      const o = SEEN.get(id);
      if (!o || !out.includes(esc(id))) continue;
      out = out.split(esc(id)).join(
        `<a href="#sh-${esc(id)}">${esc(decode(o.title))}</a>`);
    }
    // "(<a>…</a>)" once the id was parenthesised after a name; drop the parens.
    return out.replace(/\(\s*(<a [^>]+>[^<]*<\/a>)\s*\)/g, "$1");
  };
  const m = text.match(/^(.+?[.!?])(\s+[\s\S]+)?$/);
  const pick = m ? m[1] : text, rest = m && m[2] ? m[2].trim() : "";
  return `<section class="bkout" aria-label="Recommendation">
      <span class="tag">Recommendation</span>
      <p class="pick">${link(pick)}</p>
      ${rest ? `<p class="rest">${link(rest)}</p>` : ""}
    </section>`;
}

async function runShelfSearch() {
  if (_searchBusy) return;
  const ideaEl = document.getElementById("sh-idea");
  const idea = (ideaEl ? ideaEl.value : SHELF.idea).trim();
  SHELF.idea = idea;
  saveShelf();
  if (!idea) { setShelfHint("Describe the idea first."); return; }
  const { key, model, base } = keyBar();
  if (!key) {
    setShelfHint("");
    showKeycard(document.getElementById("shelf-body"), SHELF_KEYCARD);
    return;
  }
  _searchBusy = true;
  // The /api/focus call is one long request (parallel catalogue chunks, then
  // a rank pass). Until we stream stages from the server, rotate honest
  // status copy and show elapsed time so the wait does not look stuck.
  const matchStages = [
    "Scanning open calls against your idea\u2026",
    "Reading the catalogue in parallel\u2026",
    "Gathering the strongest candidates\u2026",
    "Ranking matches by fit to your idea\u2026",
  ];
  const matchStarted = Date.now();
  let matchStage = 0;
  const paintMatchProgress = () => {
    const hint = document.getElementById("sh-hint");
    if (!hint) return;
    const sec = Math.max(1, Math.round((Date.now() - matchStarted) / 1000));
    hint.textContent = `${sec}s \u00b7 ${matchStages[matchStage]}`;
  };
  setShelfHint("", true);
  paintMatchProgress();
  const matchTimer = setInterval(() => {
    if (matchStage < matchStages.length - 1) matchStage++;
    paintMatchProgress();
  }, 12000);
  const matchClock = setInterval(paintMatchProgress, 1000);
  try {
    const r = await fetch("/api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, api_key: key, model, base_url: base }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `focus failed (${r.status})`);

    clearInterval(matchTimer);
    clearInterval(matchClock);
    _searchBusy = false;
    const btn = document.getElementById("sh-search");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Match with all open calls";
    }

    const results = data.results || [];
    // Replace, don't merge: this panel is the result set, not a side filter
    // on the homepage.
    SHELF.items = results.map(row => ({
      id: row.id, affinity: row.affinity, why: row.why,
    }));
    SHELF.recommendation = "";
    saveShelf();
    paintShelfBtn();
    renderShelf();
    if (!results.length) {
      setShelfHint(`Nothing matched, out of ${data.searched} open calls. `
        + "Try describing the work rather than the field.");
      return;
    }
    setShelfHint(`${results.length} of ${data.searched} open calls relate to this`
      + (data.trimmed ? ` (${data.trimmed} not searched)` : ""));
    await scoreShelf();
  } catch (e) {
    clearInterval(matchTimer);
    clearInterval(matchClock);
    setShelfHint(String(e.message || e).slice(0, 160));
  } finally {
    clearInterval(matchTimer);
    clearInterval(matchClock);
    _searchBusy = false;
    const btn = document.getElementById("sh-search");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Match with all open calls";
    }
  }
}

async function scoreShelf() {
  if (_scoreBusy) return;
  const hint = document.getElementById("sh-hint");
  const ideaEl = document.getElementById("sh-idea");
  if (ideaEl) SHELF.idea = ideaEl.value.trim();
  saveShelf();
  if (!SHELF.idea) {
    if (hint) hint.textContent = "Write the idea first.";
    return;
  }
  if (!SHELF.items.length) {
    if (hint) hint.textContent = "Nothing kept yet to rank.";
    return;
  }
  const { key, model, base } = keyBar();
  if (!key) {
    if (hint) hint.textContent = "";
    showKeycard(document.getElementById("shelf-body"), SHELF_KEYCARD);
    return;
  }
  _scoreBusy = true;
  if (hint) hint.textContent = "Generating recommendation\u2026";
  try {
    const r = await fetch("/api/rescore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: SHELF.idea, ids: SHELF.items.map(i => i.id),
                             api_key: key, model, base_url: base }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `${r.status}`);
    const by = Object.fromEntries((d.items || []).map(i => [i.id, i]));
    for (const it of SHELF.items) {
      if (by[it.id]) { it.affinity = by[it.id].affinity; it.why = by[it.id].why; }
    }
    SHELF.items.sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0));
    SHELF.recommendation = d.recommendation || "";
    _scoredIdea = SHELF.idea;
    saveShelf();
    paintShelfBtn();
    renderShelf();
    const done = document.getElementById("sh-hint");
    if (done) done.textContent = `scored ${d.scored} of ${d.of}`;
  } catch (e) {
    const err = document.getElementById("sh-hint");
    if (err) err.textContent = String(e.message || e).slice(0, 140);
  } finally {
    _scoreBusy = false;
  }
}

document.getElementById("shelf-body").addEventListener("click", async e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.shrm) {
    SHELF.items = SHELF.items.filter(i => i.id !== b.dataset.shrm);
    if (!SHELF.items.length) SHELF.recommendation = "";
    saveShelf(); paintShelfBtn(); renderShelf(); render();
    if (SHELF.items.length) scoreShelf();
    return;
  }
  if (b.id === "sh-search") return runShelfSearch();
});

document.getElementById("shelf-body").addEventListener("input", e => {
  if (e.target.id === "sh-idea") { SHELF.idea = e.target.value; saveShelf(); }
});

// Re-rank when the idea is edited and the field is left — not on every
// keystroke, which would thrash the model while someone is still typing.
document.getElementById("shelf-body").addEventListener("focusout", e => {
  if (e.target.id !== "sh-idea") return;
  const next = e.target.value.trim();
  if (next === _scoredIdea) return;
  SHELF.idea = next;
  saveShelf();
  if (next && SHELF.items.length) scoreShelf();
});

// Modals hold focus while open and hand it back to whatever opened them,
// named explicitly rather than read from activeElement: Safari does not focus
// a clicked button.
let MODAL_RETURN = null;
function showModal(m, focusEl, returnTo) {
  MODAL_RETURN = returnTo;
  m.hidden = false; m.classList.add("on");
  (focusEl || m.querySelector(".x")).focus();
}
function hideModal(m) {
  if (m.hidden) return;
  m.hidden = true; m.classList.remove("on");
  if (MODAL_RETURN && MODAL_RETURN.isConnected) MODAL_RETURN.focus();
  MODAL_RETURN = null;
}
document.addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  const m = document.querySelector(".modal-backdrop.on .modal");
  if (!m) return;
  const f = [...m.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")]
    .filter(el => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function openShelf() {
  closeMenus();
  renderShelf();
  showModal(document.getElementById("shelf-modal"), null, document.getElementById("shelfbtn"));
}
function closeShelf() {
  hideModal(document.getElementById("shelf-modal"));
}
document.getElementById("shelfbtn").addEventListener("click", e => {
  e.stopPropagation();
  openShelf();
});
document.getElementById("shelf-close").addEventListener("click", closeShelf);
document.getElementById("shelf-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeShelf();
});

function turnHTML(t) {
  const role = t.role === "user" ? "user" : "assistant";
  const label = role === "user" ? "You" : (t.model || keyBar().model || "Model");
  return `<div class="turn ${role}"><span class="from">${esc(label)}</span>${esc(t.content)}</div>`;
}

function paintChatModel(id, root) {
  root = root || document;
  const el = root.querySelector(`[data-chatmodel="${CSS.escape(id)}"]`);
  if (el) el.textContent = keyBar().model || "—";
}

function cardRoot(el) {
  return el.closest(".row") || document;
}

// ---- top-bar menus: Data and Account ----
const MENUS = [["databtn", "datamenu"], ["acctbtn", "acctmenu"]];
function closeMenus(except) {
  for (const [b, m] of MENUS) {
    if (b === except) continue;
    document.getElementById(m).hidden = true;
    document.getElementById(b).setAttribute("aria-expanded", "false");
  }
}
function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"]')].filter(el => el.offsetParent !== null);
}
for (const [b, m] of MENUS) {
  const btn = document.getElementById(b), menu = document.getElementById(m);
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = menu.hidden;
    closeMenus(b);
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) menuItems(menu)[0]?.focus();
  });
  btn.addEventListener("keydown", e => {
    if (e.key !== "ArrowDown" || !menu.hidden) return;
    e.preventDefault();
    btn.click();
  });
  menu.addEventListener("keydown", e => {
    const items = menuItems(menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === "Escape") { e.stopPropagation(); closeMenus(); btn.focus(); }
    else if (e.key === "Tab") closeMenus();
  });
  // Choosing an item closes its menu; the item's own handler does the rest.
  menu.addEventListener("click", e => { if (e.target.closest('[role="menuitem"]')) closeMenus(); });
}
document.addEventListener("click", e => {
  if (!e.target.closest(".menuwrap")) closeMenus();
});

// A panel opened from a menu item hands focus back to that menu's button,
// since the item itself is hidden by then.
function returnTarget(el) {
  if (!el || !el.closest) return null;
  const menu = el.closest(".menu");
  return menu ? document.querySelector(`[aria-controls="${menu.id}"]`) : el;
}

function openChatPanel(from, opts = {}) {
  closeMenus();
  if (opts.provider) document.getElementById("k-provider").open = true;
  showModal(document.getElementById("chat-modal"), document.getElementById("k-key"),
            returnTarget(from) || document.getElementById("chatbtn"));
}
function closeChatPanel() { hideModal(document.getElementById("chat-modal")); }
document.getElementById("chatbtn").addEventListener("click", e => openChatPanel(e.currentTarget));
document.getElementById("m-chat").addEventListener("click", e => openChatPanel(e.currentTarget));
document.getElementById("chat-close").addEventListener("click", closeChatPanel);
document.getElementById("chat-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeChatPanel();
});

function openDigests(from) {
  closeMenus();
  showModal(document.getElementById("digest-modal"), null,
            returnTarget(from) || document.getElementById("acctbtn"));
  loadSubscriptions();
}
function closeDigests() { hideModal(document.getElementById("digest-modal")); }
document.getElementById("m-digests").addEventListener("click", e => openDigests(e.currentTarget));
document.getElementById("manage-digests").addEventListener("click", e => openDigests(e.currentTarget));
document.getElementById("digest-close").addEventListener("click", closeDigests);
document.getElementById("digest-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeDigests();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeMenus();
    closeShelf();
    closeRoster();
    closeSources();
    closeChatPanel();
    closeDigests();
  }
});

function openRoster(from) {
  closeMenus();
  showModal(document.getElementById("roster-modal"), document.getElementById("r-search"),
            returnTarget(from) || document.getElementById("databtn"));
  loadRoster();
}
function closeRoster() {
  hideModal(document.getElementById("roster-modal"));
}
function openSources(from) {
  closeMenus();
  showModal(document.getElementById("sources-modal"), document.getElementById("s-search"),
            returnTarget(from) || document.getElementById("databtn"));
  loadSources();
}
function closeSources() {
  hideModal(document.getElementById("sources-modal"));
}
document.getElementById("open-sources").addEventListener("click", e => openSources(e.currentTarget));
document.getElementById("sources-close").addEventListener("click", closeSources);
document.getElementById("sources-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeSources();
});

document.getElementById("open-roster").addEventListener("click", e => openRoster(e.currentTarget));
document.getElementById("roster-close").addEventListener("click", closeRoster);
document.getElementById("roster-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeRoster();
});
// In-context ways in: "Who we know →" on a match, "Manage sources" on the
// coverage notice, "Use a different provider" on a key card.
document.addEventListener("click", e => {
  const r = e.target.closest("[data-open-roster]");
  if (r) return openRoster(r);
  const s = e.target.closest("[data-open-sources]");
  if (s) return openSources(s);
  const p = e.target.closest("[data-provider]");
  if (p) return openChatPanel(p, { provider: true });
});

let AUTH = { mode: "off", enforced: false, authenticated: false, username: null };

async function probeAPI() {
  try {
    const r = await fetch("api/health");
    API = r.ok;
  } catch (e) { API = false; }

  if (API) {
    try {
      AUTH = await (await fetch("api/whoami")).json();
    } catch (e) {}
    paintAccount();
    // "Me" only means something to a signed-in person.
    for (const f of PERSONAL) {
      const chip = document.querySelector(`.chip[data-filter="${f}"]`);
      if (!chip) continue;
      chip.hidden = !AUTH.authenticated;
      if (!AUTH.authenticated && ACTIVE.has(f)) {
        ACTIVE.delete(f);
        chip.setAttribute("aria-pressed", "false");
      }
    }
    document.getElementById("grp-mine").hidden = !AUTH.authenticated;
    // Writes will be refused without an identity once the gate is on, so do
    // not offer controls that are certain to fail.
    if (AUTH.enforced && !AUTH.authenticated) API = false;
    loadRoster();
    loadSubscriptions();
  }
  document.getElementById("whoami").hidden = !API;
  document.querySelectorAll("[data-vote],[data-chat],[data-fbsend]")
    .forEach(b => { b.disabled = !API; });
  if (!API) {
    document.querySelectorAll(".votenote").forEach(n => {
      n.textContent = "read only: start run.py serve for feedback and chat";
    });
  } else {
    loadFeedback();
  }
}

async function loadSubscriptions() {
  const hint = document.getElementById("sub-hint");
  const box = document.getElementById("sub-feeds");
  const emailEl = document.getElementById("sub-email");
  try {
    const r = await fetch("api/subscriptions");
    if (!r.ok) {
      hint.textContent = "Could not load subscriptions.";
      return;
    }
    const data = await r.json();
    emailEl.value = data.email || "";
    const on = new Set(data.feeds || []);
    box.innerHTML = (data.available || []).map(f =>
      `<label><input type="checkbox" data-feed="${esc(f.id)}"${on.has(f.id) ? " checked" : ""}>` +
      `<span>${esc(f.label)}</span></label>`).join("");
    hint.textContent = on.size
      ? `Subscribed to ${on.size} digest${on.size === 1 ? "" : "s"}.`
      : "Not subscribed yet.";
  } catch (e) {
    hint.textContent = "Could not load subscriptions.";
  }
}

document.getElementById("sub-save").addEventListener("click", async () => {
  const hint = document.getElementById("sub-hint");
  const feeds = [...document.querySelectorAll("#sub-feeds input[data-feed]:checked")]
    .map(el => el.dataset.feed);
  hint.textContent = "Saving…";
  try {
    const r = await fetch("api/subscriptions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feeds }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      hint.textContent = data.detail || `Save failed (${r.status})`;
      return;
    }
    hint.textContent = feeds.length
      ? `Saved. Digests go to ${data.email} after the nightly run.`
      : `Unsubscribed ${data.email}.`;
  } catch (e) {
    hint.textContent = "Save failed.";
  }
});

let FB = {};                            // opportunity id -> {up, down, note}

async function loadFeedback() {
  try {
    const r = await fetch("api/feedback");
    if (!r.ok) return;
    FB = (await r.json()).summary || {};
  } catch (e) { return; }
  paintFeedback();
}

// Painted from the cached summary, so re-rendering on a keystroke costs
// nothing. One request per page load, not one per visible row.
function paintFeedback() {
  document.querySelectorAll("[data-fb]").forEach(node => {
    const f = FB[node.dataset.fb];
    node.textContent = f
      ? `recorded: ${f.up} useful, ${f.down} not for us` + (f.note ? ` (latest: ${f.note})` : "")
      : "";
  });
}

// The roster and source lists are browsable, not just writable. A form you
// cannot read back is one people fill in twice: without seeing that Sarita
// Adve is already on the roster, the reasonable thing to do is add her again.
let ROSTER = [], SOURCES = [];
// Both lists open short and grow on demand. Rendering 285 collaborators at
// once buries the search box and makes the panel feel like a data dump rather
// than something you look things up in. "Show all" is always one click away
// for the times you do want the whole thing.
const PAGE_STEP = 5;
let R_SHOWN = PAGE_STEP, S_SHOWN = PAGE_STEP;

function moreBar(total, shown, id, noun) {
  if (total <= shown) {
    return total > PAGE_STEP
      ? `<div class="morebar"><span>all ${total} ${noun} shown</span>
           <button class="vote" data-collapse="${id}">Show fewer</button></div>`
      : "";
  }
  const next = Math.min(PAGE_STEP, total - shown);
  return `<div class="morebar">
      <span>showing ${shown} of ${total} ${noun}</span>
      <span><button class="vote" data-more="${id}">Show ${next} more</button>
      <button class="vote" data-all="${id}">Show all ${total}</button></span>
    </div>`;
}

// A search should start from the top of the results, not from wherever the
// previous query had been expanded to.
function resetRosterPage() { R_SHOWN = PAGE_STEP; renderRoster(); }
function resetSourcePage() { S_SHOWN = PAGE_STEP; renderSources(); }

document.addEventListener("click", e => {
  const b = e.target.closest("[data-more],[data-all],[data-collapse]");
  if (!b) return;
  const which = b.dataset.more || b.dataset.all || b.dataset.collapse;
  const isRoster = which === "r-more";
  const total = isRoster ? ROSTER.length : SOURCES.length;
  if (b.dataset.all) { if (isRoster) R_SHOWN = total; else S_SHOWN = total; }
  else if (b.dataset.collapse) { if (isRoster) R_SHOWN = PAGE_STEP; else S_SHOWN = PAGE_STEP; }
  else { if (isRoster) R_SHOWN += PAGE_STEP; else S_SHOWN += PAGE_STEP; }
  if (isRoster) renderRoster(); else renderSources();
});

function statusPill(st) {
  return `<span class="pill ${esc(st)}">${esc(st)}</span>`;
}

function renderRoster() {
  const q = (document.getElementById("r-search").value || "").trim().toLowerCase();
  const hit = ROSTER.filter(e => {
    if (!q) return true;
    return [e.name, e.unit, e.org, (e.areas || []).join(" "),
            (e.projects || []).map(p => p.title).join(" "), e.email]
      .join(" ").toLowerCase().includes(q);
  });
  document.getElementById("r-count").textContent =
    q ? `${hit.length} of ${ROSTER.length}` : `${ROSTER.length} on the roster`;

  R_SHOWN = Math.min(R_SHOWN, Math.max(PAGE_STEP, hit.length));
  const page = hit.slice(0, R_SHOWN);
  document.getElementById("rlist").innerHTML = hit.length
    ? page.map(e => {
        const areas = (e.areas || []).slice(0, 4).join(", ");
        const projects = (e.projects || []).map(p =>
          esc(p.title) + (p.years ? ` <span class="pill">${esc(p.years)}</span>` : "")).join(" · ");
        const via = (e.ncsa_contact || []).filter(c => c.name).map(c =>
          c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.name)}</a>` : esc(c.name)).join(", ");
        return `<div class="rrow">
          <span class="nm">${esc(e.name)}</span>
          ${statusPill(e.status)}
          ${e.origin === "dashboard" ? '<span class="pill added">added here</span>' : ""}
          ${e.email ? `<a href="mailto:${esc(e.email)}">${esc(e.email)}</a>` : ""}
          ${e.origin === "dashboard" && e.id
            ? `<button class="vote" data-retire="${e.id}">retire</button>` : ""}
          <span class="sub">${esc(e.unit || "")}${areas ? (e.unit ? " · " : "") + esc(areas) : ""}${
            projects ? "<br>" + projects : ""}${via ? "<br>via us: " + via : ""}</span>
        </div>`;
      }).join("") + moreBar(hit.length, R_SHOWN, "r-more", "collaborators")
    : "<i>nothing matches that search</i>";
}

async function loadRoster() {
  try {
    const r = await fetch("api/roster");
    if (!r.ok) {
      document.getElementById("rlist").innerHTML =
        `<i>${r.status === 401 || r.status === 403
          ? "sign in to browse the roster" : "could not load the roster"}</i>`;
      return;
    }
    ROSTER = (await r.json()).entries || [];
    // Warm first, then cold, then leads: the useful end of a 285-entry list.
    const rank = { warm: 0, cold: 1, prospect: 2, departed: 3 };
    ROSTER.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
                       || a.name.localeCompare(b.name));
    renderRoster();
  } catch (e) {
    document.getElementById("rlist").innerHTML = "<i>could not reach the server</i>";
  }
}

function renderSources() {
  const q = (document.getElementById("s-search").value || "").trim().toLowerCase();
  const hit = SOURCES.filter(s =>
    !q || [s.name, s.url, s.kind].join(" ").toLowerCase().includes(q));
  document.getElementById("s-count").textContent =
    q ? `${hit.length} of ${SOURCES.length}` : `${SOURCES.length} sources`;

  S_SHOWN = Math.min(S_SHOWN, Math.max(PAGE_STEP, hit.length));
  document.getElementById("slist").innerHTML = hit.length
    ? hit.slice(0, S_SHOWN).map(s => {
        // Health sits next to the source because a source that quietly stopped
        // yielding is the failure this tool exists to catch.
        const when = s.last_success
          // Stored in UTC; en-CA gives YYYY-MM-DD in the viewer's own zone.
          ? `last success ${new Date(s.last_success).toLocaleDateString("en-CA")}`
            + (s.last_yield != null ? `, ${s.last_yield} open call${s.last_yield === 1 ? "" : "s"}` : "")
          : "never succeeded";
        return `<div class="rrow">
          <span class="nm">${esc(s.name)}</span>
          <span class="pill">${esc(s.kind)}</span>
          ${s.origin === "dashboard" ? '<span class="pill added">added here</span>' : ""}
          ${s.stale ? '<span class="pill stale">stale</span>' : ""}
          ${s.origin === "dashboard" && s.id
            ? `<button class="vote" data-sretire="${s.id}">retire</button>` : ""}
          <span class="sub"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>
            <br>${esc(when)}${s.cadence ? " · " + esc(s.cadence) : ""}${
              s.last_error ? ' · <span style="color:var(--ember)">' + esc(s.last_error.slice(0, 90)) + "</span>" : ""}</span>
        </div>`;
      }).join("") + moreBar(hit.length, S_SHOWN, "s-more", "sources")
    : "<i>nothing matches that search</i>";
}

async function loadSources() {
  try {
    const r = await fetch("api/sources");
    if (!r.ok) {
      document.getElementById("slist").innerHTML =
        `<i>${r.status === 401 || r.status === 403
          ? "sign in to browse sources" : "could not load sources"}</i>`;
      return;
    }
    const d = await r.json();
    SOURCES = d.sources || [];
    renderSources();
  } catch (e) {
    document.getElementById("slist").innerHTML = "<i>could not reach the server</i>";
  }
}

document.getElementById("r-search").addEventListener("input", resetRosterPage);
document.getElementById("s-search").addEventListener("input", resetSourcePage);

document.getElementById("sform").addEventListener("submit", async e => {
  e.preventDefault();
  const hint = document.getElementById("s-hint");
  const body = {
    name: document.getElementById("s-name").value,
    url: document.getElementById("s-url").value,
    kind: document.getElementById("s-kind").value,
    cadence: document.getElementById("s-cadence").value,
    notes: document.getElementById("s-notes").value,
  };
  hint.textContent = "adding...";
  try {
    const r = await fetch("api/sources", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { hint.textContent = d.detail || `failed (${r.status})`; return; }
    hint.textContent = d.note || "added";
    ["s-name", "s-url", "s-notes"].forEach(i => { document.getElementById(i).value = ""; });
    loadSources();
  } catch (err) {
    hint.textContent = err.name === "TimeoutError" ? "timed out" : "could not reach the server";
  }
});

document.getElementById("slist").addEventListener("click", async e => {
  const b = e.target.closest("[data-sretire]");
  if (!b) return;
  b.disabled = true;
  try {
    await fetch(`api/sources/${b.dataset.sretire}/retire`, { method: "POST" });
    loadSources();
  } catch (err) { b.disabled = false; }
});

document.getElementById("rform").addEventListener("submit", async e => {
  e.preventDefault();
  const hint = document.getElementById("r-hint");
  const body = {
    domain: document.getElementById("r-domain").value,
    collaborator: document.getElementById("r-collab").value,
    project: document.getElementById("r-project").value,
    years: document.getElementById("r-years").value,
    our_role: document.getElementById("r-role").value,
    funders: document.getElementById("r-funders").value,
    status: document.getElementById("r-status").value,
    notes: document.getElementById("r-notes").value,
  };
  hint.textContent = "adding...";
  try {
    const r = await fetch("api/roster", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { hint.textContent = d.detail || `failed (${r.status})`; return; }
    hint.textContent = d.note || "added";
    ["r-domain","r-collab","r-project","r-years","r-role","r-funders","r-notes"]
      .forEach(i => { document.getElementById(i).value = ""; });
    loadRoster();
  } catch (err) {
    hint.textContent = err.name === "TimeoutError" ? "timed out" : "could not reach the server";
  }
});

document.getElementById("rlist").addEventListener("click", async e => {
  const b = e.target.closest("[data-retire]");
  if (!b) return;
  b.disabled = true;
  try {
    await fetch(`api/roster/${b.dataset.retire}/retire`, { method: "POST" });
    loadRoster();
  } catch (err) { b.disabled = false; }
});

// Thumbs reveal the comment box; the vote is only sent on Send, so one click
// cannot post an empty judgement by accident. Scoped to the card so a call
// on both the homepage and Idea match does not cross-wire.
function onCardClick(e) {
  const vote = e.target.closest("[data-vote]");
  if (vote && API) {
    const id = vote.dataset.id;
    const root = cardRoot(vote);
    const box = root.querySelector(`[data-fbbox="${CSS.escape(id)}"]`);
    root.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)
      .forEach(b => b.setAttribute("aria-pressed", b === vote));
    box.classList.add("on");
    box.dataset.verdict = vote.dataset.vote;
    box.querySelector("input").focus();
    return;
  }

  const send = e.target.closest("[data-fbsend]");
  if (send && API) { sendFeedback(send.dataset.fbsend, cardRoot(send)); return; }

  const chat = e.target.closest("[data-chat]");
  if (chat) {
    const id = chat.dataset.chat;
    const root = cardRoot(chat);
    if (!keyBar().key) {
      const card = root.querySelector(`[data-keycard="${CSS.escape(id)}"]`);
      if (card && !card.hidden) { card.hidden = true; chat.setAttribute("aria-expanded", "false"); }
      else showKeycard(root, id);
      return;
    }
    openChat(root, id, true);
  }
}

// Open (or with toggle, flip) a row's chat box. Also the end of "Save and ask".
function openChat(root, id, toggle) {
  const box = root.querySelector(`[data-chatbox="${CSS.escape(id)}"]`);
  const btn = root.querySelector(`[data-chat="${CSS.escape(id)}"]`);
  const card = root.querySelector(`[data-keycard="${CSS.escape(id)}"]`);
  if (card) card.hidden = true;
  if (toggle) box.classList.toggle("on"); else box.classList.add("on");
  if (btn) btn.setAttribute("aria-expanded", String(box.classList.contains("on")));
  if (!box.classList.contains("on")) return;
  paintChatModel(id, root);
  const pv = box.querySelector(".privacy");
  if (pv && AUTH.enforced && AUTH.authenticated) {
    pv.textContent = "Not stored. This conversation lives only in this browser"
      + " tab, goes to your own API key through a proxy that keeps nothing,"
      + " and is gone when you reload. Your sign-in is known to the proxy in"
      + " front of this app, so it is private rather than anonymous."
      + " Copy or export it to keep it.";
  }
  box.querySelector("input").focus();
}
document.getElementById("list").addEventListener("click", onCardClick);
document.getElementById("shelf-body").addEventListener("click", onCardClick);

function showKeycard(root, id) {
  const card = root.querySelector(`[data-keycard="${CSS.escape(id)}"]`);
  if (!card) return;
  card.hidden = false;
  const btn = root.querySelector(`[data-chat="${CSS.escape(id)}"]`);
  if (btn) btn.setAttribute("aria-expanded", "true");
  card.querySelector("input").focus();
}

// "Save and ask" / "Save and match": save the key, then carry on with what
// the person was doing when we asked for it.
document.addEventListener("submit", e => {
  const form = e.target.closest("[data-keyform]");
  if (!form) return;
  e.preventDefault();
  if (!saveKey(form.querySelector("input").value)) {
    form.querySelector("input").focus();
    return;
  }
  document.querySelectorAll("[data-keycard]").forEach(c => { c.hidden = true; });
  const id = form.dataset.keyform;
  if (id === SHELF_KEYCARD) { runShelfSearch(); return; }
  openChat(cardRoot(form), id);
});

function paintAccount() {
  const name = AUTH.authenticated ? (AUTH.username || AUTH.display || "") : "";
  const btn = document.getElementById("acctbtn");
  btn.setAttribute("aria-label", name ? `Account: ${name}` : "Account");
  document.getElementById("acct-who").hidden = !name;
  document.getElementById("acct-name").textContent = AUTH.email || name;
  if (name) {
    const local = (AUTH.username || AUTH.email || name).split("@")[0];
    const initials = (local.match(/[a-z]/gi) || []).slice(0, 2).join("").toUpperCase();
    if (initials) document.getElementById("acct-av").textContent = initials;
  }
}

async function sendFeedback(id, root) {
  root = root || document;
  const box  = root.querySelector(`[data-fbbox="${CSS.escape(id)}"]`)
            || document.querySelector(`[data-fbbox="${CSS.escape(id)}"]`);
  const note = box.querySelector("input").value.trim();
  const aspect = box.querySelector("[data-fbaspect]").value;
  const verdict = box.dataset.verdict;
  const label = root.querySelector(`[data-fb="${CSS.escape(id)}"]`)
             || document.querySelector(`[data-fb="${CSS.escape(id)}"]`);
  if (!verdict) return;
  label.textContent = "sending...";
  try {
    // The nightly job can hold SQLite's writer briefly, so allow for a wait,
    // but never leave the button saying "sending..." forever.
    const r = await fetch("api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opportunity_id: id, verdict, aspect, note }),
      signal: AbortSignal.timeout(45000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { label.textContent = d.detail || `failed (${r.status})`; return; }
    const f = FB[id] || { up: 0, down: 0, note: "" };
    if (verdict === "up") f.up++; else f.down++;
    f.note = note;
    FB[id] = f;
    // Say what actually happens, on all three timescales. The old message
    // claimed a calibration example even when the rule discarded the click.
    label.textContent = verdict === "down"
      ? "Recorded. Excluded from digests now; re-scored in tonight's run; "
        + "and it will inform how similar calls are scored."
      : "Recorded as confirmation. Re-scored in tonight's run, and kept as an "
        + "anchor for future scoring.";
    box.classList.remove("on");
    box.querySelector("input").value = "";
  } catch (err) {
    label.textContent = err.name === "TimeoutError"
      ? "timed out; the nightly job may be writing. Try again shortly."
      : "could not reach the server";
  }
}

// The transcript is deliberately not persisted anywhere, so these three are
// the only way to keep one. Built from the in-memory turns, not from the DOM.
function transcript(id) {
  const row = [...document.querySelectorAll(".row")]
    .find(r => r.querySelector(`[data-chatlog="${CSS.escape(id)}"]`));
  const title = row ? row.querySelector(".title").textContent.trim() : id;
  const head = [`# ${title}`, "", `Opportunity: ${id}`,
                `Exported: ${new Date().toISOString()}`,
                "", "Not stored server side. Exported from the browser tab.", "", "---", ""];
  const body = (CHATS[id] || []).map(t =>
    `**${t.role === "user" ? "You" : "Model"}**\n\n${t.content}\n`);
  return head.concat(body).join("\n");
}

async function onChatTools(e) {
  const copy = e.target.closest("[data-copy]");
  const exp  = e.target.closest("[data-export]");
  const clr  = e.target.closest("[data-clear]");
  if (!copy && !exp && !clr) return;
  const id = (copy || exp || clr).dataset.copy
          || (exp || clr).dataset.export || clr.dataset.clear;
  const root = cardRoot(copy || exp || clr);
  const hint = root.querySelector(`[data-chathint="${CSS.escape(id)}"]`);

  if (clr) {
    delete CHATS[id];
    root.querySelector(`[data-chatlog="${CSS.escape(id)}"]`).innerHTML = "";
    hint.textContent = "cleared from this tab";
    return;
  }
  if (!(CHATS[id] || []).length) { hint.textContent = "nothing to save yet"; return; }

  if (copy) {
    try {
      await navigator.clipboard.writeText(transcript(id));
      hint.textContent = "copied to clipboard";
    } catch (err) {
      // Clipboard needs a secure context, so plain http on a LAN address fails.
      hint.textContent = "clipboard blocked here; use Export .md";
    }
    return;
  }

  const blob = new Blob([transcript(id)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `grant-sift-${id.replace(/[^A-Za-z0-9]+/g, "-")}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  hint.textContent = "exported";
}
document.getElementById("list").addEventListener("click", onChatTools);
document.getElementById("shelf-body").addEventListener("click", onChatTools);

async function onChatSubmit(e) {
  const form = e.target.closest("[data-chatform]");
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.chatform;
  const root = cardRoot(form);
  const input = form.querySelector("input");
  const q = input.value.trim();
  if (!q) return;

  const { key, model, base } = keyBar();
  const hint = root.querySelector(`[data-chathint="${CSS.escape(id)}"]`);
  if (!key) {
    showKeycard(root, id);
    return;
  }

  paintChatModel(id, root);
  const log = root.querySelector(`[data-chatlog="${CSS.escape(id)}"]`);
  CHATS[id] = CHATS[id] || [];
  CHATS[id].push({ role: "user", content: q });
  log.insertAdjacentHTML("beforeend", turnHTML({ role: "user", content: q }));
  input.value = "";
  hint.textContent = "thinking...";
  log.scrollTop = log.scrollHeight;

  try {
    const r = await fetch("api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opportunity_id: id, api_key: key, model, base_url: base,
        messages: CHATS[id],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { hint.textContent = d.detail || `failed (${r.status})`; return; }
    CHATS[id].push({ role: "assistant", content: d.content, model });
    log.insertAdjacentHTML("beforeend", turnHTML({ role: "assistant", content: d.content, model }));
    const u = d.usage || {};
    hint.textContent = u.prompt_tokens
      ? `${u.prompt_tokens} in / ${u.completion_tokens} out tokens · ${model}`
      : model;
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    hint.textContent = "could not reach the server";
  }
}
document.getElementById("list").addEventListener("submit", onChatSubmit);
document.getElementById("shelf-body").addEventListener("submit", onChatSubmit);

function boot(cat) {
  document.getElementById("n-open").textContent  = cat.open;
  document.getElementById("n-soon").textContent  = cat.soon;
  document.getElementById("n-match").textContent = cat.matched;
  document.getElementById("asof").textContent =
    cat.updated_at ? "Updated " + longDate(cat.updated_at) : "Not yet updated";

  // Built from the data, not from a hardcoded list, so it always reflects the
  // roster as it actually matched. Commonest first, counted by the server.
  const sel = document.getElementById("area");
  cat.areas.forEach(({ name, count }) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${shortArea(name, 36)} (${count})`;
    opt.title = name;
    sel.appendChild(opt);
  });
  if (!cat.areas.length) sel.disabled = true;

  const fsel = document.getElementById("funder");
  cat.funders.forEach(({ name, count }) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${name} (${count})`;
    fsel.appendChild(opt);
  });
  if (!cat.funders.length) fsel.disabled = true;

  // Bound the pickers to the live catalogue so they are not scrolling
  // through 1990. Tightened further as each end of the range is set.
  if (cat.deadline_min) {
    DL_MIN = cat.deadline_min;
    DL_MAX = cat.deadline_max;
    syncDateBounds();
  }

  const stale = cat.stale_sources || [];
  if (stale.length) {
    const names = stale.map(s => esc(s.name));
    const list = names.length > 1
      ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0];
    document.getElementById("alarm").innerHTML =
      `<div class="alarm" role="note">
         <svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
         <span><b>Coverage may be incomplete.</b> ${list}
         ${stale.length > 1 ? "have" : "has"} not updated in over 30 days.
         <button type="button" class="linkbtn" data-open-sources>Manage sources</button></span></div>`;
  }
  let scored = "unknown";
  if (cat.updated_at) {
    const t = new Date(cat.updated_at);
    scored = isNaN(t) ? cat.updated_at
      : `${longDate(cat.updated_at)}, ${t.toISOString().slice(11, 16)} UTC`;
  }
  document.getElementById("foot").innerHTML =
    `Scored ${esc(scored)}. Scores and collaborator matches are model-generated; treat them as a first pass, not a decision.` +
    ` <a href="https://github.com/ncsa/grant-sift/wiki/Grant-Sift-in-Claude:-setup" target="_blank" rel="noopener">Connect your AI assistant (MCP)</a>`;
  loadShelf();
  paintShelfBtn();
  render();
  probeAPI();
}

// One query per pause in typing, not per keystroke.
let QUERY_TIMER = null;
document.getElementById("q").addEventListener("input", e => {
  clearTimeout(QUERY_TIMER);
  QUERY_TIMER = setTimeout(() => {
    QUERY = e.target.value.trim();
    // A search is ranked by how well it matches, until the reader picks a
    // sort themselves; clearing the search goes back to the score.
    if (!SORT_CHOSEN) {
      SORT = QUERY ? "relevance" : "score";
      document.getElementById("sort").value = SORT;
    }
    PAGE = 1;
    render();
  }, 200);
});
document.getElementById("sort").addEventListener("change", e => {
  SORT = e.target.value; SORT_CHOSEN = true; PAGE = 1; render();
});
document.getElementById("area").addEventListener("change", e => {
  AREA = e.target.value; PAGE = 1; render();
});
document.getElementById("funder").addEventListener("change", e => {
  FUNDER = e.target.value; PAGE = 1; render();
});
// A bound on award size leaves out calls whose award is unknown, as the
// deadline range does with rolling calls.
function onAwardRange() {
  const lo = document.getElementById("award-min");
  const hi = document.getElementById("award-max");
  AW_MIN = lo.value; AW_MAX = hi.value;
  // Grey out the options that would make an empty range.
  for (const o of hi.options) o.disabled = !!(o.value && AW_MIN && +o.value < +AW_MIN);
  for (const o of lo.options) o.disabled = !!(o.value && AW_MAX && +o.value > +AW_MAX);
  PAGE = 1;
  render();
}
document.getElementById("award-min").addEventListener("change", onAwardRange);
document.getElementById("award-max").addEventListener("change", onAwardRange);
document.getElementById("fit").addEventListener("change", e => {
  MIN_FIT = e.target.value; PAGE = 1; render();
});
document.getElementById("posted").addEventListener("change", e => {
  POSTED_DAYS = e.target.value; PAGE = 1; render();
});
document.getElementById("match-kind").addEventListener("change", e => {
  M_KIND = e.target.value; PAGE = 1; render();
});
document.getElementById("match-status").addEventListener("change", e => {
  M_STATUS = e.target.value; PAGE = 1; render();
});
function syncDateBounds() {
  const from = document.getElementById("dl-from");
  const to = document.getElementById("dl-to");
  from.min = DL_MIN;
  to.max = DL_MAX;
  from.max = DL_TO || DL_MAX;
  to.min = DL_FROM || DL_MIN;
}
function onDeadlineRange() {
  DL_FROM = document.getElementById("dl-from").value;
  DL_TO = document.getElementById("dl-to").value;
  syncDateBounds();
  PAGE = 1;
  render();
}
["change", "input"].forEach(ev => {
  document.getElementById("dl-from").addEventListener(ev, onDeadlineRange);
  document.getElementById("dl-to").addEventListener(ev, onDeadlineRange);
});
// Clicking an area tag on a row filters to it, and keeps the picker in sync.
document.getElementById("list").addEventListener("click", e => {
  const tag = e.target.closest(".areatag");
  if (!tag) return;
  AREA = AREA === tag.dataset.area ? "" : tag.dataset.area;
  document.getElementById("area").value = AREA;
  PAGE = 1;
  render();
});
document.querySelectorAll(".chip").forEach(btn => {
  btn.addEventListener("click", () => {
    const f = btn.dataset.filter;
    ACTIVE.has(f) ? ACTIVE.delete(f) : ACTIVE.add(f);
    btn.setAttribute("aria-pressed", ACTIVE.has(f));
    PAGE = 1;
    render();
  });
});

fetch("api/catalogue")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(boot)
  .catch(() => {
    document.getElementById("list").innerHTML =
      `<div class="empty"><b>Could not reach the catalogue.</b>
       Start the server with <code>python run.py serve</code>; if it is running,
       run <code>python run.py daily</code> to fill it.</div>`;
    document.getElementById("asof").textContent = "no data";
  });

// Optional Grafana link: the Ops & signal item in the Data menu.
fetch("/api/config")
  .then(r => r.ok ? r.json() : null)
  .then(cfg => {
    const url = cfg && (cfg.grafana_url || cfg.grafana_embed_url);
    if (!url) return;
    const link = document.getElementById("grafana-link");
    // Prefer a normal dashboard URL (drop kiosk if present).
    link.href = url.replace(/([?&])kiosk(=[^&]*)?/, "$1").replace(/\?&/, "?").replace(/[?&]$/, "") || url;
    document.getElementById("grafana-grp").hidden = false;
  })
  .catch(() => {});
