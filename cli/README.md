# logsifter

Watch a log stream live in your browser with [Logsift](https://logsift.ayzo.app/): filters, search, error counts,
charts, and a **Compare** view that shows what changed. Nothing leaves your computer: the page is served on
`127.0.0.1` only.

## Azure App Service

```sh
npx logsifter --azure my-api -g my-resource-group
```

This runs `az webapp log tail` for you and opens Logsift with the log stream, live. Requirements:

- The [Azure CLI](https://aka.ms/installazurecli), signed in (`az login`).
- Logging turned on for the app (once):
  `az webapp log config -n my-api -g my-resource-group --application-logging filesystem --web-server-logging filesystem`

Options: `--slot <slot>`, `--subscription <id>`.

## Anything else

Pipe any command into it:

```sh
kubectl logs -f deploy/api | npx logsifter
docker logs -f api 2>&1 | npx logsifter
ssh my-vm "tail -F /var/log/app.log" | npx logsifter
```

On Windows PowerShell 5.1, prefer `--azure` over piping `az` into `npx logsifter`: PowerShell 5.1 re-encodes text
between commands and can turn non-ASCII characters into `?`.

## Options

| Option | |
| --- | --- |
| `--name <label>` | Name shown in Logsift (default: the app, or `stdin`) |
| `--port <n>` | Port on 127.0.0.1 (default: a free one) |
| `--no-open` | Don't open the browser; print the address instead |
| `--help`, `--version` | |

Press **Ctrl+C** to stop. When the input ends (the command exits), Logsift keeps showing what it received.

## How it works

`logsifter` starts a small web server on `127.0.0.1` that serves the Logsift app and the lines received so far, then
new ones as they arrive (the newest 256 MB are kept for a page that reloads). The stream needs a random token that
is only in the address opened in your browser, and requests for any other host name are refused, so other
machines and web sites can't read it. The app reads the stream with the same live tail it uses for folders.

MIT license. Source: <https://github.com/anwarptr/Logsift>.
