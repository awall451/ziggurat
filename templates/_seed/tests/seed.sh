#!/bin/bash
# The seed's first test: the repository explains itself and has its checks.
# Do not delete it to pass the gate; replace it with a real test instead.
cd "$(dirname "$0")/.." || exit 1
[ -s README.md ] && [ -f tools/check ] && [ -d docs ]
