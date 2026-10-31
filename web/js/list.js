// The calls list: filter state, the query, paging and the filter controls.

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

function deadlineRangeLabel() {
  if (!DL_FROM && !DL_TO) return "";
  if (DL_FROM && DL_TO) return ` due ${shortDate(DL_FROM)}–${shortDate(DL_TO)}`;
  if (DL_FROM) return ` due from ${shortDate(DL_FROM)}`;
  return ` due by ${shortDate(DL_TO)}`;
}

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

  paintPager("pager", PAGE, data.total, PAGE_SIZE);

  // Restore open chat panels that were on this page before re-render.
  const list = document.getElementById("list");
  for (const id of Object.keys(CHATS)) {
    const log = list.querySelector(`[data-chatlog="${CSS.escape(id)}"]`);
    if (!log || !(CHATS[id] || []).length) continue;
    setChat(list, id, true);
    log.innerHTML = CHATS[id].map(turnHTML).join("");
  }

  if (API) { paintFeedback(); } else {
    document.querySelectorAll("[data-vote],[data-chat],[data-intro],[data-fbsend]")
      .forEach(b => { b.disabled = true; });
  }
}

// The calls list, the roster and the sources all page through this.
function paintPager(id, page, total, size) {
  const nav = document.getElementById(id);
  if (total <= size) {
    nav.hidden = true;
    nav.innerHTML = "";
    return;
  }
  nav.hidden = false;
  const pages = Math.ceil(total / size);
  const btns = [];
  btns.push(`<button type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Previous</button>`);
  btns.push(`<span class="pages">`);
  const window = 2;
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || (p >= page - window && p <= page + window)) {
      btns.push(`<button type="button" data-page="${p}" ${p === page ? 'aria-current="page"' : ""}>${p}</button>`);
    } else if (p === page - window - 1 || p === page + window + 1) {
      btns.push(`<span>…</span>`);
    }
  }
  btns.push(`</span>`);
  btns.push(`<button type="button" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next</button>`);
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

document.getElementById("advbtn").addEventListener("click", e => {
  const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
  e.currentTarget.setAttribute("aria-expanded", String(open));
  document.getElementById("advbody").hidden = !open;
});

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
