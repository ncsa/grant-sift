// Idea match: a mode of the dashboard. An idea in, the calls that fit it in
// the main list, and the one to go for above it.

// Lives in this browser and nowhere else. The server stores no part of it -
// not the idea, not the matched calls, not the recommendation. The key is the
// one the old shortlist panel used, so a match made there survives the move.
const IDEA_KEY = "gs.shortlist";
// items: [{id, affinity, why}], best first. matched: the idea text the items
// were found for, so an edited idea can say its results are older than it.
let IDEA = { idea: "", items: [], recommendation: "", matched: "", searched: 0, on: false };
let _matchBusy = false;
let _rankBusy = false;
// The dashboard page when the mode came on, so turning it off lands there.
let _pageBefore = 1;

function loadIdea() {
  try {
    const raw = JSON.parse(localStorage.getItem(IDEA_KEY) || "null");
    if (raw && Array.isArray(raw.items)) IDEA = { ...IDEA, ...raw };
    // Saved by the old panel, which kept no record of what it matched.
    if (IDEA.matched === undefined || (!IDEA.matched && IDEA.items.length)) IDEA.matched = IDEA.idea;
  } catch (e) {}
}
function saveIdea() {
  try { localStorage.setItem(IDEA_KEY, JSON.stringify(IDEA)); } catch (e) {}
}

// What render() in list.js needs: null when the mode is off.
const ideaView = () => IDEA.on ? { items: IDEA.items } : null;

const ideaEl = () => document.getElementById("idea");
function ideaText() { return ideaEl().value.trim(); }

function setIdeaHint(text, err = false) {
  const el = document.getElementById("idea-hint");
  el.textContent = text || "";
  el.classList.toggle("err", !!err);
}

function paintIdeaMode() {
  const on = IDEA.on;
  document.getElementById("ideabox").classList.toggle("on", on);
  document.getElementById("idea-on").checked = on;
  // The same sort, named for what it ranks by in each mode.
  document.querySelector('#sort option[value="score"]').textContent =
    on ? "Best fit to idea" : "Highest relevance";
  const btn = document.getElementById("idea-match");
  btn.disabled = _matchBusy;
  btn.textContent = _matchBusy ? "Matching…" : IDEA.items.length ? "Match again" : "Match";
}

function ideaEmptyHTML() {
  if (_matchBusy) {
    return `<li class="empty"><b>Matching your idea against every open call…</b>
      About a minute. The matches land here, best fit first.</li>`;
  }
  if (!IDEA.idea.trim()) {
    return `<li class="empty"><b>Describe your idea above.</b>
      Then Match: the open calls that fit it land here, best fit first.</li>`;
  }
  if (IDEA.matched && IDEA.matched === IDEA.idea.trim()) {
    return `<li class="empty"><b>No open call fits this idea${IDEA.searched ? `, out of ${IDEA.searched}` : ""}.</b>
      Try describing the work rather than the field.</li>`;
  }
  return `<li class="empty"><b>Match to see the calls that fit.</b>
    About a minute against every open call.</li>`;
}

// The model names calls by id ("gg:363852"). Swap each id it mentions for
// the call's title: a link to its row when the row is on this page, to the
// call itself when not. The first sentence is the pick, the rest (usually
// the runner-up) reads smaller.
function recLinks(chunk, onPage) {
  let out = esc(chunk);
  const ids = IDEA.items.map(i => i.id).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const o = SEEN.get(id);
    if (!o || !out.includes(esc(id))) continue;
    const title = esc(decode(o.title));
    const a = onPage.has(id) ? `<a href="#c-${esc(id)}">${title}</a>`
      : o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener">${title}</a>`
      : `<b>${title}</b>`;
    out = out.split(esc(id)).join(a);
  }
  // "(<a>…</a>)" once the id was parenthesised after a name; drop the parens.
  return out.replace(/\(\s*(<(a|b)[ >][^<]*<\/\2>)\s*\)/g, "$1");
}

// The callout above the list. onPage is the ids the list is showing, or
// null to clear it while the list repaints.
function paintIdeaRec(onPage) {
  const box = document.getElementById("idea-rec");
  if (!IDEA.on || !onPage || (!IDEA.items.length && !_matchBusy)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const text = IDEA.recommendation;
  if (_matchBusy || _rankBusy || !text) {
    box.className = "bkout pending";
    box.innerHTML = `<span class="tag">Recommendation</span>
      <p class="placeholder">${_matchBusy || _rankBusy
        ? "Working on it… the call to go for lands here."
        : "No recommendation for these matches. Match again to get one."}</p>`;
    return;
  }
  const m = text.match(/^(.+?[.!?])(\s+[\s\S]+)?$/);
  const pick = m ? m[1] : text, rest = m && m[2] ? m[2].trim() : "";
  box.className = "bkout";
  box.innerHTML = `<span class="tag">Recommendation</span>
    <p class="pick">${recLinks(pick, onPage)}</p>
    ${rest ? `<p class="rest">${recLinks(rest, onPage)}</p>` : ""}`;
}

// Recommended calls missing from SEEN (filtered out, or a reload with the
// mode on) are fetched once so the callout can name them.
function fetchUnseen() {
  const missing = IDEA.items.map(i => i.id).filter(id => !SEEN.has(id));
  if (!missing.length) return Promise.resolve();
  return fetch("api/opportunities?" + new URLSearchParams({ ids: missing.join(","), page_size: 200 }))
    .then(r => r.ok ? r.json() : { opportunities: [] })
    .then(d => d.opportunities.forEach(o => SEEN.set(o.id, o)))
    .catch(() => {});
}

function setIdeaOn(on) {
  if (on === IDEA.on) return;
  if (on && !aiReady()) {
    document.getElementById("idea-on").checked = false;
    openChatPanel(document.getElementById("idea-on"));
    return;
  }
  IDEA.on = on;
  saveIdea();
  if (on) { _pageBefore = PAGE; PAGE = 1; } else { PAGE = _pageBefore; setIdeaHint(""); }
  paintIdeaMode();
  render();
  if (!on) return;
  const idea = ideaText();
  if (!idea) {
    setIdeaHint("Describe the idea, then Match.");
    ideaEl().focus();
  } else if (idea !== IDEA.matched || !IDEA.items.length) {
    runMatch();
  } else {
    paintMatchedHint();
  }
}

function paintMatchedHint() {
  if (!IDEA.items.length) return setIdeaHint("");
  setIdeaHint(ideaText() === IDEA.matched ? ""
    : "The idea has changed since these matches. Match again to search with it.");
}

async function runMatch() {
  if (_matchBusy) return;
  const idea = ideaText();
  IDEA.idea = idea;
  saveIdea();
  if (!idea) { setIdeaHint("Describe the idea first."); ideaEl().focus(); return; }
  if (!aiReady()) {
    setIdeaHint("");
    openChatPanel(document.getElementById("idea-match"));
    return;
  }
  if (!IDEA.on) { IDEA.on = true; _pageBefore = PAGE; PAGE = 1; saveIdea(); }
  const { key, model, base } = keyBar();
  _matchBusy = true;
  paintIdeaMode();
  render();
  // The /api/focus call is one long request (parallel catalogue chunks, then
  // a rank pass). Until we stream stages from the server, rotate honest
  // status copy and show elapsed time so the wait does not look stuck.
  const stages = [
    "Scanning open calls against your idea…",
    "Reading the catalogue in parallel…",
    "Gathering the strongest candidates…",
    "Ranking matches by fit to your idea…",
  ];
  const started = Date.now();
  let stage = 0;
  const paint = () => {
    const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
    setIdeaHint(`${sec}s · ${stages[stage]}`);
  };
  paint();
  const stageTimer = setInterval(() => { if (stage < stages.length - 1) stage++; }, 12000);
  const clock = setInterval(paint, 1000);
  const stop = () => { clearInterval(stageTimer); clearInterval(clock); };
  try {
    const r = await fetch("api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, api_key: key, model, base_url: base }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `focus failed (${r.status})`);
    stop();
    const results = data.results || [];
    // Replace, don't merge: the matches are for this idea as written.
    IDEA.items = results.map(row => ({ id: row.id, affinity: row.affinity, why: row.why }));
    IDEA.recommendation = "";
    IDEA.matched = idea;
    IDEA.searched = data.searched || 0;
    saveIdea();
    _matchBusy = false;
    paintIdeaMode();
    PAGE = 1;
    if (!results.length) {
      setIdeaHint("");
      return;
    }
    setIdeaHint(`Searched ${data.searched} open calls`
      + (data.trimmed ? ` (${data.trimmed} not searched)` : "")
      + ". Picking the one to go for…");
    await rankIdea();
  } catch (e) {
    setIdeaHint(String(e.message || e).slice(0, 160));
  } finally {
    stop();
    _matchBusy = false;
    paintIdeaMode();
    if (IDEA.on) render();
  }
}

// Re-score the matches against the idea as now written and pick one: seconds,
// where a fresh match is a minute. Runs after every match, and when the idea
// is edited and the field is left.
async function rankIdea() {
  if (_rankBusy || !IDEA.items.length) return;
  const idea = ideaText();
  if (!idea) return;
  if (!aiReady()) { openChatPanel(document.getElementById("idea-match")); return; }
  const { key, model, base } = keyBar();
  _rankBusy = true;
  if (IDEA.on) render();
  try {
    const r = await fetch("api/rescore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, ids: IDEA.items.map(i => i.id),
                             api_key: key, model, base_url: base }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `${r.status}`);
    const by = Object.fromEntries((d.items || []).map(i => [i.id, i]));
    for (const it of IDEA.items) {
      if (by[it.id]) { it.affinity = by[it.id].affinity; it.why = by[it.id].why; }
    }
    IDEA.items.sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0));
    IDEA.recommendation = d.recommendation || "";
    saveIdea();
    await fetchUnseen();
    paintMatchedHint();
  } catch (e) {
    setIdeaHint(String(e.message || e).slice(0, 140));
  } finally {
    _rankBusy = false;
    if (IDEA.on) render();
  }
}

document.getElementById("idea-on").addEventListener("change", e => setIdeaOn(e.target.checked));
document.getElementById("idea-match").addEventListener("click", runMatch);
ideaEl().addEventListener("input", e => {
  IDEA.idea = e.target.value;
  saveIdea();
  if (IDEA.on) paintMatchedHint();
});
// Cmd/Ctrl+Enter matches; a plain Enter is a new line in the idea.
ideaEl().addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMatch(); }
});
// Re-rank when the idea is edited and the field is left, not on every
// keystroke, which would thrash the model while someone is still typing.
let _rankedFor = "";
ideaEl().addEventListener("focusout", () => {
  const next = ideaText();
  if (!IDEA.on || !IDEA.items.length || !next || next === _rankedFor || next === IDEA.matched) return;
  _rankedFor = next;
  rankIdea();
});

// ---- From a file: Upload file, or drop one on the box --------------------
let _fileBusy = false;
async function takeIdeaFile(file) {
  if (!file || _fileBusy) return;
  _fileBusy = true;
  const btn = document.getElementById("idea-upload");
  btn.disabled = true;
  setIdeaHint(`Reading ${file.name}\u2026`);
  try {
    const { text, trimmed, detail } = await readIdeaFile(file);
    ideaEl().value = text;
    IDEA.idea = text;
    saveIdea();
    const from = `Read ${file.name}${detail ? ` (${detail})` : ""}.`;
    setIdeaHint(trimmed
      ? `${from} Trimmed to the first ${IDEA_MAX_CHARS.toLocaleString()} characters, which is all a match reads: `
        + "edit the box to keep the parts that matter, then Match."
      : `${from} Check or edit the text, then Match.`);
    ideaEl().focus();
    ideaEl().setSelectionRange(0, 0);
    ideaEl().scrollTop = 0;
  } catch (e) {
    setIdeaHint(e instanceof IdeaFileError ? e.message
      : `Could not read ${file.name}. Paste the text instead.`, true);
  } finally {
    _fileBusy = false;
    btn.disabled = false;
  }
}

document.getElementById("idea-upload").addEventListener("click", () =>
  document.getElementById("idea-file").click());
document.getElementById("idea-file").addEventListener("change", e => {
  takeIdeaFile(e.target.files[0]);
  e.target.value = "";          // the same file again is a fresh pick
});
// The drop target is the whole card. dragleave fires on every child crossed,
// so depth is counted rather than trusting the last event.
let _dragDepth = 0;
const box = document.getElementById("ideabox");
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
box.addEventListener("dragenter", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth++;
  box.classList.add("drop");
});
box.addEventListener("dragover", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
box.addEventListener("dragleave", e => {
  if (!hasFiles(e)) return;
  if (--_dragDepth <= 0) { _dragDepth = 0; box.classList.remove("drop"); }
});
box.addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth = 0;
  box.classList.remove("drop");
  // One idea, one file: past the first, a drop is ignored.
  takeIdeaFile(e.dataTransfer.files[0]);
});

function bootIdea() {
  loadIdea();
  ideaEl().value = IDEA.idea || "";
  document.querySelector("#ideabox [data-aibar]").innerHTML = aiBarHTML();
  paintIdeaMode();
  // render() comes from boot; this only fills in names the callout needs.
  if (IDEA.on) { paintMatchedHint(); fetchUnseen().then(() => { if (IDEA.on) render(); }); }
}
