#!/bin/bash
# Runs once as root in the new VM, before the kit is installed.
# The gate and the team build a fresh venv for every checkout, so the VM needs
# the venv module; everything else comes from requirements files.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q python3-venv > /dev/null
python3 -m venv --help > /dev/null
echo "python3-venv ready: $(python3 --version)"
