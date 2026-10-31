// Idea match: an idea, the calls that fit it, and the one to go for.

// ---- Idea match: idea text -> matching calls -> shortlist (browser-only) --
//
// Lives in this browser and nowhere else. The server stores no part of it -
// not the idea, not the calls, not the notes. Search results stay inside this
// panel and do not filter the homepage list.

const SHELF_KEY = "gs.shortlist";
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
          <span class="spacer"></span>
          <span class="votes">${trashBtn(it.id)}</span>
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
    <div class="ideagrid">
      <div class="ideaf">
        <label class="eyebrow" for="sh-idea">Your idea</label>
        <textarea id="sh-idea" rows="11" maxlength="4000"
          placeholder="What are you working on? Describe the idea in your own words.">${esc(SHELF.idea || "")}</textarea>
        <div class="shelfacts">
          <button type="button" class="primary" id="sh-search"
            title="Rematches the catalogue and ranks what it finds (~1 min). Editing the idea and leaving the field also re-ranks kept calls.">Match with all open calls</button>
          <span class="hint" id="sh-hint" aria-live="polite"></span>
        </div>
        <div class="aibar" data-aibar>${aiBarHTML()}</div>
      </div>
      ${recommendationHTML(SHELF.recommendation)}
    </div>
    ${cards}`;
}

// Until there is a pick, the panel says what will land there, so the space
// beside the idea is not a mystery.
const REC_IDLE = "Describe your idea and match it: the call to go for, and the runner-up, land here.";
const REC_BUSY = "Working on it\u2026 the call to go for lands here.";
function paintRecPending(text) {
  const p = document.querySelector("#sh-rec .placeholder");
  if (p) p.textContent = text;
}

// The model names calls by id ("gg:363852"). Swap each id it mentions for
// the call's title, linked to its row below; the first sentence is the pick,
// the rest (usually the runner-up) reads smaller.
function recommendationHTML(text) {
  if (!text) {
    return `<section class="bkout pending" id="sh-rec" aria-label="Recommendation">
        <span class="tag">Recommendation</span>
        <p class="placeholder">${_searchBusy || _scoreBusy ? REC_BUSY : REC_IDLE}</p>
      </section>`;
  }
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
  return `<section class="bkout" id="sh-rec" aria-label="Recommendation">
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
  if (!aiReady()) {
    setShelfHint("");
    openChatPanel(document.getElementById("sh-search"));
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
  paintRecPending(REC_BUSY);
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
    paintRecPending(REC_IDLE);
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
  if (!aiReady()) {
    if (hint) hint.textContent = "";
    openChatPanel(document.getElementById("sh-search"));
    return;
  }
  _scoreBusy = true;
  if (hint) hint.textContent = "Generating recommendation\u2026";
  paintRecPending(REC_BUSY);
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
    paintRecPending(REC_IDLE);
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
