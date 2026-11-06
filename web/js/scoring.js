// The Scoring panel (#66): how the scores on the page were produced, in
// plain words. Opened from the Data menu, a card's "Scored by" line, and
// #scoring in the URL. Everything comes from /api/scoring, which reads the
// database and makes no model call.

const scoringModal = () => document.getElementById("scoring-modal");

function openScoring(from) {
  closeMenus();
  showModal(scoringModal(), null, returnTarget(from) || document.getElementById("databtn"));
  if (location.hash !== "#scoring") history.replaceState(null, "", "#scoring");
  loadScoring();
}

function closeScoring() {
  hideModal(scoringModal());
  if (location.hash === "#scoring") {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function openScoringFromHash() {
  if (location.hash === "#scoring" && scoringModal().hidden) openScoring(null);
}
window.addEventListener("hashchange", openScoringFromHash);
document.getElementById("scoring-close").addEventListener("click", closeScoring);
scoringModal().addEventListener("click", e => { if (e.target === e.currentTarget) closeScoring(); });

async function loadScoring() {
  const now = document.getElementById("sc-now");
  const bd = document.getElementById("sc-breakdown");
  let d;
  try {
    const r = await fetch("api/scoring");
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch (e) {
    now.textContent = "Could not load the scoring details.";
    bd.innerHTML = "";
    return;
  }
  const n = d.now || {};
  const backups = n.fallbacks || [];
  now.innerHTML = `Scores come from <b>${esc(n.model)}</b>, scoring rules ` +
    `v${esc(String(n.scoring_version))}` +
    (n.last_pass ? `, last updated ${esc(longDate(n.last_pass))}.` : ".") +
    (backups.length ? ` If it is unavailable, ${backups.map(m => `<b>${esc(m)}</b>`).join(" or ")}` +
      " scores instead, and those calls say so on their card." : "");

  document.querySelectorAll(".scoring .sc-label").forEach(el => {
    el.textContent = d.label || "relevance";
  });

  // Only worth showing when the open calls were not all scored the same way.
  const groups = d.breakdown || [];
  if (groups.length < 2) { bd.innerHTML = ""; return; }
  bd.innerHTML = `<div class="scbd"><p>The ${(d.live_total || 0).toLocaleString()} open calls were scored by:</p><ul>` +
    groups.map(b => {
      const how = b.fallback ? "backup, while the main model was down"
        : b.scoring_version == null ? "earlier rules"
        : b.scoring_version === n.scoring_version ? "current rules" : `rules v${b.scoring_version}`;
      return `<li${b.fallback ? ' class="backup"' : ""}><span>${esc(b.model || "unknown")} ` +
        `(${esc(how)})</span><b>${b.count.toLocaleString()}</b></li>`;
    }).join("") + `</ul></div>`;
}
