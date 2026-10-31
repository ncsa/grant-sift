// Who is signed in, what the API allows, and email digests.

function openDigests(from) {
  closeMenus();
  showModal(document.getElementById("digest-modal"), null,
            returnTarget(from) || document.getElementById("acctbtn"));
  loadSubscriptions();
}
function closeDigests() { hideModal(document.getElementById("digest-modal")); }
document.getElementById("m-digests").addEventListener("click", e => openDigests(e.currentTarget));
document.getElementById("manage-digests").addEventListener("click", e => openDigests(e.currentTarget));
document.getElementById("digest-close").addEventListener("click", closeDigests);
document.getElementById("digest-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeDigests();
});

let AUTH = { mode: "off", enforced: false, authenticated: false, username: null };

async function probeAPI() {
  try {
    const r = await fetch("api/health");
    API = r.ok;
  } catch (e) { API = false; }

  if (API) {
    try {
      AUTH = await (await fetch("api/whoami")).json();
    } catch (e) {}
    paintAccount();
    // "Me" only means something to a signed-in person.
    for (const f of PERSONAL) {
      const chip = document.querySelector(`.chip[data-filter="${f}"]`);
      if (!chip) continue;
      chip.hidden = !AUTH.authenticated;
      if (!AUTH.authenticated && ACTIVE.has(f)) {
        ACTIVE.delete(f);
        chip.setAttribute("aria-pressed", "false");
      }
    }
    document.getElementById("grp-mine").hidden = !AUTH.authenticated;
    // Writes will be refused without an identity once the gate is on, so do
    // not offer controls that are certain to fail.
    if (AUTH.enforced && !AUTH.authenticated) API = false;
    loadRoster();
    loadSubscriptions();
  }
  document.getElementById("whoami").hidden = !API;
  document.querySelectorAll("[data-vote],[data-chat],[data-intro],[data-fbsend]")
    .forEach(b => { b.disabled = !API; });
  if (!API) {
    document.querySelectorAll(".votenote").forEach(n => {
      n.textContent = "read only: start run.py serve for feedback and chat";
    });
  } else {
    loadFeedback();
  }
}

async function loadSubscriptions() {
  const hint = document.getElementById("sub-hint");
  const box = document.getElementById("sub-feeds");
  const emailEl = document.getElementById("sub-email");
  try {
    const r = await fetch("api/subscriptions");
    if (!r.ok) {
      hint.textContent = "Could not load subscriptions.";
      return;
    }
    const data = await r.json();
    emailEl.value = data.email || "";
    const on = new Set(data.feeds || []);
    box.innerHTML = (data.available || []).map(f =>
      `<label><input type="checkbox" data-feed="${esc(f.id)}"${on.has(f.id) ? " checked" : ""}>` +
      `<span>${esc(f.label)}</span></label>`).join("");
    hint.textContent = on.size
      ? `Subscribed to ${on.size} digest${on.size === 1 ? "" : "s"}.`
      : "Not subscribed yet.";
  } catch (e) {
    hint.textContent = "Could not load subscriptions.";
  }
}

document.getElementById("sub-save").addEventListener("click", async () => {
  const hint = document.getElementById("sub-hint");
  const feeds = [...document.querySelectorAll("#sub-feeds input[data-feed]:checked")]
    .map(el => el.dataset.feed);
  hint.textContent = "Saving…";
  try {
    const r = await fetch("api/subscriptions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feeds }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      hint.textContent = data.detail || `Save failed (${r.status})`;
      return;
    }
    hint.textContent = feeds.length
      ? `Saved. Digests go to ${data.email} after the nightly run.`
      : `Unsubscribed ${data.email}.`;
  } catch (e) {
    hint.textContent = "Save failed.";
  }
});

function paintAccount() {
  const name = AUTH.authenticated ? (AUTH.username || AUTH.display || "") : "";
  const btn = document.getElementById("acctbtn");
  btn.setAttribute("aria-label", name ? `Account: ${name}` : "Account");
  document.getElementById("acct-who").hidden = !name;
  document.getElementById("acct-name").textContent = AUTH.email || name;
  if (name) {
    const local = (AUTH.username || AUTH.email || name).split("@")[0];
    const initials = (local.match(/[a-z]/gi) || []).slice(0, 2).join("").toUpperCase();
    if (initials) document.getElementById("acct-av").textContent = initials;
  }
}
