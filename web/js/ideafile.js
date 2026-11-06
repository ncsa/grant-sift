// Idea match from a file: a white paper or a one-page summary, read to text
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

// File in; { text, trimmed, detail } out, or an IdeaFileError whose message
// is for the person.
async function readIdeaFile(file) {
  const ext = (file.name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  if (ext === "doc") {
    throw new IdeaFileError("Old Word (.doc) files cannot be read here. In Word, save it as .docx "
      + "(File > Save As) and upload that, or paste the text.");
  }
  if (!["txt", "md", "markdown", "pdf", "docx"].includes(ext)) {
    throw new IdeaFileError(`${ext ? `.${ext} files` : "Files of this kind"} cannot be read here. `
      + "Upload a .txt, .md, .pdf or .docx, or paste the text.");
  }
  if (file.size > IDEA_FILE_MAX_MB * 1024 * 1024) {
    throw new IdeaFileError(`This file is ${(file.size / 1048576).toFixed(1)} MB; the limit is `
      + `${IDEA_FILE_MAX_MB} MB. Upload a shorter version, such as the summary, or paste the text.`);
  }
  let got;
  if (ext === "pdf") got = await pdfText(file);
  else if (ext === "docx") got = await docxText(file);
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
  const detail = got.pages ? `${got.pages} ${got.pages === 1 ? "page" : "pages"}` : "";
  return { text, trimmed, detail };
}
