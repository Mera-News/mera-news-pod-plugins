#!/usr/bin/env bash
# Runs a command that clones private Mera-News repositories over SSH, one read-only deploy key per
# repository: with-deploy-keys.sh <repo>=<ENV VAR> [<repo>=<ENV VAR> ...] -- <command> [args...]
#
# Each repository gets its own SSH host alias with its own key, and git rewrites every URL form
# of that repository to the alias, so one command (npm ci, say) can clone two repositories that
# each need a different key. Keys are written 0600 under RUNNER_TEMP, never printed, removed on exit.
set -euo pipefail

dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/deploy-keys.XXXXXX")
trap 'rm -rf "$dir"' EXIT
umask 077

# GitHub's published ed25519 host key ("GitHub's SSH key fingerprints" in the GitHub docs).
# Pinned, so an unknown host is refused, never accepted.
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$dir/known_hosts"
: > "$dir/ssh_config"

count=0
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  repo="${1%%=*}"
  var="${1#*=}"
  key="${!var:-}"
  [ -n "$key" ] || { echo "the $var secret is not set" >&2; exit 1; }
  printf '%s\n' "$key" > "$dir/$repo.key"
  cat >> "$dir/ssh_config" <<EOF
Host github-$repo
  HostName github.com
  User git
  IdentityFile $dir/$repo.key
  IdentitiesOnly yes
  HostKeyAlias github.com
  UserKnownHostsFile $dir/known_hosts
  StrictHostKeyChecking yes
  HostKeyAlgorithms ssh-ed25519
EOF
  for from in "https://github.com/Mera-News/$repo" "ssh://git@github.com/Mera-News/$repo" "git@github.com:Mera-News/$repo"; do
    export "GIT_CONFIG_KEY_$count=url.git@github-$repo:Mera-News/$repo.insteadOf"
    export "GIT_CONFIG_VALUE_$count=$from"
    count=$((count + 1))
  done
  shift
done
[ "${1:-}" = "--" ] || { echo "usage: with-deploy-keys.sh <repo>=<ENV VAR> ... -- <command>" >&2; exit 1; }
shift

export GIT_CONFIG_COUNT=$count
export GIT_SSH_COMMAND="ssh -F $dir/ssh_config"
"$@"
