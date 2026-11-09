// Idea match: a mode of the dashboard. An idea in, the calls that fit it in
// the main list, and the one to go for right under the panel.

// Lives in this browser and nowhere else. The server stores no part of it -
// not the idea, not the matched calls, not the recommendation. The key is the
// one the old shortlist panel used, so a match made there survives the move.
const IDEA_KEY = "gs.shortlist";
// doc: the one attached file, read to text in this tab ({name, text, detail,
// trimmed}) or null; the box then holds the person's notes on it.
// items: [{id, affinity, why}], best first. matched: the idea (ideaSig) the items
// were found for, so an edited idea can say its results are older than it.
// pick / runner: {id, reason} and {id, if} from the rank pass, or null; a
// match saved before they existed has only the prose recommendation.
const IDEA_BLANK = () => ({ idea: "", doc: null, items: [], recommendation: "", pick: null, runner: null,
                            matched: "", searched: 0, on: false });
let IDEA = IDEA_BLANK();
let _matchBusy = false;
let _fileBusy = false;
const ideaBusy = () => _matchBusy;
// The dashboard page when the mode came on, so turning it off lands there.
let _pageBefore = 1;
// The match in flight: aborting it is Cancel.
let _abort = null;

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
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// The notes get what the file leaves of the budget: at least 2,000.
const notesRoom = () => IDEA_TOTAL_CHARS - docText().length;

// ---- The idea field: 3 lines, growing to 6, never collapsing -------------
// Height follows the text only; focus and blur never change it, so Match
// does not move out from under the pointer.
function sizeIdea() {
  const el = ideaEl();
  el.style.height = "";
  const cs = getComputedStyle(el);
  const max = parseFloat(cs.maxHeight) || Infinity;
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = `${Math.min(max, el.scrollHeight + border)}px`;
}

function paintIdeaDoc() {
  const el = document.getElementById("idea-doc");
  const d = IDEA.doc;
  ideaEl().maxLength = notesRoom();
  // A visible label, so what the box is for does not vanish with the
  // placeholder as soon as someone types.
  document.getElementById("idea-label").innerHTML = d
    ? `Notes for the match <span class="opt">(optional) — what to emphasise, what to leave out</span>`
    : "Describe your idea";
  ideaEl().placeholder = d
    ? "e.g. focus on the AI and data-pipeline work"
    : "Aims, methods, data and software involved. Or drop a file here.";
  if (!d) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  // name · N pages, and one orange suffix when only the start is read. The
  // limit is in its tooltip rather than a second sentence.
  el.innerHTML = `<svg class="ico ic" width="16" height="16" aria-hidden="true"><use href="icons.svg#file"/></svg>
    <span class="name" title="${esc(d.name)}">${esc(d.name)}</span>
    ${d.detail ? `<span class="meta">· ${esc(d.detail)}</span>` : ""}
    ${d.trimmed ? `<span class="cut" tabindex="0" title="A match reads the first ${
      IDEA_DOC_MAX_CHARS.toLocaleString()} characters of a file. Upload a shorter version, such as the summary, to choose what counts.">· start only</span>` : ""}
    <button type="button" id="idea-doc-x" aria-label="Remove ${esc(d.name)}"
      title="Remove the file. Your notes stay."${ideaBusy() ? " disabled" : ""}>
      <svg class="ico ic" width="14" height="14" aria-hidden="true"><use href="icons.svg#x"/></svg></button>`;
}

function removeIdeaDoc() {
  if (ideaBusy() || !IDEA.doc) return;
  IDEA.doc = null;
  saveIdea();
  _note = null;
  paintIdeaDoc();
  paintIdeaMode();
  ideaEl().focus();
}

// ---- The status line: every message the panel has, one at a time --------
// A note set by an event (a file attached, an error) shows until the next
// edit, match or toggle; otherwise the line says what the state is.
// {text, err, act: {label, run}}
let _note = null;
function setIdeaNote(text, err = false, act = null) {
  _note = text ? { text, err, act } : null;
  paintIdeaStatus();
}

let _statusClock = null, _started = 0;
function paintIdeaStatus() {
  const line = document.getElementById("idea-msg");
  const msg = line.querySelector(".msg"), time = line.querySelector(".time");
  const actEl = document.getElementById("idea-act");
  // icon: clock for the hint, check for a result, bulb while the matches are
  // put aside, warn for a problem; none while matching (the spinner is it).
  let text = "", err = false, act = null, html = false, icon = "clock";
  const n = IDEA.items.length;
  const over = ideaText().length - notesRoom();
  if (_matchBusy) {
    text = "Searching every open call, then ranking…";
    icon = "";
  } else if (_note) {
    ({ text, err, act } = _note);
    icon = err ? "warn" : "info";
  } else if (over > 0) {
    text = `With the file attached, notes are read up to ${notesRoom().toLocaleString()} characters; `
      + `shorten them by ${over.toLocaleString()}, or remove the file.`;
    err = true;
    icon = "warn";
  } else if (n && IDEA.on) {
    text = summaryHTML();
    html = true;
    icon = "check";
    if (IDEA.recHidden && (IDEA.pick || IDEA.recommendation)) {
      act = { label: "Show the one to go for", run: () => { IDEA.recHidden = false; saveIdea(); render(); paintIdeaStatus(); } };
    }
  } else if (n) {
    text = `Showing every call · your <b>${plural(n, "match", "matches")}</b> ${n === 1 ? "is" : "are"} kept`;
    html = true;
    icon = "bulb";
    act = { label: "Show them →", run: () => setIdeaOn(true) };
  } else if (IDEA.on && IDEA.matched && IDEA.matched === ideaSig()) {
    text = `No open call fits this idea${IDEA.searched ? `, out of ${IDEA.searched.toLocaleString()}` : ""}. `
      + "Try describing the work rather than the field.";
    icon = "info";
  } else {
    const open = parseInt((document.getElementById("n-open").textContent || "").replace(/,/g, ""), 10);
    text = `About a minute against ${open > 0 ? `all ${open.toLocaleString()}` : "every"} open call${open === 1 ? "" : "s"}`
      + ` · <b>Cmd/Ctrl + Enter</b> to match`;
    html = true;
  }
  if (html) msg.innerHTML = text; else msg.textContent = text;
  const ico = line.querySelector(".sico");
  ico.style.display = icon ? "" : "none";
  // Versioned: clock and check are newer than a sprite a browser may hold.
  if (icon) ico.querySelector("use").setAttribute("href", `icons.svg?v=2#${icon}`);
  line.classList.toggle("err", !!err);
  document.getElementById("ideabox").classList.toggle("matching", _matchBusy);
  actEl.hidden = !act;
  actEl.textContent = act ? act.label : "";
  actEl.onclick = act ? act.run : null;
  clearInterval(_statusClock);
  _statusClock = null;
  time.textContent = "";
  if (_matchBusy) {
    const tick = () => {
      const sec = Math.max(1, Math.round((Date.now() - _started) / 1000));
      time.textContent = `${sec} s · usually about a minute`;
    };
    tick();
    _statusClock = setInterval(tick, 1000);
  }
}

// "30 of 709 open calls fit · matched just now".
function summaryHTML() {
  const n = IDEA.items.length;
  const of = IDEA.searched ? ` of ${IDEA.searched.toLocaleString()}` : "";
  let out = `<b>${n.toLocaleString()}${of}</b> open ${n === 1 ? "call fits" : "calls fit"}`;
  if (IDEA.at) out += ` · matched ${esc(agoText(IDEA.at))}`;
  if (IDEA.note) out += ` <span class="sub">${esc(IDEA.note)}</span>`;
  return out;
}

function agoText(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `on ${longDate(new Date(t).toISOString())}`;
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
  // The one control for the idea filter: shown while it is on, and the
  // status line offers the way back while it is off.
  document.getElementById("idea-off").hidden = !on;
  // Anything to clear, and not mid-match: the way back to plain browsing.
  document.getElementById("idea-clear").hidden = busy || !(on || n || hasIdea());
  const note = document.getElementById("facet-note");
  note.hidden = !on || !n;
  note.textContent = `Narrowing the ${n} ${n === 1 ? "call" : "calls"} that fit your idea`;
  // The same sort, named for what it ranks by in each mode.
  document.querySelector('#sort option[value="score"]').textContent =
    on ? "Best idea fit" : `Highest ${SCORE_LABEL}`;
  // Match -> Cancel while it runs -> Match again only once the idea differs
  // from what was last searched.
  const btn = document.getElementById("idea-match");
  btn.classList.toggle("cancel", busy);
  // Nothing changed since the last match: nothing new to search for.
  const same = !!IDEA.matched && IDEA.matched === ideaSig();
  btn.disabled = !busy && (!hasIdea() || _fileBusy || same);
  btn.textContent = busy ? "Cancel" : IDEA.matched && !same ? "Match again" : "Match";
  btn.title = busy ? "Stop the match and keep what was there before it."
    : same ? "Nothing has changed since this match."
    : "Searches every open call and ranks what fits (about a minute). Cmd/Ctrl+Enter from the idea.";
  paintIdeaStatus();
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

// A call's title as a link: to its row when the row is on this page, to the
// call itself when not.
function callLink(id, onPage) {
  const o = SEEN.get(id);
  if (!o) return "";
  const title = esc(decode(o.title));
  return onPage.has(id) ? `<a href="#c-${esc(id)}">${title}</a>`
    : o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener">${title}</a>`
    : `<b>${title}</b>`;
}

// The model names calls by id ("gg:363852"). Swap each id it mentions for
// the call's title. Only for matches saved before the pick came in parts.
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function recLinks(chunk, onPage) {
  let out = esc(chunk);
  const ids = IDEA.items.map(i => i.id).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    if (!SEEN.has(id) || !out.includes(esc(id))) continue;
    // "Title (id)": the id becomes the title, so the written one goes.
    const said = new RegExp(`${reEsc(esc(decode(SEEN.get(id).title)))}\\s*\\(\\s*${reEsc(esc(id))}\\s*\\)`, "g");
    out = out.replace(said, esc(id));
    out = out.split(esc(id)).join(callLink(id, onPage));
  }
  // "(<a>…</a>)" once the id was parenthesised after a name; drop the parens.
  return out.replace(/\(\s*(<(a|b)[ >][^<]*<\/\2>)\s*\)/g, "$1");
}

// funder · deadline · award, for the pick.
function factsLine(o) {
  const funder = decode(o.funder || o.agency || "");
  const away = o.deadline ? daysAway(o.deadline) : null;
  const due = !o.deadline || away > SENTINEL_DAYS ? "Rolling deadline"
    : `Due ${longDate(o.deadline)}${away >= 0 && away <= 30 ? ` (${plural(away, "day", "days")})` : ""}`;
  const award = awardParts(o.award_ceiling);
  return [funder, due, award ? award.head : ""].filter(Boolean).map(esc).join(" · ");
}

// The card under the panel. onPage is the ids the list is showing, or null
// to clear it while the list repaints.
function paintIdeaRec(onPage) {
  const box = document.getElementById("idea-rec");
  if (!IDEA.on || !onPage || _matchBusy || !IDEA.items.length || IDEA.recHidden) {
    box.hidden = true;
    return;
  }
  const p = IDEA.pick && SEEN.get(IDEA.pick.id);
  if (!p && !IDEA.recommendation) { box.hidden = true; return; }
  box.hidden = false;
  if (!p) {
    // Older match: prose only. The first sentence is the pick.
    const m = IDEA.recommendation.match(/^(.+?[.!?])(\s+[\s\S]+)?$/);
    const pick = m ? m[1] : IDEA.recommendation, rest = m && m[2] ? m[2].trim() : "";
    box.innerHTML = `${recHead()}
      <p class="pick">${recLinks(pick, onPage)}</p>
      ${rest ? `<p class="rest">${recLinks(rest, onPage)}</p>` : ""}`;
    return;
  }
  const r = IDEA.runner && SEEN.get(IDEA.runner.id);
  box.innerHTML = `${recHead()}
    <p class="pick">${callLink(IDEA.pick.id, onPage)}${IDEA.pick.reason
      ? ` <span class="why">— ${esc(IDEA.pick.reason)}</span>` : ""}</p>
    <p class="facts">${factsLine(p)}</p>
    ${IDEA.recommendation
      // The model's own reasoning, whole: why this one beats the others, the
      // runner-up, and what would change the answer. It already names the
      // runner-up, so the one-line runner-up is only for a reply without it.
      ? `<p class="reason"><span class="lbl">Why:</span> ${recLinks(IDEA.recommendation, onPage)}</p>`
      : r ? `<p class="reason"><span class="lbl">Runner-up:</span> ${callLink(IDEA.runner.id, onPage)}${
        IDEA.runner.if ? ` — pick it if ${esc(IDEA.runner.if.replace(/^pick it if\s*/i, ""))}` : ""}</p>` : ""}`;
}

function recHead() {
  return `<div class="rechead"><span class="tag">The one to go for</span>
    <button type="button" class="linkbtn" id="idea-rec-hide"
      title="Hide the recommendation. The status line can bring it back.">Hide</button></div>`;
}

// Recommended calls missing from SEEN (filtered out, or a reload with the
// mode on) are fetched once so the card can name them.
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
  _note = null;
  if (on) { _pageBefore = PAGE; PAGE = 1; } else { PAGE = _pageBefore; }
  paintIdeaMode();
  render();
}

// The fields of a match, to put back when one is cancelled.
const MATCH_FIELDS = ["items", "recommendation", "pick", "runner", "matched", "searched", "note", "on", "at",
                      "recHidden"];

async function runMatch() {
  if (ideaBusy() || _fileBusy) return;
  IDEA.idea = ideaText();
  saveIdea();
  if (!hasIdea()) { setIdeaNote("Describe the idea, or attach a file, first."); ideaEl().focus(); return; }
  if (ideaText().length > notesRoom()) { ideaEl().focus(); return; }
  // Fixed at the start: what this match is for, even if the box changes.
  const sig = ideaSig(), sent = ideaPayload();
  if (!aiReady()) {
    setIdeaNote("");
    openChatPanel(document.getElementById("idea-match"));
    return;
  }
  const before = Object.fromEntries(MATCH_FIELDS.map(k => [k, IDEA[k]]));
  const pageBefore = PAGE;
  if (!IDEA.on) { IDEA.on = true; _pageBefore = PAGE; PAGE = 1; }
  const { key, model, base } = keyBar();
  // A new match starts clean: the earlier matches and their pick were for
  // the earlier idea, and must not sit under this one, least of all if this
  // match fails. Cancel puts them back.
  Object.assign(IDEA, { items: [], recommendation: "", pick: null, runner: null,
                        matched: "", searched: 0, note: "" });
  saveIdea();
  _note = null;
  _matchBusy = true;
  _started = Date.now();
  const ctl = new AbortController();
  _abort = ctl;
  paintIdeaMode();
  document.getElementById("idea-match").focus();
  render();
  const t0 = performance.now();
  let landed = false;
  try {
    const r = await fetch("api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sent, api_key: key, model, base_url: base }),
      signal: ctl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `The match failed (${r.status}).`);
    // Stage timings only (#73), never the idea or the matches.
    console.info("Idea match timing (ms)",
                 { ...(data.timing_ms || {}), page: Math.round(performance.now() - t0) });
    const results = data.results || [];
    // Replace, don't merge: the matches are for this idea as written.
    IDEA.items = results.map(row => ({ id: row.id, affinity: row.affinity, why: row.why }));
    // The rank pass writes the pick too, so there is no second pass (#73).
    IDEA.recommendation = data.recommendation || "";
    IDEA.pick = data.pick || null;
    IDEA.runner = data.runner_up || null;
    IDEA.matched = sig;
    IDEA.at = Date.now();
    IDEA.recHidden = false;
    IDEA.searched = data.searched || 0;
    IDEA.note = [data.trimmed ? `${data.trimmed} calls were not searched.` : "",
                 fallbackNote(data)].filter(Boolean).join(" ");
    saveIdea();
    PAGE = 1;
    if (results.length) await fetchUnseen();
    landed = true;
  } catch (e) {
    if (ctl.signal.aborted) {
      // Cancel: back to exactly what was there before Match.
      Object.assign(IDEA, before);
      saveIdea();
      PAGE = pageBefore;
      setIdeaNote(before.items.length ? "Match cancelled. The earlier results are back." : "Match cancelled.");
    } else {
      // Inputs are kept; the earlier matches are not, since they were for
      // the idea before this one.
      _note = { text: String(e.message || e).slice(0, 240), err: true,
                act: { label: "Retry", run: runMatch } };
    }
  } finally {
    if (_abort === ctl) _abort = null;
    _matchBusy = false;
    paintIdeaMode();
    render();
    // Results land on the summary, so a screen reader hears it and the
    // keyboard is where the result is.
    if (landed) document.getElementById("idea-msg").focus({ preventScroll: true });
  }
}

function cancelMatch() {
  if (_abort) _abort.abort();
}

// The shared model was down and a backup answered (#67).
function fallbackNote(d) {
  return d && d.fallback
    ? `Matched on ${d.model}: ${d.fallback} is down right now.` : "";
}

// Forget the idea entirely: text, matches, pick, and the mode. The list goes
// back to every open call, on the page it was on before the mode came on.
function clearIdea() {
  if (ideaBusy()) return;
  const wasOn = IDEA.on;
  IDEA = IDEA_BLANK();
  saveIdea();
  _note = null;
  ideaEl().value = "";
  sizeIdea();
  paintIdeaDoc();
  if (wasOn) PAGE = _pageBefore;
  paintIdeaMode();
  render();
  ideaEl().focus();
}

document.getElementById("idea-off").addEventListener("click", () => setIdeaOn(false));
document.getElementById("idea-rec").addEventListener("click", e => {
  if (!e.target.closest("#idea-rec-hide")) return;
  IDEA.recHidden = true;
  saveIdea();
  paintIdeaRec(null);
  paintIdeaStatus();
});
document.getElementById("idea-clear").addEventListener("click", clearIdea);
document.getElementById("idea-doc").addEventListener("click", e => {
  if (e.target.closest("#idea-doc-x")) removeIdeaDoc();
});
document.getElementById("idea-match").addEventListener("click", () =>
  ideaBusy() ? cancelMatch() : runMatch());
window.addEventListener("resize", sizeIdea);
ideaEl().addEventListener("input", e => {
  IDEA.idea = e.target.value;
  saveIdea();
  _note = null;
  sizeIdea();
  paintIdeaMode();
});
// Cmd/Ctrl+Enter matches; a plain Enter is a new line in the idea.
ideaEl().addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMatch(); }
});

// ---- From a file: Upload file, or drop one on the box --------------------
async function takeIdeaFile(file) {
  if (!file || _fileBusy || ideaBusy()) return;
  _fileBusy = true;
  paintIdeaMode();
  setIdeaNote(`Reading ${file.name}…`);
  try {
    const { text, trimmed, detail } = await readIdeaFile(file);
    // One file: a second replaces the first. The notes are left alone.
    IDEA.doc = { name: file.name, text, detail, trimmed };
    IDEA.idea = ideaText();
    saveIdea();
    paintIdeaDoc();
    _note = { text: "File attached. Add notes on what to emphasise if you like, then Match." };
    ideaEl().focus();
  } catch (e) {
    _note = { text: e instanceof IdeaFileError ? e.message
      : `Could not read ${file.name}. Paste the text instead.`, err: true };
  } finally {
    _fileBusy = false;
    paintIdeaMode();
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
  sizeIdea();
  paintIdeaDoc();
  document.querySelector("#ideabox [data-aibar]").innerHTML = aiBarHTML();
  paintIdeaMode();
  // render() comes from boot; this only fills in names the card and the
  // summary need.
  if (IDEA.items.length) fetchUnseen().then(() => { paintIdeaStatus(); if (IDEA.on) render(); });
}
