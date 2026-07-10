#!/usr/bin/env bash
set -euo pipefail

host="${DEPLOY_HOST:-192.168.50.232}"
user="${DEPLOY_USER:-kszero}"
deploy_dir="${DEPLOY_DIR:-/volume3/docker/zsh-web}"
docker_bin="${DEPLOY_DOCKER:-/usr/local/bin/docker}"

root="$(git rev-parse --show-toplevel)"
cd "$root"

revision="$(git rev-parse --short HEAD)"
printf 'Deploying %s to %s@%s:%s\n' "$revision" "$user" "$host" "$deploy_dir"

printf -v remote_command \
  'set -eu; mkdir -p %q; tar -xf - -C %q; cd %q; sudo -n %q compose up -d --build; sudo -n %q compose ps' \
  "$deploy_dir" "$deploy_dir" "$deploy_dir" "$docker_bin" "$docker_bin"

git archive --format=tar HEAD | ssh "$user@$host" "$remote_command"
