// Shared chrome: modals, top-bar menus, the news bar and in-context links.

// Modals hold focus while open and hand it back to whatever opened them,
// named explicitly rather than read from activeElement: Safari does not focus
// a clicked button. Each keeps its own, because AI model opens over Idea match.
function showModal(m, focusEl, returnTo) {
  m._returnTo = returnTo;
  m.hidden = false; m.classList.add("on");
  (focusEl || m.querySelector(".x")).focus();
}
function hideModal(m) {
  if (m.hidden) return;
  m.hidden = true; m.classList.remove("on");
  if (m._returnTo && m._returnTo.isConnected) m._returnTo.focus();
  m._returnTo = null;
}
// Later in the document paints on top, so the last open one is the top one.
const topModal = () => [...document.querySelectorAll(".modal-backdrop.on")].pop();
document.addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  const m = topModal()?.querySelector(".modal");
  if (!m) return;
  const f = [...m.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")]
    .filter(el => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function cardRoot(el) {
  return el.closest(".row") || document;
}

// ---- top-bar menus: Data and Account ----
const MENUS = [["databtn", "datamenu"], ["acctbtn", "acctmenu"]];
function closeMenus(except) {
  for (const [b, m] of MENUS) {
    if (b === except) continue;
    document.getElementById(m).hidden = true;
    document.getElementById(b).setAttribute("aria-expanded", "false");
  }
}
function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"]')].filter(el => el.offsetParent !== null);
}
for (const [b, m] of MENUS) {
  const btn = document.getElementById(b), menu = document.getElementById(m);
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = menu.hidden;
    closeMenus(b);
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) menuItems(menu)[0]?.focus();
  });
  btn.addEventListener("keydown", e => {
    if (e.key !== "ArrowDown" || !menu.hidden) return;
    e.preventDefault();
    btn.click();
  });
  menu.addEventListener("keydown", e => {
    const items = menuItems(menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === "Escape") { e.stopPropagation(); closeMenus(); btn.focus(); }
    else if (e.key === "Tab") closeMenus();
  });
  // Choosing an item closes its menu; the item's own handler does the rest.
  menu.addEventListener("click", e => { if (e.target.closest('[role="menuitem"]')) closeMenus(); });
}
document.addEventListener("click", e => {
  if (!e.target.closest(".menuwrap")) closeMenus();
});

// A panel opened from a menu item hands focus back to that menu's button,
// since the item itself is hidden by then.
function returnTarget(el) {
  if (!el || !el.closest) return null;
  const menu = el.closest(".menu");
  return menu ? document.querySelector(`[aria-controls="${menu.id}"]`) : el;
}

const NEWS_KEY = "gs.news.mcp";
try { document.getElementById("newsbar").hidden = localStorage.getItem(NEWS_KEY) === "dismissed"; }
catch (e) { document.getElementById("newsbar").hidden = false; }
document.getElementById("newsbar-close").addEventListener("click", () => {
  document.getElementById("newsbar").hidden = true;
  try { localStorage.setItem(NEWS_KEY, "dismissed"); } catch (e) {}
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeMenus();
    const close = { "shelf-modal": closeShelf, "roster-modal": closeRoster,
                    "sources-modal": closeSources, "chat-modal": closeChatPanel,
                    "digest-modal": closeDigests }[topModal()?.id];
    if (close) close();
  }
});

// In-context ways in: "Who we know →" on a match, "Manage sources" on the
// coverage notice, "use your own" next to a model name.
document.addEventListener("click", e => {
  const r = e.target.closest("[data-open-roster]");
  if (r) return openRoster(r);
  const s = e.target.closest("[data-open-sources]");
  if (s) return openSources(s);
  const p = e.target.closest("[data-aimodel]");
  if (p) return openChatPanel(p);
});
