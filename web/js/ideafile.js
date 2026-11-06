// Idea match from a file: a white paper, a one-page summary or a deck, read to text
// and attached beside the Idea box, which stays free for the person's notes.

// Read here, in the tab. The file itself is never uploaded: only its text goes
// to /api/focus and /api/rescore, as the `document` field.
// The two readers are large (pdf.js ~1 MB with its worker, mammoth ~600 KB),
// so each loads from cdnjs only when a file of its kind is picked. Versions
// are exact: a reader that changed under us could change what gets matched.
const PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/";
const MAMMOTH_SRC = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.9.0/mammoth.browser.min.js";
const MAMMOTH_SRI = "sha384-F9c4WGfCRfzaY1ngABA8Z7qHFDuWabKbcwCb2Tk3Qf4njoUVhOChtw0UrXJmSp1y";
// The server reads at most this much (server.MAX_IDEA_CHARS for the document
// and notes together, server.MAX_DOC_CHARS for the document), so more would be
// sent and silently dropped. Trimmed here instead, where the chip can say so.
const IDEA_TOTAL_CHARS = 15000;
const IDEA_DOC_MAX_CHARS = 13000;
const IDEA_FILE_MAX_MB = 10;

let _pdfjs = null, _mammoth = null;

function loadPdfjs() {
  // pdf.js runs its parser in a worker; from another origin it wraps the
  // worker in a same-origin blob itself, so no copy is needed here.
  _pdfjs = _pdfjs || import(PDFJS_BASE + "pdf.min.mjs").then(m => {
    m.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.mjs";
    return m;
  });
  _pdfjs.catch(() => { _pdfjs = null; });
  return _pdfjs;
}

function loadMammoth() {
  _mammoth = _mammoth || new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MAMMOTH_SRC;
    s.integrity = MAMMOTH_SRI;
    s.crossOrigin = "anonymous";
    s.onload = () => window.mammoth ? resolve(window.mammoth) : reject(new Error("no mammoth"));
    s.onerror = () => { s.remove(); reject(new Error("load failed")); };
    document.head.appendChild(s);
  });
  _mammoth.catch(() => { _mammoth = null; });
  return _mammoth;
}

class IdeaFileError extends Error {}
const offline = what => new IdeaFileError(
  `Could not load the ${what} reader, so the file was not read. Check the connection, or paste the text.`);

// Layout whitespace out, paragraphs kept: the model reads the words.
function tidyText(s) {
  return s.replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function pdfText(file) {
  let pdfjs;
  try { pdfjs = await loadPdfjs(); } catch (e) { throw offline("PDF"); }
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e) {
    if (e && e.name === "PasswordException") {
      throw new IdeaFileError("This PDF is password-protected. Remove the password, or paste the text.");
    }
    throw new IdeaFileError("This PDF could not be read; it may be damaged. Paste the text instead.");
  }
  const parts = [];
  let len = 0, read = 0;
  // Pages past the limit would be trimmed anyway, and a long report can have
  // hundreds of them, so reading stops once there is enough.
  for (let n = 1; n <= doc.numPages && len <= IDEA_DOC_MAX_CHARS; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map(i => (i.str || "") + (i.hasEOL ? "\n" : "")).join("");
    parts.push(text);
    len += text.trim().length;
    read = n;
  }
  const text = tidyText(parts.join("\n\n"));
  if (!text) {
    throw new IdeaFileError("This PDF has no text to read: it looks like a scan, which is "
      + "pictures of pages. Export it from the original document as a PDF with text, or paste the text.");
  }
  return { text, more: read < doc.numPages, pages: doc.numPages };
}

async function docxText(file) {
  let mammoth;
  try { mammoth = await loadMammoth(); } catch (e) { throw offline("Word"); }
  try {
    const out = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: tidyText(out.value || "") };
  } catch (e) {
    throw new IdeaFileError("This .docx could not be read; it may be damaged. Paste the text instead.");
  }
}

// ---- .pptx: a zip of XML, read without a library -------------------------
// A deck is only text in <a:t> runs, so unzipping a few entries with the
// browser's own DecompressionStream and reading them with DOMParser is all
// it needs: nothing more to load from a CDN, and nothing that can change
// under us.
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// name -> async () => text, from the zip's central directory.
function zipEntries(buf) {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("bad zip");
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true), comment = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(new Uint8Array(buf, at + 46, nameLen));
    out.set(name, async () => {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = new Uint8Array(buf, start, size);
      if (method === 0) return dec.decode(raw);
      if (method !== 8) throw new Error("unsupported compression");
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

const xml = s => new DOMParser().parseFromString(s, "application/xml");
// One line per paragraph, its runs joined.
const xmlParas = doc => [...doc.getElementsByTagNameNS(NS_A, "p")]
  .map(p => [...p.getElementsByTagNameNS(NS_A, "t")].map(t => t.textContent).join(""))
  .filter(t => t.trim()).join("\n");

// "ppt/slides/slide3.xml" from a target relative to the part that names it.
function partPath(from, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function relsOf(zip, part) {
  const i = part.lastIndexOf("/");
  const get = zip.get(`${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`);
  const map = new Map();
  if (!get) return map;
  for (const r of xml(await get()).getElementsByTagName("Relationship")) {
    map.set(r.getAttribute("Id"), { type: r.getAttribute("Type") || "",
                                    path: partPath(part, r.getAttribute("Target") || "") });
  }
  return map;
}

async function pptxText(file) {
  if (typeof DecompressionStream === "undefined") {
    throw new IdeaFileError("This browser cannot read .pptx files. Update it, export the deck as PDF, or paste the text.");
  }
  let zip;
  try { zip = zipEntries(await file.arrayBuffer()); } catch (e) {
    throw new IdeaFileError("This .pptx could not be read; it may be damaged. Export it as PDF, or paste the text.");
  }
  try {
    // Slides in the order the deck shows them (presentation.xml), which is
    // not the order of their file names once slides have been moved.
    const pres = "ppt/presentation.xml";
    const rels = await relsOf(zip, pres);
    let slides = [...xml(await zip.get(pres)()).getElementsByTagNameNS(NS_P, "sldId")]
      .map(el => rels.get(el.getAttributeNS(NS_R, "id")))
      .filter(r => r && zip.has(r.path)).map(r => r.path);
    if (!slides.length) {
      slides = [...zip.keys()].filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
    }
    const parts = [];
    let len = 0, read = 0;
    for (const path of slides) {
      if (len > IDEA_DOC_MAX_CHARS) break;
      const doc = xml(await zip.get(path)());
      // Hidden slides are not part of the talk.
      if (doc.documentElement.getAttribute("show") === "0") { read++; continue; }
      let text = xmlParas(doc);
      // Speaker notes often carry the argument the slide only lists.
      const notes = [...(await relsOf(zip, path)).values()].find(r => r.type.endsWith("/notesSlide"));
      if (notes && zip.has(notes.path)) {
        const nd = xml(await zip.get(notes.path)());
        // The notes page repeats the slide number and an image of the slide;
        // only its body placeholder is the notes.
        const body = [...nd.getElementsByTagNameNS(NS_P, "sp")].filter(sp =>
          [...sp.getElementsByTagNameNS(NS_P, "ph")].some(ph => ph.getAttribute("type") === "body"));
        const said = body.map(sp => xmlParas(sp)).filter(Boolean).join("\n");
        if (said) text += `${text ? "\n" : ""}Notes: ${said}`;
      }
      read++;
      if (text.trim()) { parts.push(text); len += text.length; }
    }
    return { text: tidyText(parts.join("\n\n")), more: read < slides.length,
             slides: slides.length };
  } catch (e) {
    throw new IdeaFileError("This .pptx could not be read; it may be damaged. Export it as PDF, or paste the text.");
  }
}

// File in; { text, trimmed, detail } out, or an IdeaFileError whose message
// is for the person.
async function readIdeaFile(file) {
  const ext = (file.name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  if (ext === "ppt") {
    throw new IdeaFileError("Old PowerPoint (.ppt) files cannot be read here. In PowerPoint, save it as "
      + ".pptx (File > Save As) and upload that, or paste the text.");
  }
  if (ext === "doc") {
    throw new IdeaFileError("Old Word (.doc) files cannot be read here. In Word, save it as .docx "
      + "(File > Save As) and upload that, or paste the text.");
  }
  if (!["txt", "md", "markdown", "pdf", "docx", "pptx"].includes(ext)) {
    throw new IdeaFileError(`${ext ? `.${ext} files` : "Files of this kind"} cannot be read here. `
      + "Upload a .txt, .md, .pdf, .docx or .pptx, or paste the text.");
  }
  if (file.size > IDEA_FILE_MAX_MB * 1024 * 1024) {
    throw new IdeaFileError(`This file is ${(file.size / 1048576).toFixed(1)} MB; the limit is `
      + `${IDEA_FILE_MAX_MB} MB. Upload a shorter version, such as the summary, or paste the text.`);
  }
  let got;
  if (ext === "pdf") got = await pdfText(file);
  else if (ext === "docx") got = await docxText(file);
  else if (ext === "pptx") got = await pptxText(file);
  else got = { text: tidyText(await file.text()) };
  if (!got.text) throw new IdeaFileError("This file has no text in it.");
  const trimmed = got.more || got.text.length > IDEA_DOC_MAX_CHARS;
  // Cut at the last sentence or line inside the limit, not mid-word.
  let text = got.text.slice(0, IDEA_DOC_MAX_CHARS);
  if (got.text.length > IDEA_DOC_MAX_CHARS) {
    const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf(". ") + 1);
    if (cut > IDEA_DOC_MAX_CHARS * 0.8) text = text.slice(0, cut);
    text = text.trim();
  }
  const detail = got.pages ? `${got.pages} ${got.pages === 1 ? "page" : "pages"}`
    : got.slides ? `${got.slides} ${got.slides === 1 ? "slide" : "slides"}` : "";
  return { text, trimmed, detail };
}
