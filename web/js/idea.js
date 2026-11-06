// Idea match: a mode of the dashboard. An idea in, the calls that fit it in
// the main list, and the one to go for above it.

// Lives in this browser and nowhere else. The server stores no part of it -
// not the idea, not the matched calls, not the recommendation. The key is the
// one the old shortlist panel used, so a match made there survives the move.
const IDEA_KEY = "gs.shortlist";
// doc: the one attached file, read to text in this tab ({name, text, detail,
// trimmed}) or null; the box then holds the person's notes on it.
// items: [{id, affinity, why}], best first. matched: the idea (ideaSig) the items
// were found for, so an edited idea can say its results are older than it.
const IDEA_BLANK = () => ({ idea: "", doc: null, items: [], recommendation: "", matched: "", searched: 0, on: false });
let IDEA = IDEA_BLANK();
let _matchBusy = false;
let _rankBusy = false;
let _fileBusy = false;
const ideaBusy = () => _matchBusy || _rankBusy;
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
const docText = () => (IDEA.doc && IDEA.doc.text) || "";
const hasIdea = () => !!(ideaText() || docText());
// What a match was for: the notes, plus the file when there is one. Notes
// alone stay the bare text, so matches saved before files existed still
// count as current.
const ideaSig = () => docText() ? `${ideaText()}\u0001${docText()}` : ideaText();
// What the page sends; the server cuts to the same budget (_idea_parts).
const ideaPayload = () => ({ idea: ideaText(), document: docText() });

// The notes get what the file leaves of the budget: at least 2,000.
const notesRoom = () => IDEA_TOTAL_CHARS - docText().length;

function paintIdeaDoc() {
  const el = document.getElementById("idea-doc");
  const d = IDEA.doc;
  ideaEl().maxLength = notesRoom();
  ideaEl().placeholder = d
    ? "Add notes for the match: what to emphasise, what to leave out (optional)"
    : "Describe your idea, or drop a file here";
  if (!d) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const chars = `${d.text.length.toLocaleString()} characters`;
  el.innerHTML = `<svg class="ico ic" width="16" height="16" aria-hidden="true"><use href="icons.svg#file"/></svg>
    <span class="name" title="${esc(d.name)}">${esc(d.name)}</span>
    <span class="meta">${d.detail ? `${esc(d.detail)} · ` : ""}${d.trimmed
      ? `first ${chars} used` : chars}</span>
    <button type="button" id="idea-doc-x" aria-label="Remove ${esc(d.name)}"
      title="Remove the file. Your notes stay."${ideaBusy() ? " disabled" : ""}>
      <svg class="ico ic" width="14" height="14" aria-hidden="true"><use href="icons.svg#x"/></svg></button>`;
  el.classList.toggle("trimmed", !!d.trimmed);
  if (d.trimmed) el.title = "The file is longer than a match reads; only the start is used. "
    + "Upload a shorter version, such as the summary, to choose what counts.";
  else el.removeAttribute("title");
}

function removeIdeaDoc() {
  if (ideaBusy() || !IDEA.doc) return;
  IDEA.doc = null;
  saveIdea();
  paintIdeaDoc();
  if (IDEA.on) paintMatchedHint(); else setIdeaHint("");
  paintIdeaMode();
}

// Notes past what the file leaves are not read; say so rather than cut
// what the person typed.
function notesOverHint() {
  const over = ideaText().length - notesRoom();
  if (over <= 0) return false;
  setIdeaHint(`With the file attached, notes are read up to ${notesRoom().toLocaleString()} characters; `
    + `the last ${over.toLocaleString()} will not be matched. Shorten the notes, or remove the file.`, true);
  return true;
}

function setIdeaHint(text, err = false) {
  const el = document.getElementById("idea-hint");
  el.textContent = text || "";
  el.classList.toggle("err", !!err);
}

// The status bar under the idea while a match or a pick is running: what it
// is doing and for how long, so a minute-long wait does not look stuck.
let _statusClock = null;
function startIdeaStatus(text) {
  const el = document.getElementById("idea-status");
  const started = Date.now();
  const paint = () => {
    const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
    el.querySelector(".time").textContent = `${sec}s`;
  };
  clearInterval(_statusClock);
  el.querySelector(".msg").textContent = text;
  paint();
  el.hidden = false;
  _statusClock = setInterval(paint, 1000);
}
function setIdeaStatus(text) {
  document.querySelector("#idea-status .msg").textContent = text;
}
function stopIdeaStatus() {
  clearInterval(_statusClock);
  _statusClock = null;
  document.getElementById("idea-status").hidden = true;
}

function paintIdeaMode() {
  const on = IDEA.on;
  const busy = ideaBusy();
  // While it runs, the idea is what is being matched: no typing, no upload,
  // no drop, so the results cannot be for text that is no longer there.
  document.getElementById("ideabox").classList.toggle("busy", busy);
  ideaEl().readOnly = busy;
  document.getElementById("idea-upload").disabled = busy || _fileBusy;
  const x = document.getElementById("idea-doc-x");
  if (x) x.disabled = busy;
  const n = IDEA.items.length;
  document.getElementById("ideabox").classList.toggle("on", on);
  document.getElementById("idea-off").hidden = !on;
  // Anything to clear, and not mid-match: the way back to plain browsing.
  document.getElementById("idea-clear").hidden = busy || !(on || n || hasIdea());
  const note = document.getElementById("facet-note");
  note.hidden = !on || !n;
  note.textContent = `Narrowing the ${n} ${n === 1 ? "call" : "calls"} that fit your idea`;
  // Matches kept from earlier, while the list shows every call: one click
  // brings them back without another minute-long match.
  const show = document.getElementById("idea-show");
  show.hidden = on || !n || busy;
  show.querySelector(".lbl").textContent = `Show the ${n} ${n === 1 ? "call" : "calls"} that fit${
    IDEA.matched && IDEA.matched !== ideaSig() ? " the earlier idea" : ""}`;
  // The same sort, named for what it ranks by in each mode.
  document.querySelector('#sort option[value="score"]').textContent =
    on ? "Best fit to idea" : "Highest relevance";
  const btn = document.getElementById("idea-match");
  btn.disabled = busy;
  btn.textContent = _matchBusy ? "Matching…" : _rankBusy ? "Picking…"
    : IDEA.items.length ? "Match again" : "Match";
}

function ideaEmptyHTML() {
  if (_matchBusy) {
    return `<li class="empty"><b>Matching your idea against every open call…</b>
      About a minute. The matches land here, best fit first.</li>`;
  }
  if (!hasIdea()) {
    return `<li class="empty"><b>Describe your idea above.</b>
      Then Match: the open calls that fit it land here, best fit first.</li>`;
  }
  if (IDEA.matched && IDEA.matched === ideaSig()) {
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

// On: the list is the idea's matches. Showing kept matches needs no model;
// only Match does, and it checks for one itself.
function setIdeaOn(on) {
  if (on === IDEA.on) return;
  IDEA.on = on;
  saveIdea();
  if (on) { _pageBefore = PAGE; PAGE = 1; paintMatchedHint(); } else { PAGE = _pageBefore; setIdeaHint(""); }
  paintIdeaMode();
  render();
}

function paintMatchedHint() {
  if (!IDEA.items.length) return setIdeaHint("");
  if (notesOverHint()) return;
  setIdeaHint(ideaSig() === IDEA.matched ? ""
    : "The idea has changed since these matches. Match again to search with it.");
}

async function runMatch() {
  if (ideaBusy() || _fileBusy) return;
  IDEA.idea = ideaText();
  saveIdea();
  if (!hasIdea()) { setIdeaHint("Describe the idea, or attach a file, first."); ideaEl().focus(); return; }
  // Fixed at the start: what this match is for, even if the box changes.
  const sig = ideaSig(), sent = ideaPayload();
  if (!aiReady()) {
    setIdeaHint("");
    openChatPanel(document.getElementById("idea-match"));
    return;
  }
  if (!IDEA.on) { IDEA.on = true; _pageBefore = PAGE; PAGE = 1; saveIdea(); }
  const { key, model, base } = keyBar();
  // A new match starts clean: the earlier matches and their pick were for
  // the earlier idea, and must not sit under this one, least of all if this
  // match fails.
  IDEA.items = [];
  IDEA.recommendation = "";
  IDEA.matched = "";
  IDEA.searched = 0;
  saveIdea();
  setIdeaHint("");
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
  let stage = 0;
  startIdeaStatus(stages[0]);
  const stageTimer = setInterval(() => {
    if (stage < stages.length - 1) setIdeaStatus(stages[++stage]);
  }, 12000);
  const stop = () => clearInterval(stageTimer);
  try {
    const r = await fetch("api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sent, api_key: key, model, base_url: base }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `focus failed (${r.status})`);
    stop();
    const results = data.results || [];
    // Replace, don't merge: the matches are for this idea as written.
    IDEA.items = results.map(row => ({ id: row.id, affinity: row.affinity, why: row.why }));
    IDEA.recommendation = "";
    IDEA.matched = sig;
    IDEA.searched = data.searched || 0;
    saveIdea();
    _matchBusy = false;
    PAGE = 1;
    if (!results.length) {
      stopIdeaStatus();
      setIdeaHint("");
      return;
    }
    if (!notesOverHint()) setIdeaHint(`Searched ${data.searched} open calls`
      + (data.trimmed ? ` (${data.trimmed} not searched)` : "") + ".");
    await rankIdea({ searched: true });
  } catch (e) {
    setIdeaHint(String(e.message || e).slice(0, 240), true);
  } finally {
    stop();
    _matchBusy = false;
    if (!_rankBusy) stopIdeaStatus();
    paintIdeaMode();
    if (IDEA.on) render();
  }
}

// Re-score the matches against the idea as now written and pick one: seconds,
// where a fresh match is a minute. Runs after every match, and when the idea
// is edited and the field is left.
async function rankIdea({ searched = false } = {}) {
  if (_rankBusy || !IDEA.items.length) return;
  if (!hasIdea()) return;
  if (!aiReady()) { openChatPanel(document.getElementById("idea-match")); return; }
  const { key, model, base } = keyBar();
  _rankBusy = true;
  // After a match the clock keeps running from it; on its own it starts here.
  if (searched) setIdeaStatus("Picking the call to go for…");
  else startIdeaStatus("Re-ranking the matches against your edited idea…");
  paintIdeaMode();
  if (IDEA.on) render();
  try {
    const r = await fetch("api/rescore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ideaPayload(), ids: IDEA.items.map(i => i.id),
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
    if (!searched) paintMatchedHint();
  } catch (e) {
    setIdeaHint(String(e.message || e).slice(0, 240), true);
  } finally {
    _rankBusy = false;
    stopIdeaStatus();
    paintIdeaMode();
    if (IDEA.on) render();
  }
}

// Forget the idea entirely: text, matches, pick, and the mode. The list goes
// back to every open call, on the page it was on before the mode came on.
function clearIdea() {
  if (ideaBusy()) return;
  const wasOn = IDEA.on;
  IDEA = IDEA_BLANK();
  _rankedFor = "";
  saveIdea();
  ideaEl().value = "";
  ideaEl().blur();
  paintIdeaDoc();
  setIdeaHint("");
  if (wasOn) PAGE = _pageBefore;
  paintIdeaMode();
  render();
}

document.getElementById("idea-off").addEventListener("click", () => setIdeaOn(false));
document.getElementById("idea-clear").addEventListener("click", clearIdea);
document.getElementById("idea-doc").addEventListener("click", e => {
  if (e.target.closest("#idea-doc-x")) removeIdeaDoc();
});
document.getElementById("idea-show").addEventListener("click", () => setIdeaOn(true));
document.getElementById("idea-match").addEventListener("click", runMatch);
ideaEl().addEventListener("input", e => {
  IDEA.idea = e.target.value;
  saveIdea();
  if (IDEA.on) paintMatchedHint(); else if (!notesOverHint()) setIdeaHint("");
  paintIdeaMode();
});
// Cmd/Ctrl+Enter matches; a plain Enter is a new line in the idea.
ideaEl().addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMatch(); }
});
// Re-rank when the idea is edited and the field is left, not on every
// keystroke, which would thrash the model while someone is still typing.
let _rankedFor = "";
ideaEl().addEventListener("focusout", () => {
  const next = ideaSig();
  if (!IDEA.on || !IDEA.items.length || !next || next === _rankedFor || next === IDEA.matched) return;
  _rankedFor = next;
  rankIdea();
});

// ---- From a file: Upload file, or drop one on the box --------------------
async function takeIdeaFile(file) {
  if (!file || _fileBusy || ideaBusy()) return;
  _fileBusy = true;
  const btn = document.getElementById("idea-upload");
  btn.disabled = true;
  setIdeaHint(`Reading ${file.name}\u2026`);
  try {
    const { text, trimmed, detail } = await readIdeaFile(file);
    // One file: a second replaces the first. The notes are left alone.
    IDEA.doc = { name: file.name, text, detail, trimmed };
    IDEA.idea = ideaText();
    saveIdea();
    paintIdeaDoc();
    paintIdeaMode();
    if (!notesOverHint()) {
      setIdeaHint(trimmed
        ? `Attached ${file.name}. It is longer than a match reads, so only the first `
          + `${IDEA_DOC_MAX_CHARS.toLocaleString()} characters are used. Add notes if you like, then Match.`
        : `Attached ${file.name}. Add notes on what to emphasise if you like, then Match.`);
    }
    ideaEl().focus();
  } catch (e) {
    setIdeaHint(e instanceof IdeaFileError ? e.message
      : `Could not read ${file.name}. Paste the text instead.`, true);
  } finally {
    _fileBusy = false;
    btn.disabled = ideaBusy();
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
  if (!hasFiles(e) || ideaBusy()) return;
  e.preventDefault();
  _dragDepth++;
  box.classList.add("drop");
});
box.addEventListener("dragover", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (ideaBusy()) { e.dataTransfer.dropEffect = "none"; return; }
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
  // One idea, one file: past the first in a drop, the rest are ignored.
  takeIdeaFile(e.dataTransfer.files[0]);
});

function bootIdea() {
  loadIdea();
  ideaEl().value = IDEA.idea || "";
  paintIdeaDoc();
  document.querySelector("#ideabox [data-aibar]").innerHTML = aiBarHTML();
  paintIdeaMode();
  // render() comes from boot; this only fills in names the callout needs.
  if (IDEA.on) { paintMatchedHint(); fetchUnseen().then(() => { if (IDEA.on) render(); }); }
}
