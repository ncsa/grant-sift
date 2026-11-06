// The Scoring panel (#66): which model and rules produced the scores on the
// page. Opened from the footer, the fallback notice, a card's "Scored by"
// line, and #scoring in the URL. Everything comes from /api/scoring, which
// reads the database and makes no model call.

const scoringModal = () => document.getElementById("scoring-modal");

function openScoring(from) {
  closeMenus();
  showModal(scoringModal(), null, returnTarget(from) || document.getElementById("foot"));
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

const humanId = id => String(id).replace(/_/g, " ");

async function loadScoring() {
  const now = document.getElementById("sc-now");
  const bd = document.getElementById("sc-breakdown");
  let d;
  try {
    const r = await fetch("api/scoring");
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch (e) {
    now.innerHTML = `<dd class="help">Could not load the scoring details.</dd>`;
    bd.innerHTML = "";
    return;
  }
  const n = d.now || {};
  const rows = [
    ["Model", `<code>${esc(n.model)}</code>${n.gateway ? ` on ${esc(n.gateway)}` : ""}`],
    ["If it is down", (n.fallbacks || []).length
      ? (n.fallbacks || []).map(m => `<code>${esc(m)}</code>`).join(", then ")
      : "No backup: scoring waits until it is back"],
    ["Thinking", n.thinking ? "On" : "Off"],
    ["Scoring version", `v${esc(String(n.scoring_version))}`],
    ["Roster", `${(n.roster_size || 0).toLocaleString()} ${n.roster_size === 1 ? "entry" : "entries"}`],
    ["Last pass", n.last_pass ? esc(`${longDate(n.last_pass)}, ${new Date(n.last_pass).toISOString().slice(11, 16)} UTC`) : "Never"],
  ];
  now.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  const total = d.live_total || 0;
  const fb = (d.fallback_scored || {}).count || 0;
  const lines = (d.breakdown || []).map(b => {
    const ver = b.scoring_version == null ? "before versioning" : `v${b.scoring_version}`;
    const cur = b.model === n.model && b.scoring_version === n.scoring_version;
    const note = b.fallback
      ? `${b.fallback === b.count ? "" : `${b.fallback} `}backup while the primary was down`
      : cur ? "current" : "";
    return `<tr${b.fallback ? ' class="backup"' : ""}><td><code>${esc(b.model || "unknown")}</code></td>` +
      `<td>${esc(ver)}</td><td class="n">${b.count.toLocaleString()}</td><td>${esc(note)}</td></tr>`;
  }).join("");
  bd.innerHTML = total
    ? `<p>${total.toLocaleString()} open calls.` +
      (fb ? ` <b>${fb.toLocaleString()}</b> were scored by a backup model; ` +
            `<code>python run.py assess --rescore-fallback</code> redoes them on the primary.` : "") +
      `</p><table class="sctable"><thead><tr><th>Model</th><th>Rules</th>` +
      `<th class="n">Calls</th><th></th></tr></thead><tbody>${lines}</tbody></table>`
    : `<p class="help">No open calls have been scored yet.</p>`;

  document.querySelectorAll(".scoring .sc-label").forEach(el => { el.textContent = d.label || "score"; });
  document.getElementById("sc-guide").textContent = d.guide || "";
  document.getElementById("sc-guide").hidden = !d.guide;
  const axes = d.axes || [];
  document.getElementById("sc-axes").textContent = axes.length
    ? `${axes.length} independent axes (${axes.map(humanId).join(", ")})`
    : "no separate axes in this deployment";
}
