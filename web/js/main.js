// Boot: load the catalogue and config, then paint.

function boot(cat) {
  document.getElementById("n-open").textContent  = cat.open;
  document.getElementById("n-soon").textContent  = cat.soon;
  document.getElementById("n-match").textContent = cat.matched;
  const upd = cat.updated_at && new Date(cat.updated_at);
  document.getElementById("asof").textContent =
    upd && !isNaN(upd) ? `Updated ${MONTHS[upd.getMonth()]} ${upd.getDate()}` : "";
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

  // Stale sources matter to whoever looks after coverage, not to everyone
  // reading the list, so they get a flag on the Data menu rather than a banner.
  // The detail is in the Sources panel, stale ones first.
  const stale = (cat.stale_sources || []).length;
  document.getElementById("stale-n").hidden = !stale;
  document.getElementById("stale-n").textContent = `${stale} stale`;
  document.getElementById("data-flag").hidden = !stale;
  if (stale) {
    document.getElementById("databtn").setAttribute("aria-label", `Data: ${stale} stale sources`);
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

fetch("api/catalogue")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(boot)
  .catch(() => {
    document.getElementById("list").innerHTML =
      `<div class="empty"><b>Could not reach the catalogue.</b>
       Start the server with <code>python run.py serve</code>; if it is running,
       run <code>python run.py daily</code> to fill it.</div>`;
  });

// Optional Grafana link: the Ops & signal item in the Data menu.
fetch("/api/config")
  .then(r => r.ok ? r.json() : null)
  .then(cfg => {
    if (cfg && cfg.ai) { AI = cfg.ai; paintAI(); }
    const url = cfg && (cfg.grafana_url || cfg.grafana_embed_url);
    if (!url) return;
    const link = document.getElementById("grafana-link");
    // Prefer a normal dashboard URL (drop kiosk if present).
    link.href = url.replace(/([?&])kiosk(=[^&]*)?/, "$1").replace(/\?&/, "?").replace(/[?&]$/, "") || url;
    document.getElementById("grafana-grp").hidden = false;
  })
  .catch(() => {});
