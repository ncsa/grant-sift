// Boot: load the catalogue and config, then paint.

function boot(cat) {
  document.getElementById("n-open").textContent  = cat.open;
  document.getElementById("n-soon").textContent  = cat.soon;
  document.getElementById("n-match").textContent = cat.matched;
  const upd = cat.updated_at && new Date(cat.updated_at);
  document.getElementById("asof").textContent =
    upd && !isNaN(upd) ? `Updated ${MONTHS[upd.getMonth()]} ${upd.getDate()}` : "";
  // Built from the data, not from a hardcoded list, so it always reflects the
  // roster as it actually matched. Areas commonest first, funders (agency) A-Z.
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

  // Stale sources matter to whoever looks after coverage, not to everyone
  // reading the list, so they get a flag on the Data menu rather than a banner.
  // The detail is in the Sources panel, stale ones first.
  const stale = (cat.stale_sources || []).length;
  document.getElementById("stale-n").hidden = !stale;
  document.getElementById("stale-n").textContent = `${stale} stale`;
  // Same for calls a backup model scored while the main one was down.
  const backup = cat.backup_scored || 0;
  const bn = document.getElementById("backup-n");
  bn.hidden = !backup;
  bn.textContent = `${backup} backup`;
  bn.title = `${backup} open call${backup === 1 ? " was" : "s were"} scored by a backup model`;
  document.getElementById("data-flag").hidden = !stale && !backup;
  const flags = [stale && `${stale} stale sources`, backup && `${backup} calls scored by a backup model`]
    .filter(Boolean);
  if (flags.length) {
    document.getElementById("databtn").setAttribute("aria-label", `Data: ${flags.join(", ")}`);
  }
  let scored = "unknown";
  if (cat.updated_at) {
    const t = new Date(cat.updated_at);
    scored = isNaN(t) ? cat.updated_at
      : `${longDate(cat.updated_at)}, ${t.toISOString().slice(11, 16)} UTC`;
  }
  document.getElementById("foot").innerHTML =
    `Scored ${esc(scored)}. Scores<span data-roster> and collaborator matches</span> are model-generated; treat them as a first pass, not a decision.` +
    ` <a href="https://github.com/ncsa/grant-sift/wiki/Grant-Sift-in-Claude:-setup" target="_blank" rel="noopener">Connect your AI assistant (MCP)</a>`;
  openScoringFromHash();
  bootIdea();
  render();
  probeAPI();
}

// The organisation's mark on a white plate, so any logo reads on the bar
// whatever its own colours: an image from web/, or a short word.
function paintLogo(l) {
  const box = document.getElementById("orglogo");
  if (!l || !(l.src || l.text)) { box.hidden = true; box.innerHTML = ""; return; }
  const name = l.alt || l.text;
  const mark = l.src
    ? `<img src="${esc(l.src)}" alt="${esc(l.alt)}">`
    : `<span class="word">${esc(l.text)}</span>`;
  const cls = l.plate === false ? "plate bare" : "plate";
  box.innerHTML = l.href
    ? `<a class="${cls}" href="${esc(l.href)}" title="${esc(name)} website">${mark}</a>`
    : `<span class="${cls}">${mark}</span>`;
  box.hidden = false;
}

// Wording and Call type chips from config/profile.yaml.
function paintProfile(p) {
  const g = p.group || {};
  if (g.tagline) document.getElementById("tagline").textContent = g.tagline;
  if (g.match_phrase) document.getElementById("match-phrase").textContent = g.match_phrase;
  paintLogo(p.logo);
  HOME_ORG = (p.org || {}).home || "";
  for (const [v, colour] of Object.entries(p.theme || {})) {
    document.documentElement.style.setProperty(v, colour);
  }
  const org = (p.org || {}).name;
  if (org) {
    document.querySelector('.chip[data-filter="via-me"]').title =
      `Calls where you are the ${org} contact to introduce`;
    document.getElementById("sub-email").placeholder = `Your ${org} address`;
  }
  if (p.score_label) {
    SCORE_LABEL = p.score_label;
    document.querySelectorAll(".score-lbl").forEach(el => {
      el.textContent = SCORE_LABEL;
      el.title = `${SCORE_LABEL}, 0 to 100. Not the Idea fit.`;
    });
    const opt = document.querySelector('#sort option[value="score"]');
    if (!opt.textContent.includes("idea")) opt.textContent = `Highest ${SCORE_LABEL}`;
  }
  const grp = document.getElementById("grp-type");
  (p.call_types || []).forEach(c => {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.filter = c.id;
    b.setAttribute("aria-pressed", ACTIVE.has(c.id));
    b.textContent = c.label;
    if (c.title) b.title = c.title;
    grp.appendChild(b);
  });
  grp.hidden = !(p.call_types || []).length;
}

// Config first: the rows are labelled with what the score measures, so the
// list waits for it. A failure only costs the labels, never the list.
const CONFIG = fetch("/api/config")
  .then(r => r.ok ? r.json() : null)
  .then(cfg => {
    if (cfg && cfg.profile) paintProfile(cfg.profile);
    if (cfg && cfg.ai) {
      const org = (cfg.profile && cfg.profile.org) || {};
      AI = { ...cfg.ai, org: org.name };
      addGatewayPreset();
      paintAI();
    }
    // Optional Grafana link: the Ops & signal item in the Data menu.
    const url = cfg && (cfg.grafana_url || cfg.grafana_embed_url);
    if (!url) return;
    const link = document.getElementById("grafana-link");
    // Prefer a normal dashboard URL (drop kiosk if present).
    link.href = url.replace(/([?&])kiosk(=[^&]*)?/, "$1").replace(/\?&/, "?").replace(/[?&]$/, "") || url;
    document.getElementById("grafana-grp").hidden = false;
  })
  .catch(() => {});

fetch("api/catalogue")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(cat => CONFIG.then(() => boot(cat)))
  .catch(() => {
    document.getElementById("list").innerHTML =
      `<div class="empty"><b>Could not reach the catalogue.</b>
       Start the server with <code>python run.py serve</code>; if it is running,
       run <code>python run.py daily</code> to fill it.</div>`;
  });

