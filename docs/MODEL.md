# Content Streamer (PoC) — Design Model

How this module applies the family doctrine **reuse → extend → enhance →
invent**:

- **Reuse**: which core `acks` documents, fields, and methods it builds on.
- **Extend**: genuinely new data, stored in `flags["acks-content"]` (typed by
  an in-memory DataModel where practical; blank numerics are `null`, never 0).
- **Enhance**: alternate sheets, libWrapper wraps, socketlib GM routing.
- **Invent**: kept to nothing the system already provides.

## Decisions

### The refresh bridge: bytes may cross a reload, and nothing longer (2026-07-29)

**Problem.** The possession model persists a book's *location*, never the book.
Three location kinds existed, and only two could reopen themselves: a
`FileSystemFileHandle` (one permission click) and a fetchable `url` (silent).
Both are out of reach for the seat that needs them most — the File System
Access API does not exist outside a secure context, so a player on plain
`http://` over the LAN, and every Firefox seat regardless of origin, fell to the
`file` kind: the remembered *name* of a PDF and nothing else. That seat re-picked
every book through the OS file dialog on every page load, and a Foundry client
reloads constantly.

**Rejected: caching the PDF per seat.** IndexedDB is the only store not gated on
a secure context, so a durable byte cache is the only thing that would have made
a remote seat reconnect with no gesture at all. It was rejected because it
quietly converts "you must keep the book" into "you must have had the book
once": the cache outlives the file, and the module's central claim stops being
true.

**Taken: a 60-second window, measured from when the page went away.** The bytes
of an *already open* book are held in IndexedDB and are readable only while a
`touched` stamp — refreshed every 20s by a live page, and once more on
`pagehide` — is inside the window. Every join sweeps first: inside the window,
books reopen silently; outside it, the bytes are deleted before anything else
runs. `Forget Books` and setting the window to `0` both empty it immediately.

The stamp is deliberately not written at connect time. Measured from the
connect, an hour of play would leave the window long expired at exactly the
reload it exists to cover, which is the whole failure it addresses.

What this does and does not concede: a reload is not a new session, so bridging
it enforces nothing less than before. A *session* still cannot begin without the
reader's own file. Nothing is uploaded, nothing enters world data, no other seat
can read it, and prose remains memory-only everywhere.

**Also:** where a gesture is still required, it is now one gesture for the whole
shelf. A plain file picker grants no persistent permission and so consumes no
user gesture (unlike `requestPermission` on a handle, which is why the per-book
rows exist at all), so a seat re-picking two or more books gets a single
multi-file control that matches files to books by remembered name → remembered
size → the book's title in the filename. Unmatched files are named, never
guessed at: a book filled from the wrong PDF is worse than a book left closed.

### Dialogs are singletons (2026-07-29)

`connectBook()` and the reconnect pass are each reachable from more than one
place — a macro, the Getting Started button, the join hook — and none of them
checked whether their dialog was already open. Every extra call stacked another
identical window, so a reader who clicked "Connect your book" twice got two book
pickers, two dropdowns listing the same six books, and two chances to read the
same PDF into the same slot. Both now register a key *synchronously*, before
their async content build, and a second call brings the open dialog forward
instead.
