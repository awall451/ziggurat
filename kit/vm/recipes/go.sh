#!/bin/bash
# Domains: go.dev dl.google.com proxy.golang.org sum.golang.org
# Version: required (e.g. 1.23.4)
# The Go toolchain from go.dev in /usr/local/go, on everyone's PATH. The module
# proxy and checksum domains are allowed with it, for `go mod download`.
set -euo pipefail
ver=${1:?a Go version is needed}
arch=$(dpkg --print-architecture)
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/go.tgz" "https://go.dev/dl/go${ver}.linux-${arch}.tar.gz"
rm -rf /usr/local/go
tar -C /usr/local -xzf "$tmp/go.tgz"
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
rm -rf "$tmp"
go version
