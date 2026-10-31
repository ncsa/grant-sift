// The AI model: shared NCSA default or the viewer's own key, and its panel.

// ---------------------------------------------------------------------------
// Writes and chat. The list above already needs `run.py serve`; these also
// need a signed-in identity when auth is on. Without one the controls disable
// themselves rather than failing on click, so the list stays usable.
// ---------------------------------------------------------------------------
let API = false;
const CHATS = {};                       // opportunity id -> [{role, content}]

// Ask and Idea match run on the server's shared NCSA model by default, so
// they need no setup. A key of the viewer's own switches both to a model of
// their choosing. That key lives in this variable and nowhere else: not in
// storage, not on the server.
let AI = { shared: false, model: "", gateway: "" };     // from /api/config
// What "Use this model" applied, not what the form says: editing a field must
// not change the model until the viewer applies it.
let OWN = null;                                          // { key, model, base }
const keyBar = () => OWN ? { ...OWN } : { key: "", model: AI.model, base: "" };
const aiReady = () => !!OWN || AI.shared;

const MCP_GUIDE = "https://github.com/ncsa/grant-sift/wiki/Grant-Sift-in-Claude:-setup";

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ""; }
}

// One quiet line wherever an AI feature sits (each call's chat, Idea match):
// the privacy promise as a hover, and the two power-user ways to run it.
function aiBarHTML(withLock = true) {
  const { model, base } = keyBar();
  const priv = `<span class="aipriv" tabindex="0" role="img" aria-label="${esc(privacyText())}"
      title="${esc(privacyText())}">${ICON_LOCK}</span>`;
  const own = !aiReady()
    ? `<button type="button" class="linkbtn" data-aimodel>Add your key</button>`
    : `<button type="button" class="linkbtn" data-aimodel title="Now: ${
        esc(model || "—")} on ${esc(OWN ? hostOf(base) : "NCSA Lumen")}">${
        OWN ? "Change your model" : "Use your own model"}</button>`;
  const mcp = `<a href="${MCP_GUIDE}" target="_blank" rel="noopener"
      title="Grant Sift's MCP server: a stronger model with your own files and history. Your text and roster data then go to that provider.">Use in Claude or ChatGPT ↗</a>`;
  return `<span class="aipower"><span class="aplbl">Advanced options</span>${own}<span aria-hidden="true">·</span>${mcp}</span>${withLock ? priv : ""}`;
}

function privacyText() {
  const signed = AUTH.enforced && AUTH.authenticated
    ? " Your sign-in is known to the proxy in front of this app, so it is private rather than anonymous."
    : "";
  const via = OWN ? `goes to ${hostOf(keyBar().base)} on your own key` : "goes to NCSA Lumen";
  return `Not stored. What you type here stays in this browser tab, ${via}`
    + ` through a proxy that keeps nothing.${signed}`
    + " A chat is gone when you reload: copy or export it to keep it.";
}

function saveChatSettings() {
  try {
    const model = document.getElementById("k-model").value.trim();
    const base = document.getElementById("k-base").value.trim();
    sessionStorage.setItem("gs.chat", JSON.stringify({ model, base }));
  } catch (e) {}
}

// sessionStorage, not localStorage: the key should not outlive the tab.
try {
  const saved = JSON.parse(sessionStorage.getItem("gs.chat") || "{}");
  if (saved.base) document.getElementById("k-base").value = saved.base;
  if (saved.model) document.getElementById("k-model").value = saved.model;
} catch (e) {}

["k-base", "k-model"].forEach(id =>
  document.getElementById(id).addEventListener("change", saveChatSettings));

// The provider list fills the base URL; "Other…" shows it for editing.
function syncPreset() {
  const base = document.getElementById("k-base");
  const preset = document.getElementById("k-preset");
  const known = [...preset.options].some(o => o.value && o.value === base.value.trim());
  preset.value = known ? base.value.trim() : "";
  base.hidden = known;
}
document.getElementById("k-preset").addEventListener("change", e => {
  const base = document.getElementById("k-base");
  if (e.target.value) base.value = e.target.value;
  base.hidden = !!e.target.value;
  if (!e.target.value) base.focus();
  document.getElementById("k-models").innerHTML = "";
  saveChatSettings();
  syncApply();
});
syncPreset();

// Every place that names the model repaints from here.
function paintAI() {
  const own = !!OWN;
  document.querySelectorAll("[data-chatstatus]").forEach(el => {
    el.classList.toggle("ready", aiReady());
    el.textContent = own ? "Your key" : AI.shared ? "NCSA" : "Not set up";
  });
  document.querySelectorAll("[data-aibar]").forEach(el => {
    el.innerHTML = aiBarHTML(el.dataset.aibar !== "chat");
  });
  document.getElementById("aibtn-lbl").textContent = aiReady() ? "AI chat" : "Set up AI chat";
  document.getElementById("aibtn-dot").hidden = aiReady();
  paintAIPanel();
}

// The panel alone. Opening it must not repaint the page: the link that opened
// it would be replaced, and focus could not go back to it on close.
function paintAIPanel() {
  const own = !!OWN;
  const shared = document.getElementById("k-shared");
  document.getElementById("k-shared-use").hidden = own || !AI.shared;
  document.getElementById("k-own-use").hidden = !own;
  shared.disabled = !AI.shared;
  document.getElementById("k-shared-note").textContent = AI.shared
    ? `${AI.model} on NCSA Lumen. Nothing to set up; your text stays at NCSA.`
    : "Not available on this server.";
  if (document.activeElement?.name !== "k-mode") {
    (own || !AI.shared ? document.getElementById("k-own") : shared).checked = true;
    document.getElementById("k-form").hidden = !(own || !AI.shared);
  }
  syncApply();
}

// The form against what is in use. The button says "In use" when they match
// and comes back the moment any field differs, so it is always clear whether
// there is something left to apply.
function formOwn() {
  return { key:   document.getElementById("k-key").value.trim(),
           model: document.getElementById("k-model").value.trim(),
           base:  document.getElementById("k-base").value.trim() };
}
function syncApply() {
  const f = formOwn();
  const applied = !!OWN && f.key === OWN.key && f.model === OWN.model && f.base === OWN.base;
  const btn = document.getElementById("k-apply");
  btn.disabled = applied;
  btn.classList.toggle("done", applied);
  btn.textContent = applied ? "\u2713 In use" : OWN ? "Switch to this model" : "Use this model";
  const note = document.getElementById("k-note");
  note.classList.toggle("ok", applied);
  note.textContent = applied
    ? `Ask and Idea match now use ${OWN.model} on ${hostOf(OWN.base)}, for this tab.`
    : OWN ? "Not applied yet. Still using " + OWN.model + "."
    : "Kept in this browser tab only; never stored on the server.";
}
["k-key", "k-model", "k-base"].forEach(id =>
  document.getElementById(id).addEventListener("input", syncApply));

document.querySelectorAll('input[name="k-mode"]').forEach(r => r.addEventListener("change", () => {
  const own = document.getElementById("k-own").checked;
  document.getElementById("k-form").hidden = !own;
  if (!own) {
    OWN = null;
    document.getElementById("k-key").value = "";
    paintAI();
  } else {
    document.getElementById("k-key").focus();
  }
}));

document.getElementById("k-form").addEventListener("submit", e => {
  e.preventDefault();
  const key = document.getElementById("k-key").value.trim();
  const model = document.getElementById("k-model").value.trim();
  const note = document.getElementById("k-note");
  if (!key) { note.textContent = "Paste your API key first."; document.getElementById("k-key").focus(); return; }
  if (!model) { note.textContent = "Name a model, or list the ones your key can use."; document.getElementById("k-model").focus(); return; }
  OWN = formOwn();
  saveChatSettings();
  paintAI();
});

// What the key can reach, as suggestions for the model field.
document.getElementById("k-load").addEventListener("click", async e => {
  const btn = e.currentTarget;
  const note = document.getElementById("k-note");
  const api_key = document.getElementById("k-key").value.trim();
  if (!api_key) { note.textContent = "Paste your API key first."; document.getElementById("k-key").focus(); return; }
  btn.disabled = true;
  note.textContent = "Listing models…";
  try {
    const r = await fetch("api/models", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key, base_url: document.getElementById("k-base").value.trim() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `failed (${r.status})`);
    const ids = (d.models || []).sort();
    document.getElementById("k-models").innerHTML =
      ids.map(m => `<option value="${esc(m)}"></option>`).join("");
    note.textContent = ids.length
      ? `${ids.length} models. Start typing in Model to pick one.` : "The provider listed no models.";
    document.getElementById("k-model").focus();
  } catch (err) {
    note.textContent = String(err.message || err).slice(0, 160);
  } finally {
    btn.disabled = false;
  }
});

function openChatPanel(from) {
  closeMenus();
  paintAIPanel();
  const first = document.getElementById("k-form").hidden
    ? document.querySelector('input[name="k-mode"]:checked') : document.getElementById("k-key");
  showModal(document.getElementById("chat-modal"), first,
            returnTarget(from) || document.getElementById("acctbtn"));
}
function closeChatPanel() { hideModal(document.getElementById("chat-modal")); }
document.getElementById("m-chat").addEventListener("click", e => openChatPanel(e.currentTarget));
document.getElementById("aibtn").addEventListener("click", e => openChatPanel(e.currentTarget));

document.getElementById("chat-close").addEventListener("click", closeChatPanel);
document.getElementById("chat-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeChatPanel();
});
