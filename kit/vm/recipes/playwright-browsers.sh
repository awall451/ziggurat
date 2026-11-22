#!/bin/bash
# Domains: registry.npmjs.org
# Fetch: cdn.playwright.dev playwright.download.prss.microsoft.com storage.googleapis.com/chrome-for-testing-public/
# Version: required (the Playwright version the project uses, e.g. 1.49.1)
# Chromium for Playwright, with its system libraries, in /opt/ms-playwright where
# the agents and the gate both find it (PLAYWRIGHT_BROWSERS_PATH). Installs from
# the npm registry, never from the project's own files. The browser builds are
# fetched by the console: they come from a Google bucket the proxy does not allow.
#
#   playwright-browsers.sh needs <version>     the files this version downloads: "<url> <name>" lines
#   playwright-browsers.sh install <version>   install them from $AGENT_KIT_FILES
set -euo pipefail
step=${1:?needs or install}
ver=${2:?a Playwright version is needed}
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
tmp=$(mktemp -d)
trap 'cd /; rm -rf "$tmp"' EXIT
cd "$tmp"
npm install --no-audit --no-fund --loglevel=error "playwright@$ver" >&2
pw=$tmp/node_modules/.bin/playwright
# What `install chromium` would download: its own dry run names every file.
urls() { "$pw" install --dry-run chromium | sed -n 's/^ *Download url: *//p'; }

case "$step" in
  needs)
    # Asked twice: once for the real addresses, once with a stand-in host, which
    # gives the path Playwright asks a mirror for. The two lists pair up line by line.
    real=$(urls)
    here=$(PLAYWRIGHT_DOWNLOAD_HOST=http://mirror.invalid urls | sed 's#^http://mirror.invalid/##')
    [ -n "$real" ] && [ "$(wc -l <<< "$real")" = "$(wc -l <<< "$here")" ] || { echo "could not read Playwright's download list" >&2; exit 1; }
    paste -d' ' <(printf '%s\n' "$real") <(printf '%s\n' "$here")
    ;;
  install)
    files=${AGENT_KIT_FILES:?the fetched files are needed}
    # Playwright's own installer puts each build where it belongs: it is pointed
    # at this folder, served on this machine only, with no proxy in between.
    node -e '
      const http = require("http"), fs = require("fs"), path = require("path");
      const root = path.resolve(process.argv[1]);
      const srv = http.createServer((req, res) => {
        const file = path.join(root, path.normalize(decodeURIComponent(req.url.split("?")[0])));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-length": fs.statSync(file).size });
        fs.createReadStream(file).pipe(res);
      });
      srv.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(srv.address().port)));
    ' "$files" "$tmp/port" &
    srv=$!
    for _ in $(seq 50); do [ -s "$tmp/port" ] && break; sleep 0.1; done
    [ -s "$tmp/port" ] || { kill "$srv" 2> /dev/null; echo "could not serve the fetched files" >&2; exit 1; }
    rc=0
    env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY PLAYWRIGHT_DOWNLOAD_HOST="http://127.0.0.1:$(cat "$tmp/port")" \
      "$pw" install --force chromium || rc=$?
    kill "$srv" 2> /dev/null || true
    [ "$rc" = 0 ] || exit "$rc"
    # The system libraries come from the Ubuntu archives, through the proxy.
    "$pw" install-deps chromium
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
    ;;
  *)
    echo "usage: playwright-browsers.sh needs|install <version>" >&2
    exit 2
    ;;
esac
