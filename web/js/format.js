// Formatting: dates, money, escaping, and the Markdown for model answers.

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const daysAway = d => d ? Math.ceil((new Date(d + "T00:00:00") - new Date().setHours(0,0,0,0)) / 864e5) : null;
const esc = s => (s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// Some feeds hand over titles already entity-encoded ("Systems &amp; Services"),
// which esc() would then double. Decode once, before escaping for display.
const _ent = document.createElement("textarea");
function decode(s) {
  if (!s || !/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) return s;
  _ent.innerHTML = s;
  return _ent.value;
}

// "Oct 23, 2026", from an ISO date or timestamp.
function longDate(iso) {
  if (!iso) return "";
  const dt = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  return isNaN(dt) ? iso : `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

// A deadline decades out is a placeholder some listings use for "open until
// further notice"; a countdown of 18,000 days reads as a bug, not a date.
const SENTINEL_DAYS = 3650;

// "$4,000,000 – $12,000,000 per award over 5 years" -> head "$4M – $12M",
// note "per award over 5 years". The headline figure is what gets scanned;
// whatever qualifies it stays readable underneath.
function money(cur, n) {
  const fix = (v, u) => `${cur}${+v.toFixed(v < 10 ? 1 : 0)}${u}`;
  if (n >= 1e9) return fix(n / 1e9, "B");
  if (n >= 1e6) return fix(n / 1e6, "M");
  if (n >= 1e3) return fix(n / 1e3, "K");
  return `${cur}${n}`;
}
function awardParts(s) {
  if (!s) return null;
  const re = /([$€£])\s?(\d[\d,]*(?:\.\d+)?)/g;
  const hits = [...s.matchAll(re)];
  if (!hits.length) return { head: s, note: "" };
  const fig = h => money(h[1], Number(h[2].replace(/,/g, "")));
  const first = hits[0];
  let head = fig(first), end = first.index + first[0].length;
  const second = hits[1];
  if (second && /^\s*(to|–|—|-)\s*$/i.test(s.slice(end, second.index))) {
    head += " – " + fig(second);
    end = second.index + second[0].length;
  }
  const pre = s.slice(0, first.index).trim();
  if (/^up to$/i.test(pre)) head = "Up to " + head;
  else if (pre) return { head, note: s };
  const note = s.slice(end).replace(/^[\s,;.]+/, "").trim();
  return { head, note };
}

// Illinois Experts areas are often long comma-joined concept lists. Keep the
// full string as the filter value; shorten only what the browser paints.
function shortArea(d, max = 42) {
  if (!d) return "";
  if (d.length <= max) return d;
  const first = d.split(",")[0].trim();
  if (first.length >= 10 && first.length <= max) return first;
  return d.slice(0, max - 1).replace(/\s+\S*$/, "").trimEnd() + "…";
}

function shortDate(iso) {
  if (!iso) return "";
  const dt = new Date(iso + "T00:00:00");
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`;
}

const usd = n => n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`;

// Enough Markdown for a model's answer: paragraphs, headings, lists, code,
// bold, italic and links. Escapes first and only ever adds tags, so nothing
// the model writes can become markup of its own.
function mdInline(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdHTML(text) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${mdInline(para.join("<br>"))}</p>`); para = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  const blocks = esc(text).split(/^```[^\n]*\n?/m);
  blocks.forEach((block, i) => {
    if (i % 2) {                       // inside a fence
      flushPara(); closeList();
      out.push(`<pre><code>${block.replace(/\n$/, "")}</code></pre>`);
      return;
    }
    for (const line of block.split("\n")) {
      const h = line.match(/^#{1,6}\s+(.*)/);
      const li = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)/);
      if (h) { flushPara(); closeList(); out.push(`<p class="h">${mdInline(h[1])}</p>`); }
      else if (li) {
        flushPara();
        const kind = li[1] ? "ul" : "ol";
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${mdInline(li[2])}</li>`);
      } else if (!line.trim()) { flushPara(); closeList(); }
      else { closeList(); para.push(line); }
    }
    flushPara(); closeList();
  });
  return out.join("");
}
