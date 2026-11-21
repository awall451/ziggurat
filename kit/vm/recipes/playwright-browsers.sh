#!/bin/bash
# Domains: registry.npmjs.org cdn.playwright.dev playwright.download.prss.microsoft.com
# Version: required (the Playwright version the project uses, e.g. 1.49.1)
# Chromium for Playwright, with its system libraries, in /opt/ms-playwright where
# the agents and the gate both find it (PLAYWRIGHT_BROWSERS_PATH). Installs from
# the npm registry, never from the project's own files.
set -euo pipefail
ver=${1:?a Playwright version is needed}
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
tmp=$(mktemp -d)
cd "$tmp"
npx -y "playwright@$ver" install --with-deps chromium
chmod -R a+rX /opt/ms-playwright
cd / && rm -rf "$tmp"
