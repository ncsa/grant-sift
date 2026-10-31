// Actions on a row: feedback votes, Draft intro, and the per-call chat.

function turnHTML(t) {
  const role = t.role === "user" ? "user" : "assistant";
  const body = role === "user" ? esc(t.content) : `<div class="md">${mdHTML(t.content || "")}</div>`;
  // Checked on the server against the stored synopsis. Shown, not stripped:
  // the quote may be from the full solicitation, which we do not hold.
  const unver = (t.unverified || []).length
    ? `<p class="unverified">Not found in the captured synopsis, so check against the solicitation before sending: ${
        t.unverified.map(q => `“${esc(q)}”`).join(", ")}</p>`
    : "";
  return `<div class="turn ${role}">${body}${unver}</div>`;
}
const PENDING_TURN = `<div class="turn assistant pending" role="status" aria-label="Waiting for the answer"><i></i><i></i><i></i></div>`;

let FB = {};                            // opportunity id -> {up, down, note}

async function loadFeedback() {
  try {
    const r = await fetch("api/feedback");
    if (!r.ok) return;
    FB = (await r.json()).summary || {};
  } catch (e) { return; }
  paintFeedback();
}

// Painted from the cached summary, so re-rendering on a keystroke costs
// nothing. One request per page load, not one per visible row.
function paintFeedback() {
  document.querySelectorAll("[data-fb]").forEach(node => {
    const f = FB[node.dataset.fb];
    node.textContent = f ? `${f.up} useful · ${f.down} not for us` : "";
    node.title = f && f.note ? `Latest comment: ${f.note}` : "";
  });
}

// Thumbs reveal the comment box; the vote is only sent on Send, so one click
// cannot post an empty judgement by accident. Scoped to the card so a call
// on both the homepage and Idea match does not cross-wire.
function onCardClick(e) {
  const vote = e.target.closest("[data-vote]");
  if (vote && API) {
    const id = vote.dataset.id;
    const root = cardRoot(vote);
    const box = root.querySelector(`[data-fbbox="${CSS.escape(id)}"]`);
    root.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)
      .forEach(b => b.setAttribute("aria-pressed", b === vote));
    box.classList.add("on");
    box.dataset.verdict = vote.dataset.vote;
    box.querySelector("input").focus();
    return;
  }

  const send = e.target.closest("[data-fbsend]");
  if (send && API) { sendFeedback(send.dataset.fbsend, cardRoot(send)); return; }

  // Draft intro is a canned question in the call's chat. The relationship it
  // may claim and the quoting rules ride in the server's context, not here.
  const intro = e.target.closest("[data-intro]");
  if (intro) {
    const id = intro.dataset.intro;
    const root = cardRoot(intro);
    if (!aiReady()) { openChatPanel(intro); return; }
    openChat(root, id, false);
    const form = root.querySelector(`[data-chatform="${CSS.escape(id)}"]`);
    form.querySelector("input").value =
      `Draft a short intro email to ${intro.dataset.name} about this call.`;
    form.requestSubmit();
    return;
  }

  const hide = e.target.closest("[data-chatclose]");
  if (hide) {
    const id = hide.dataset.chatclose;
    const root = cardRoot(hide);
    setChat(root, id, false);
    root.querySelector(`[data-chat="${CSS.escape(id)}"]`)?.focus();
    return;
  }

  const chat = e.target.closest("[data-chat]");
  if (chat) {
    const id = chat.dataset.chat;
    const root = cardRoot(chat);
    if (!aiReady()) { openChatPanel(chat); return; }
    openChat(root, id, true);
  }
}

// Show or hide a row's chat box, and keep its Ask button saying which.
function setChat(root, id, open) {
  const box = root.querySelector(`[data-chatbox="${CSS.escape(id)}"]`);
  const btn = root.querySelector(`[data-chat="${CSS.escape(id)}"]`);
  if (!box) return;
  box.classList.toggle("on", open);
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    btn.querySelector(".asklbl").textContent = open ? "Hide chat" : "Ask about this call";
  }
}

// Open (or with toggle, flip) a row's chat box.
function openChat(root, id, toggle) {
  const box = root.querySelector(`[data-chatbox="${CSS.escape(id)}"]`);
  const open = toggle ? !box.classList.contains("on") : true;
  setChat(root, id, open);
  if (!open) return;
  box.querySelector("[data-aibar]").innerHTML = aiBarHTML(false);
  box.querySelector("input").focus();
}
document.getElementById("list").addEventListener("click", onCardClick);
document.getElementById("shelf-body").addEventListener("click", onCardClick);

async function sendFeedback(id, root) {
  root = root || document;
  const box  = root.querySelector(`[data-fbbox="${CSS.escape(id)}"]`)
            || document.querySelector(`[data-fbbox="${CSS.escape(id)}"]`);
  const note = box.querySelector("input").value.trim();
  const aspect = box.querySelector("[data-fbaspect]").value;
  const verdict = box.dataset.verdict;
  const label = root.querySelector(`[data-fb="${CSS.escape(id)}"]`)
             || document.querySelector(`[data-fb="${CSS.escape(id)}"]`);
  if (!verdict) return;
  label.textContent = "sending...";
  try {
    // The nightly job can hold SQLite's writer briefly, so allow for a wait,
    // but never leave the button saying "sending..." forever.
    const r = await fetch("api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opportunity_id: id, verdict, aspect, note }),
      signal: AbortSignal.timeout(45000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { label.textContent = d.detail || `failed (${r.status})`; return; }
    const f = FB[id] || { up: 0, down: 0, note: "" };
    if (verdict === "up") f.up++; else f.down++;
    f.note = note;
    FB[id] = f;
    // Say what actually happens, on all three timescales. The old message
    // claimed a calibration example even when the rule discarded the click.
    label.textContent = "Thanks, recorded";
    label.title = verdict === "down"
      ? "Excluded from digests now; re-scored in tonight's run; "
        + "and it will inform how similar calls are scored."
      : "Re-scored in tonight's run, and kept as an anchor for future scoring.";
    box.classList.remove("on");
    box.querySelector("input").value = "";
  } catch (err) {
    label.textContent = err.name === "TimeoutError"
      ? "timed out; the nightly job may be writing. Try again shortly."
      : "could not reach the server";
  }
}

// The transcript is deliberately not persisted anywhere, so these three are
// the only way to keep one. Built from the in-memory turns, not from the DOM.
function transcript(id) {
  const row = [...document.querySelectorAll(".row")]
    .find(r => r.querySelector(`[data-chatlog="${CSS.escape(id)}"]`));
  const title = row ? row.querySelector(".title").textContent.trim() : id;
  const head = [`# ${title}`, "", `Opportunity: ${id}`,
                `Exported: ${new Date().toISOString()}`,
                "", "Not stored server side. Exported from the browser tab.", "", "---", ""];
  const body = (CHATS[id] || []).map(t =>
    `**${t.role === "user" ? "You" : "Model"}**\n\n${t.content}\n`);
  return head.concat(body).join("\n");
}

async function onChatTools(e) {
  const copy = e.target.closest("[data-copy]");
  const exp  = e.target.closest("[data-export]");
  const clr  = e.target.closest("[data-clear]");
  if (!copy && !exp && !clr) return;
  const id = (copy || exp || clr).dataset.copy
          || (exp || clr).dataset.export || clr.dataset.clear;
  const root = cardRoot(copy || exp || clr);
  const hint = root.querySelector(`[data-chathint="${CSS.escape(id)}"]`);

  if (clr) {
    delete CHATS[id];
    root.querySelector(`[data-chatlog="${CSS.escape(id)}"]`).innerHTML = "";
    hint.textContent = "cleared from this tab";
    return;
  }
  if (!(CHATS[id] || []).length) { hint.textContent = "nothing to save yet"; return; }

  if (copy) {
    try {
      await navigator.clipboard.writeText(transcript(id));
      hint.textContent = "copied to clipboard";
    } catch (err) {
      // Clipboard needs a secure context, so plain http on a LAN address fails.
      hint.textContent = "clipboard blocked here; use Export instead";
    }
    return;
  }

  const blob = new Blob([transcript(id)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `grant-sift-${id.replace(/[^A-Za-z0-9]+/g, "-")}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  hint.textContent = "exported";
}
document.getElementById("list").addEventListener("click", onChatTools);
document.getElementById("shelf-body").addEventListener("click", onChatTools);

async function onChatSubmit(e) {
  const form = e.target.closest("[data-chatform]");
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.chatform;
  const root = cardRoot(form);
  const input = form.querySelector("input");
  const q = input.value.trim();
  if (!q) return;

  const { key, model, base } = keyBar();
  const hint = root.querySelector(`[data-chathint="${CSS.escape(id)}"]`);
  if (!aiReady()) { openChatPanel(form); return; }

  const log = root.querySelector(`[data-chatlog="${CSS.escape(id)}"]`);
  CHATS[id] = CHATS[id] || [];
  CHATS[id].push({ role: "user", content: q });
  log.insertAdjacentHTML("beforeend", turnHTML({ role: "user", content: q }));
  input.value = "";
  hint.textContent = "";
  log.insertAdjacentHTML("beforeend", PENDING_TURN);
  const pending = log.lastElementChild;
  const askBtn = form.querySelector("button[type=submit]");
  askBtn.disabled = true;
  log.scrollTop = log.scrollHeight;

  try {
    const r = await fetch("api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opportunity_id: id, api_key: key, model, base_url: base,
        messages: CHATS[id],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { hint.textContent = d.detail || `failed (${r.status})`; return; }
    const turn = { role: "assistant", content: d.content, model: d.model || model,
                   unverified: d.unverified_quotes || [] };
    CHATS[id].push(turn);
    pending.remove();
    log.insertAdjacentHTML("beforeend", turnHTML(turn));
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    hint.textContent = "could not reach the server";
  } finally {
    pending.remove();
    askBtn.disabled = false;
  }
}
document.getElementById("list").addEventListener("submit", onChatSubmit);
document.getElementById("shelf-body").addEventListener("submit", onChatSubmit);
