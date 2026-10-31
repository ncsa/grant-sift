// Who we know and Sources: browsable lists with add and retire.

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

// The roster and source lists are browsable, not just writable. A form you
// cannot read back is one people fill in twice: without seeing that Sarita
// Adve is already on the roster, the reasonable thing to do is add her again.
let ROSTER = [], SOURCES = [];
// Paged like the calls list. Both are filtered in the browser, so a page is
// just a slice of the matches.
const LIST_PAGE_SIZE = 25;
let R_PAGE = 1, S_PAGE = 1;
const clampPage = (page, total) =>
  Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / LIST_PAGE_SIZE)));
const pageOf = (items, page) =>
  items.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);

// A search should start from the first page of its results.
function resetRosterPage() { R_PAGE = 1; renderRoster(); }
function resetSourcePage() { S_PAGE = 1; renderSources(); }

for (const [nav, list, turn] of [
  ["r-pager", "rlist", p => { R_PAGE = p; renderRoster(); }],
  ["s-pager", "slist", p => { S_PAGE = p; renderSources(); }],
]) {
  document.getElementById(nav).addEventListener("click", e => {
    const b = e.target.closest("[data-page]");
    if (!b || b.disabled || b.getAttribute("aria-current")) return;
    turn(Number(b.dataset.page));
    document.getElementById(list).scrollIntoView({ block: "start" });
  });
}

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

  R_PAGE = clampPage(R_PAGE, hit.length);
  const page = pageOf(hit, R_PAGE);
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
      }).join("")
    : "<i>nothing matches that search</i>";
  paintPager("r-pager", R_PAGE, hit.length, LIST_PAGE_SIZE);
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

  const stale = SOURCES.filter(s => s.stale).length;
  document.getElementById("s-alarm").innerHTML = stale
    ? `<div class="alarm" role="note">${WARN_ICON}
         <span><b>Coverage may be incomplete.</b> ${stale} ${stale === 1 ? "source looks" : "sources look"}
         stale: never succeeded, no success in 30 days, or empty three runs running.
         Listed first.</span></div>`
    : "";

  S_PAGE = clampPage(S_PAGE, hit.length);
  document.getElementById("slist").innerHTML = hit.length
    ? pageOf(hit, S_PAGE).map(s => {
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
      }).join("")
    : "<i>nothing matches that search</i>";
  paintPager("s-pager", S_PAGE, hit.length, LIST_PAGE_SIZE);
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
    // Stale first: they are the reason to open this panel.
    SOURCES = (d.sources || []).sort((a, b) => b.stale - a.stale);
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
