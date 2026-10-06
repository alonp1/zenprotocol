#!/bin/bash
# Turn a fresh Ubuntu server into a GitHub self-hosted runner for the replay test.
# Get TOKEN from: GitHub repo -> Settings -> Actions -> Runners -> New self-hosted runner
# (the token shown in the "Configure" step, valid for 1 hour).
#
#   TOKEN=XXXX bash setup-replay-runner.sh
set -euo pipefail
: "${TOKEN:?set TOKEN from the GitHub 'New self-hosted runner' page}"
REPO="${REPO:-alonp1/zenprotocol}"
VER="${RUNNER_VERSION:-2.328.0}"

apt-get update -y && apt-get install -y curl git
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
usermod -aG docker runner
mkdir -p /opt/actions-runner && chown runner:runner /opt/actions-runner
cd /opt/actions-runner
if [ ! -f config.sh ]; then
  curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz"
  tar xzf runner.tgz && rm runner.tgz && chown -R runner:runner .
fi
sudo -u runner ./config.sh --unattended --url "https://github.com/$REPO" --token "$TOKEN" \
  --name "replay-$(hostname)" --labels replay --replace
./svc.sh install runner
./svc.sh start
echo "Runner online. Start a replay by pushing to the 'replay' branch."
