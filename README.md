# Log Viewer

A client-side web app for exploring IIS W3C, Apache/Nginx, JSON-lines and plain-text log files.
Everything runs in your browser: files are parsed in a Web Worker and **no data leaves the machine**
(there is no backend and no network call besides loading the app itself).

## Running

Requires Node 20+ (developed on Node 24).

```sh
npm install
npm run dev          # dev server at http://localhost:5173
npm run build        # type-check + production build into dist/
npm run preview      # serve the production build
npm test             # unit + UI integration tests (Vitest)
npm run typecheck    # TypeScript, strict mode
npm run test:perf    # 500k-line parse benchmark (logs timings)
npm run gen:iis -- 500000 big.log   # write a synthetic IIS log to try in the UI
```

Open the app, then drop a `.log`/`.txt` file anywhere on the page, use **Choose file…**, paste log text
(**Paste text…**, or just press Ctrl+V anywhere outside a text field), or click **Load sample data** (loads
`fixtures/sample-iis.log`, bundled into the app).

## Supported formats

The format is auto-detected from the first 50 non-blank lines; the **Format** dropdown in the file bar
re-parses the file with a forced format.

| Format | Detection | Notes |
| --- | --- | --- |
| **IIS W3C Extended** | any `#Software:` / `#Fields:` line | Columns come from `#Fields:`; a new `#Fields:` mid-file switches the schema from that line on. `#` lines go to the File Info metadata list. `-` → null. `date`+`time` → one UTC `timestamp`. Numeric fields (`s-port`, `sc-status`, `sc-substatus`, `sc-win32-status`, `sc-bytes`, `cs-bytes`, `time-taken`) become numbers. |
| **Apache/Nginx combined** (and common) | ≥ 60% of lines match | Mapped to IIS-style column names (`c-ip`, `cs-method`, `cs-uri-stem`, `sc-status`, `sc-bytes`, …) so the same filters and insights apply. |
| **JSON lines** | ≥ 60% of lines are JSON objects | Columns are the union of keys; nested values are shown as JSON. `timestamp`/`@timestamp`/`time`/`ts`/`date` becomes the timestamp; `level`/`severity`, `message`/`msg`, `logger`/`source`, `status`, `path`/`url`, `durationMs` get semantic roles. |
| **Generic text** | fallback | Regex extracts a leading ISO-like timestamp, a level (TRACE/DEBUG/INFO/WARN/ERROR/FATAL and common aliases like `WRN`, `Information`), an optional `[logger]`, and the message. Lines without a timestamp (stack traces) are appended to the previous entry. |

### Time zones

The log's time zone is detected while parsing and shown in the file bar:

| Format | Zone |
| --- | --- |
| IIS | Always UTC (W3C extended logs are written in UTC). |
| Apache/Nginx | The offset in the timestamps (`[10/Oct/2000:13:55:36 -0700]` → UTC-07:00). |
| JSON lines / generic text | A trailing `Z` or `±hh:mm` on the timestamps. Timestamps without a zone (and epoch numbers in JSON) are read as UTC and shown as "Not stated (assumed UTC)". |

If timestamps use more than one offset the zone is "Mixed" and log time is shown in UTC. When the browser's local
time differs from the log's zone, a **Log time / Local** switch appears next to it. It changes every displayed
timestamp: table, row details, time-range inputs and chips, histogram axis/tooltip and bucket boundaries, slowest
requests, and exported CSV/JSON. Filtering is unaffected (it works on absolute instants). The choice is remembered.

### IIS / Azure App Service extras

- `s-sitename` with the `~1` prefix (Azure SCM/Kudu site) is stripped, and a derived boolean **`isScm`** is added.
- `X-ARR-LOG-ID=<guid>` in `cs-uri-query` is extracted into the derived, searchable **`arrLogId`** column.
- Derived **`isHealthCheck`**: user-agent is `AlwaysOn` or client IP is `127.0.0.1`.
- Lines whose field count doesn't match the current `#Fields:` are kept as **malformed** rows (with the raw line and the
  reason) in the **Malformed** tab. Nothing is dropped silently; blank lines are the only lines ignored.
- Every row keeps its original raw line (row detail → **Copy raw line**).

## Features

- **File input**: drag-and-drop or picker (`.log`/`.txt` only), or pasted text, progress bar while parsing, file name / size /
  rows parsed / lines skipped / detected format / parse time, metadata (`#`) lines, clear errors for wrong type,
  empty, binary or unparseable files.
- **Table**: virtualized (tested to stay smooth at 500k rows), sticky header, click-to-sort (asc → desc → off),
  resizable columns (drag a header edge, double-click resets), column chooser with show/hide and drag-to-reorder
  (↑/↓ buttons for keyboard users), status colours (2xx green, 3xx blue, 4xx amber, 5xx red), level colours,
  slow-row highlight (threshold editable, default 1000 ms), compact/comfortable density, search-match highlighting.
  Click a row (or arrow keys + Enter) to open the detail panel with all fields, **Copy as JSON** and **Copy raw line**.
- **Insights** (collapsible, always reflects the filtered rows): total, error rate, avg/p95/max duration, bytes sent;
  requests-over-time histogram with automatic bucket size, errors stacked in red, hover tooltip, and
  click/drag to set the time filter; status (or level) distribution, top 10 URIs, top 10 client IPs (click any
  bar to filter), 10 slowest requests (click to jump to the row).
- **Export** the filtered rows in the current sort order to CSV (visible columns) or JSON (all fields + line number).
- **Theme**: follows the system by default; toggle cycles system → light → dark (remembered per browser).
- **Shortcuts**: `/` focuses search, `Esc` closes the detail panel / clears the selection (and blurs search),
  arrow keys / PageUp / PageDown / Home / End move through rows, Enter or Space opens a row.
- **Responsive & accessible**: sidebar and detail panel become overlays below 900 px; labelled controls, visible
  focus states, ARIA grid with `aria-activedescendant`, tablist for Rows/Malformed, live row count.

## Filters

All filters are generated from the detected schema and the data (not hard-coded to IIS) and combine with AND.

| Filter | Details |
| --- | --- |
| Global search | Case-insensitive, over the raw line; `.*` toggles regex mode. Invalid regexes show an inline error and are ignored (never crash). Matches are highlighted in the table. |
| Time range (UTC) | From/To bounded by the file's min/max timestamp; presets: first 5 min, last 5 min, last 1 h, all. Also set by dragging on the histogram. |
| Facets | Any column with fewer than 200 distinct values (e.g. `cs-method`, `sc-status`, `s-port`, `c-ip`, `s-sitename`, `cs-host`, `cs-username`, `level`, `logger`). Multi-select (OR within a column), live counts, in-list search when > 8 values. Entirely empty columns are skipped. |
| Status classes | 2xx / 3xx / 4xx / 5xx chips with counts. |
| Numeric ranges | Dual sliders + number inputs for duration/bytes columns (`time-taken`, `sc-bytes`, `cs-bytes`) and any other high-cardinality numeric column. Bounds come from the data. |
| URI | `contains` / `starts with` / `equals` (case-insensitive) on `cs-uri-stem` (or the format's equivalent), plus a top-10 frequent paths list. |
| Quick toggles | Hide health checks, Hide SCM/Kudu, Only errors (status ≥ 400, or ERROR/FATAL level for text/JSON logs), Only slow (duration > threshold). Shown only when the columns exist. |

Active filters appear as removable chips with **Clear all** and an "X of Y rows" count. The full filter state is
serialized into the URL hash (`#f=…`), so a view can be shared or bookmarked; opening such a URL applies the
filters to the next file you load.

## Architecture

```
src/
  parser/      pure TS, no DOM — one incremental LineParser per format + detectFormat
  worker/      parse.worker.ts (message protocol) + streamParse.ts (Blob slicing, UTF-8 stream decode, batching)
  store/       Zustand store (data, view state, filters), prefs (localStorage), useView (shared derived data)
  filters/     logIndex (columnar index), applyFilters (pure), facets, urlState, useUrlSync
  components/  DropZone, FileInfo, FilterSidebar, FilterChips, SearchBox, InsightsPanel, Histogram,
               LogTable, RowDetailPanel, ColumnChooser, MalformedList, TableToolbar, ExportMenu, ThemeToggle
  utils/       stats (percentiles, histogram bucketing), insights, export (CSV/JSON), sort, format
scripts/gen-iis.ts   synthetic IIS log generator (CLI + used by the benchmark)
tests/               parser, worker, filters, utils, ui (jsdom), perf
```

**Parsing pipeline.** The worker reads the `File` in 4 MB `Blob.slice`s, decodes with a streaming `TextDecoder`
(so multi-byte characters split across chunks are safe), carries the partial last line to the next chunk, and
feeds lines to the format's `LineParser`. Every 20k rows it posts a batch (rows + malformed + metadata + current
schema) and a progress message, so the main thread never blocks on parsing. The same `streamParse` function is
unit-tested in Node with different chunk sizes.

**Rows** keep a typed `values` record, a UTC `ts`, the 1-based `lineNo` and the `raw` line. Each column has a
semantic **role** (`status`, `duration`, `uri`, `clientIp`, `level`, `healthCheck`, …) — filters, insights and
cell rendering key off roles, which is how every format gets the same features where it has equivalent data.

**Filtering.** When parsing finishes, `buildLogIndex` builds a columnar index once: `Float64Array`s for
timestamps/status/duration/numeric columns, dictionary-encoded `Uint16Array` codes for facet columns, and a
`Uint8Array` of flags (health check / SCM / error level). `evaluateFilters` makes one pass per active filter and
produces a per-row `Uint32Array` **failure bitmask**: generic predicates share one bit; status classes, the URI
filter and each facet column get their own bit. Visible rows are `mask === 0`; facet counts "ignoring this
facet" are rows with `(mask & ~bit) === 0`, so every facet list's counts come from the same single evaluation.
Nothing is re-parsed on filter changes. Derived data is memoized at module level (by input identity) so the
table, sidebar and insights share one computation.

**Measured** (`npm run test:perf`, 500,000 synthetic IIS lines / 85 MB, Node 24 on a dev laptop):
parse ≈ 1.0–1.3 s (target < 5 s), build index ≈ 0.5 s, combined filter ≈ 60 ms, regex search ≈ 30–50 ms,
insights ≈ 0.3 s, sort ≈ 0.1 s (number) / 0.3 s (string), ≈ 450 MB heap after parsing. Numbers vary by machine; the test fails only above 10 s.

## Design decisions

- **Log time by default.** Timestamps are displayed and entered (time-range inputs) in the log's own zone (UTC for
  IIS), so they match the file. Local time is opt-in through the switch, which is shown only when the zones actually
  differ: it compares offsets at the first and last timestamp, so a DST change inside the file counts. In local mode
  every value uses the offset in effect at its own instant (DST-correct).
- **Zone-less timestamps are UTC** (generic text and JSON lines). JSON strings like `2026-10-27T04:42:02` used
  to be read as browser-local time by `Date.parse`; they are now read as UTC like the generic parser.
- **Exports carry an explicit offset** in the current display zone (`2026-10-27T08:42:02.120+04:00`, or `…Z`
  for UTC), so they are unambiguous whichever view was active.
- **`date` + `time` are replaced** by a single `timestamp` column (the raw line still has the originals).
- **IIS `+` encoding is kept** as stored (e.g. `Mozilla/5.0+(Windows…)`), so values match the file and search
  works on what you see in the raw line.
- **Default-hidden columns**: `cs(Cookie)`, `sc-substatus`, `sc-win32-status` start hidden (column chooser to show).
- **Facets vs ranges**: a column becomes a facet when it has < 200 distinct values, except duration/bytes columns
  (always ranges), URI/query/message/derived booleans (dedicated filters) and entirely empty columns.
  At most 24 facet columns (they share a 32-bit mask).
- **Facet counts exclude their own selection** (standard faceted search), so selecting `c-ip = X` still shows
  counts for the other IPs.
- **Search runs over the raw line** with a case-insensitive RegExp (plain text is escaped), which avoids keeping a
  second lowercase copy of every row in memory.
- **Filters reset when a new file is loaded**, except the first load after opening a URL with `#f=…` filters.
  Re-parsing with a different format keeps the filters.
- **"Only errors"** uses HTTP status ≥ 400 when the format has a status column, otherwise ERROR/FATAL levels.
- **Export**: CSV contains the visible columns (what you see); JSON contains every field plus `lineNo`.
- **Indexing waits for parsing to finish**: during a load the table shows rows as they arrive, unfiltered;
  filters, facets and insights appear once the file is fully parsed (rebuilding the index for every batch
  would waste main-thread time).
- **Pasted text** goes through the same worker pipeline as a file (wrapped in a `Blob`), so format detection,
  the format override and every feature work the same. It is shown as `pasted-text.txt`, and exports are named
  `pasted-text-filtered.csv/json`. Ctrl+V outside a text field loads the clipboard immediately (a copied file is
  opened as a file); the **Paste text…** dialog lets you review or edit the text first (Ctrl+Enter parses).
  Pasting replaces the current data, like opening a new file.
- **Preferences** (theme, density, slow threshold, insights open) live in `localStorage`; failures are ignored.

## Known limitations

- Zone-less timestamps can't be reinterpreted as local time (they are always read as UTC); the Local view only
  converts from that assumption. Mixed-offset logs are shown in UTC rather than in each line's own offset.

- Rows are held in memory as objects; very large files (≫ 100 MB / several million lines) can exhaust the tab's
  memory. In the benchmark an 85 MB file used ≈ 450 MB of heap in Node; in the browser expect more, since the
  worker and the main thread briefly both hold a batch while it is copied across.
- Batches are copied (structured clone) from the worker to the main thread rather than transferred.
- IIS data without any `#Fields:` header is not auto-detected (it parses as generic text); lines before the first
  `#Fields:` are reported as malformed.
- Generic text detection only recognises ISO-like timestamps at the start of a line (not syslog `Oct 27 …`).
- Apache detection expects the standard combined/common layout; custom `LogFormat`s fall back to generic text.
- Sorting runs on the main thread (≈ 0.3 s for a string column at 500k rows in the benchmark).
- The numeric range sliders are linear, which is coarse for heavy-tailed byte counts (use the number inputs).
- Column order, widths and visibility are per session (reset when a new file is loaded).
- Clipboard copy needs a secure context (https or localhost); a `document.execCommand` fallback is used otherwise.
