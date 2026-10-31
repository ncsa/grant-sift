// One call as a row: fit, body, deadline and award, and its action bar.

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

// The next step after finding who to write to. One button, so the action row
// stays one line; what the draft will claim is its tooltip.
function introBtn(o) {
  if (!canIntro(o)) return "";
  const how = o.match_kind === "contact"
    ? "Written as a first contact: it never claims we have worked together."
    : "Cites the project we did together and quotes why this call needs us.";
  return `<button class="introbtn" data-intro="${esc(o.id)}" data-name="${esc(o.match_name)}"
      title="${esc(how)}">${ICON_MAIL}<span>Draft intro to ${esc(o.match_name)}</span></button>`;
}
const ROSTER_LINK = `<button type="button" class="linkbtn rosterlink" data-open-roster>Who we know →</button>`;
const trashBtn = id => `<button class="vote thumb trash" data-shrm="${esc(id)}"
    aria-label="Remove from shortlist" title="Remove from shortlist">${ICON_TRASH}</button>`;

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

// The server decides what an intro may claim (server._intro); this only hides
// the button where it would be refused: our own programs, and people who have
// left or asked not to be contacted.
function canIntro(o) {
  return (o.match_kind === "collaboration" || o.match_kind === "contact")
    && !["departed", "do-not-contact"].includes(o.match_status);
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

  // Fit leads the row, since it is what the list is ranked by; the deadline
  // and award sit together on the right.
  const lead = compact
    ? `<div class="when">${whenHTML(o)}</div>`
    : `<div class="lead">${scoreSignal(o.score)}</div>`;
  const side = compact ? "" : `
    <aside class="side">
      <div>
        <div class="eyebrow">Deadline</div>
        <div class="when">${whenHTML(o)}</div>
      </div>
      <div>
        <div class="eyebrow">Award</div>
        ${award
          ? `<div class="amt">${esc(award.head)}</div>${award.note ? `<div class="amtnote">${esc(award.note)}</div>` : ""}`
          : `<div class="noamt">Not stated</div>`}
      </div>
    </aside>`;

  return `<li class="row${soon ? " soon" : ""}" id="${opts.shelf ? "sh-" : "c-"}${esc(o.id)}">
    ${lead}
    <div class="body">
      <div class="meta">${meta.join("")}</div>
      <h2 class="title">${o.url
        ? `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(title)}</a>`
        : esc(title)}</h2>
      ${o.rationale ? `<p class="why"><span class="tag">Why it fits</span>${esc(o.rationale)}</p>` : ""}
      ${o.summary ? `<p class="sumry">${esc(o.summary)}</p>` : ""}
      ${fit}
      <div class="acts">
        ${introBtn(o)}
        <button class="askbtn" data-chat="${esc(o.id)}" aria-expanded="false">${ICON_CHAT}<span class="asklbl">Ask about this call</span></button>
        <span class="spacer"></span>
        <span class="votenote" data-fb="${esc(o.id)}"></span>
        <span class="votes">
          ${opts.shelf ? trashBtn(o.id) : ""}
          <button class="vote thumb" data-vote="up"   data-id="${esc(o.id)}" aria-pressed="false" aria-label="Useful" title="Useful: score calls like this higher">${ICON_UP}</button>
          <button class="vote thumb" data-vote="down" data-id="${esc(o.id)}" aria-pressed="false" aria-label="Not for us" title="Not for us: score calls like this lower">${ICON_DOWN}</button>
        </span>
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
      <div class="chat" data-chatbox="${esc(o.id)}">
        <div class="chathead">
          <div class="aibar" data-aibar="chat">${aiBarHTML(false)}</div>
          <span class="hint" data-chathint="${esc(o.id)}" aria-live="polite"></span>
          <span class="chattools">
            <button type="button" class="chatx" data-copy="${esc(o.id)}" aria-label="Copy chat" title="Copy chat">${ICON_COPY}</button>
            <button type="button" class="chatx" data-export="${esc(o.id)}" aria-label="Export chat as Markdown" title="Export as Markdown">${ICON_DOWNLOAD}</button>
            <button type="button" class="chatx" data-clear="${esc(o.id)}" aria-label="Clear chat" title="Clear chat">${ICON_RESET}</button>
            <button type="button" class="chatx" data-chatclose="${esc(o.id)}" aria-label="Hide chat" title="Hide chat">${ICON_X}</button>
          </span>
        </div>
        <div class="log" data-chatlog="${esc(o.id)}"></div>
        <form class="askfield" data-chatform="${esc(o.id)}">
          <input type="text" placeholder="Ask about this call, e.g. what would we need a domain PI for here?" data-chatinput="${esc(o.id)}" aria-label="Your question">
          <button class="sendbtn" type="submit" aria-label="Send" title="Send (Enter)">${ICON_SEND}</button>
        </form>
      </div>
    </div>
    ${side}
  </li>`;
}
