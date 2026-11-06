# Changelog

What changed in each Logsift release, newest first. The in-app Help shows the latest entries too.

## 0.7.2 — 2026-11-06

### Fixed

- The `logsifter` npm package now includes its MIT license file.

## 0.7.1 — 2026-11-06

### New

- **The launcher is on npm as `logsifter`**: `npx logsifter --azure my-api -g my-group` watches an App Service live,
  and `kubectl logs -f … | npx logsifter` shows any command's output, with nothing to install first.

### Security

- **CSV exports can't run formulas any more**: a log field starting with `=`, `+`, `-` or `@` (a user agent or URL
  chosen by whoever sent the request) is exported with a leading `'`, so Excel shows it as text instead of running it.
- **The Logsift for Kudu bookmark is stricter**: it only lists and reads folders named as log folders (`LogFiles`,
  `Logs`, `app-logs`…), not every folder with "log" somewhere in its name (`blog`, `catalog`), and it refuses more
  key and settings files (`keys.json`, `local.settings.json`, connection strings). **Drag the bookmark to the
  bookmarks bar again** to replace one made with 0.7.0.
- The app now has a Content Security Policy: it runs only its own code and connects nowhere but its own address.
- A shared link can no longer freeze the tab with a regular expression that takes too long; such a search is
  done as plain text.
- **Copy as Markdown** escapes links, images and HTML found in log text.
- A compressed file that unpacks to more than 2 GB is stopped with a message instead of running the tab out of memory.

## 0.7.0 — 2026-11-05

### New

- **Azure App Service logs live, with no install**: **Azure App Service…** on the start page sets up a
  **Logsift for Kudu** bookmark. Click it on your app's Kudu site, choose a folder (application logs, your app's own
  Logs folder, IIS logs, or any other), and its newest files open with new lines arriving live. It uses your normal
  Azure portal sign-in; the logs go from Azure to your browser only. The bookmark reads log files only, never the
  app's settings or secrets (such as `appsettings.json` or `web.config`).

## 0.6.0 — 2026-11-05

### New

- **The `logsift` launcher** (`cli/` in the repository, not on npm yet): watch Azure App Service logs live with
  `--azure my-api -g my-group` (it runs `az webapp log tail` for you), or pipe in any command: `kubectl logs -f …`,
  `docker logs -f …`, `ssh … tail -F …`. It opens Logsift with the stream live, served from your own computer only.
  See the README for how to run it.

## 0.5.0 — 2026-11-05

### New

- **More samples** on the start page: a demo of an API whose payments start failing (it opens in Compare, showing
  what broke), a live demo that keeps writing new lines, and one small log of each supported kind.
- The start page shows what you can do, with one-click demos.

### Fixed

- Compare no longer lists lines without a URL (application messages among requests) as an endpoint.

## 0.4.0 — 2026-11-05

### New

- **Compare** tab: what changed between two time ranges (the two halves of the log, the last 15 minutes / hour /
  day against the one before, or before and after a time you pick). It shows endpoints that got more errors, slower
  or busier, messages that are new or more frequent, and values such as status codes or IPs seen only in the later
  range, all per minute. Click a line to see those rows. The "last …" ranges follow live tail.

## 0.3.0 — 2026-11-05

### New

- **Live tail**: **Open folder…** (Chrome, Edge) opens the newest log files in a folder and keeps watching it: lines
  written to the files and new files appear as they arrive. A live bar shows what is watched, with **Follow** (keep
  the newest row in view), **Pause** and **Stop**. You can also drop a folder on the page, and **Reopen** the last
  folder from the start page. Files opened with *Open with → Logsift* in the installed app are watched too.
- **Column layouts are remembered** per log format: order, widths and hidden columns come back for the next log of
  the same kind. **Reset** in the column chooser forgets them.
- **Copy as Markdown**: the filtered rows as a table with a short summary, ready for an issue, a pull request or chat.
- **Read wrongly?** in the file bar reports a log that Logsift doesn't read correctly: it shows the first lines with
  IP addresses, e-mail addresses, GUIDs and tokens masked, and opens a prefilled GitHub issue. Nothing is sent until
  you submit it on GitHub.

### Fixed

- Lines appended in UTF-16 (Windows PowerShell's `>>` and `Out-File`) are read instead of showing up as malformed,
  and UTF-16 log files open.
- A line saved halfway by an editor (auto-save) is no longer split in two.
- A file ending with a newline no longer counts an extra empty line.

## 0.2.0 — 2026-11-04

### New

- Reads more of the logs developers use: **Python** logging, **logback / log4j** (with a thread column), **Spring
  Boot**, **Nginx error logs**, **pino / bunyan** JSON (numeric levels, request fields), **Docker** container logs
  and **logfmt** (Go, Heroku, Loki).
- **Custom pattern…** in the Format menu reads any other layout: describe a line like
  `{time} [{thread}] {level} {logger} - {message}` and preview the result before applying it.

## 0.1.0 — 2026-10-30

First release.

- Opens IIS W3C logs, IIS failed request traces, Windows Event Log exports, Apache/Nginx access logs, Serilog,
  JSON, syslog, CSV/TSV and plain-text logs; several files at once, and `.gz` / `.zip` archives.
- Filters, search, time range, Insights, Endpoints, Patterns and Charts views; CSV and JSON export.
- Time zone detection with a log/local time switch; real client IPs behind proxies.
- Installable, works offline, and nothing leaves your computer.
