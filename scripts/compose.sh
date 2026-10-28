# Sourced by ./hardhub and e2e/run.sh: `compose ...` runs Docker Compose.
#
# Docker Desktop ships Compose. Other Docker setups (Colima, a plain Docker
# Engine) may not have the compose and buildx add-ons; then Compose runs
# from Docker's own CLI image instead, so nothing is installed on this
# computer. It talks to the same Docker through its socket, and sees this
# folder at the same path, so relative paths in the compose files still work.
DOCKER_CLI_IMAGE=docker:29.8.2-cli@sha256:35cfcf893c20f2931f4909151b5407aaaeab711277de7ce8b8f521f095d54c32

compose() {
  if docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  # the variables the compose files read, passed through when set
  local envs=() v
  for v in HARDHUB_BIND HARDHUB_BRIDGE_URL HARDHUB_BRIDGE_TOKEN DEV_LLM_PROVIDER DEV_LLM_MODEL \
           DEV_LLM_BASE_URL DEV_LLM_KEY ANTHROPIC_BASE_URL; do
    [ -n "${!v:-}" ] && envs+=(-e "$v")
  done
  # /var/run/docker.sock is Docker's socket inside its Linux VM (Colima, Docker Desktop)
  # or on the host (Linux): the path a container mounts either way
  docker run --rm -i -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD:$PWD" -w "$PWD" \
    ${envs[@]+"${envs[@]}"} "$DOCKER_CLI_IMAGE" docker compose "$@"
}
