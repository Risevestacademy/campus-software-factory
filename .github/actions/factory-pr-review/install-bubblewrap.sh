#!/usr/bin/env bash
# Claude Code refuses CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 without bubblewrap, which
# ubuntu-latest lacks. Ubuntu 24.04's AppArmor normally lets /usr/bin/bwrap create
# user namespaces; the sysctl fallback covers runner images that still block it.
set -euo pipefail

install_bubblewrap() {
  sudo apt-get install -y -qq --no-install-recommends -o DPkg::Lock::Timeout=60 bubblewrap
}

bwrap_works() {
  bwrap --unshare-user --unshare-pid --proc /proc --dev /dev --ro-bind / / /bin/true
}

install_bubblewrap || { sudo apt-get update -qq && install_bubblewrap; }

if ! bwrap_works; then
  echo "::warning::bwrap cannot create namespaces; relaxing kernel.apparmor_restrict_unprivileged_userns on this runner"
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  bwrap_works
fi
