# Idea match: roadmap

Where Idea match stands, and what to build next, in rough order of value.

## Where it stands (November 2026)

- **Input:** one file (txt, md, pdf, docx) read to text in the browser, plus
  notes in the box. 15,000 characters in total; the file takes at most 13,000,
  so the notes always keep 2,000. A one-page summary fits easily.
- **Prompt:** the document is fenced as material; the notes are labelled as
  the researcher's and win where the two disagree (`IDEA_INPUT_RULES`).
- **Search:** the whole live catalogue (~1,040 calls), cut into ~4 chunks of
  ~25k tokens that are searched in parallel on Lumen (gemma-4-31b-it, 46,790
  input tokens a request). One more call ranks the merged shortlist. About
  100k prompt tokens and a minute a match. Nothing is filtered out before the
  model reads it.
- **No re-score:** editing the idea takes a fresh Match. Re-ranking the old
  matches against new wording was removed: an edit can change what is being
  looked for, and the old shortlist would never show what it now fits.

Why the input has a budget at all: the idea is repeated in every catalogue
chunk, so a longer idea costs about 4 times as much as it does in one request.
The context window is not the limit; each chunk leaves ~18k tokens free.

## Next

### 1. Profile the document once, then search with the profile

The biggest step. Before the search, one call turns the document and notes
into a short profile of about 400 tokens: aims, methods, field, data and
software involved, team, budget scale, keywords a funder would use. The
search sends the profile into every chunk instead of the raw text; the final
ranking pass still reads the full document.

- **Why:** each chunk then costs about 400 idea tokens instead of up to 4,000,
  however long the file is. That frees the document limit to ~60k characters
  (12–15 pages, a whole proposal), bounded only by the one ranking call.
- **Shown to the person, and editable.** The profile is what the search reads,
  so the person should see it and be able to correct it: "you missed that this
  is mostly an HPC workflow".
- **Cost:** one extra call of a few seconds. It can be cached in the browser
  with the file, so Match again does not repeat it.
- **Risk:** a bad profile quietly narrows the search. Showing it is the
  mitigation; a "search with the full text" fallback is the other.

### 2. Stream progress from the server

`/api/focus` is one request of about a minute, and the page rotates guessed
status copy. Streaming (server-sent events) would show the real stage:
profiling, chunk 2 of 4 done, ranking. The same stream could show partial
matches as each chunk returns.

### 3. Say which part of the idea each match fits

The ranking already writes a `why`. Asking it to name the aim or section of the
document it matched ("fits Aim 2, the data pipeline") makes a long document's
matches readable, and shows when every match hangs on the same small part.

### 4. Remember a few ideas

Today the browser keeps one idea. Researchers carry several. Keep a short list
in the browser (still nothing on the server), each with its file, notes and
matches, and switch between them.

### 5. Watch an idea

Run a saved idea against new calls as they arrive and include fresh matches in
the digest. Needs the idea on the server, which today it deliberately never
is, so this needs an explicit opt-in and a clear statement of what is stored.

## Considered, not planned

- **Several files at once.** Matching needs one clear description of the idea.
  Several files tend to be a summary plus a CV, budget or references, which
  pull matches towards generic calls, and cutting text across several files is
  hard to explain. Merging into one PDF covers the real case. Matching from a
  person's CV is a different feature (match a person, not an idea) and would
  get its own design.
- **Sending the PDF itself.** Lumen's models take text and images, not PDF
  files. Text is what matching needs; figures rarely change which call fits.
  Rendering pages to images would cost far more for little gain.
- **Keyword or embedding prefilter.** The usual way to cut cost, and what
  commercial grant search tools do. It would drop calls before the model reads
  them, which this project deliberately avoids. Worth revisiting only if the
  catalogue outgrows the chunked search (cost grows with the catalogue: about
  4 chunks today, 8 at most with `FOCUS_MAX_CHUNKS`).
- **Putting the idea first in the prompt.** The catalogue chunk is the shared
  prefix that Lumen's prefix cache reuses (about 2.8x cheaper), so it stays
  first and the idea stays last.
- **A bigger-context model.** Removes the problem for anyone on their own key
  with such a model, but the shared key stays on Lumen, so the design has to
  work there.
