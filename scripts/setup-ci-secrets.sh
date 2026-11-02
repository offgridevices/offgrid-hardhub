#!/usr/bin/env bash
# One-time setup for CI and the automatic deploy (docs/ci.md): walks you
# through the three repository secrets, checks each one works, and saves it
# to GitHub. Run it in a terminal from the repository:
#   ./scripts/setup-ci-secrets.sh
# Needs the GitHub CLI signed in (`gh auth login`), curl, and Claude Code for
# the review's token. Values are read without echoing and go straight to
# `gh secret set`; nothing is written to disk or shown.
set -euo pipefail
REPO=offgridevices/offgrid-hardhub
ZONE=offgridevices.com
CF=https://api.cloudflare.com/client/v4

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
open_url() { command -v open >/dev/null && open "$1" || printf '  Open: %s\n' "$1"; }
save() { printf '%s' "$2" | gh secret set "$1" --repo "$REPO" >/dev/null && ok "saved $1 to GitHub"; }
# a Cloudflare API call: prints "true" when it succeeded
cf_ok() { curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$CF$1" | grep -q '"success":[[:space:]]*true' && echo true || echo false; }

command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign in to GitHub first: gh auth login"; exit 1; }
have=$(gh secret list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null || true)

# ---------------------------------------------------------------- Cloudflare
say "1 of 2 · Cloudflare key (lets merges deploy)"
if grep -qx CLOUDFLARE_API_TOKEN <<<"$have" && grep -qx CLOUDFLARE_ACCOUNT_ID <<<"$have"; then
  ok "already set"
  read -r -p "  Replace them? [y/N] " a
  [[ $a =~ ^[Yy] ]] || skip_cf=1
fi
if [ -z "${skip_cf:-}" ]; then
  cat <<'EOF'
  Your browser opens Cloudflare's API Tokens page. There:
    1. Create Token → "Edit Cloudflare Workers" → Use template
    2. Under Permissions, + Add more, twice:
         Account · D1 · Edit
         Account · Containers · Edit
    3. Account Resources: Include · OffGrid's account
       Zone Resources:    Include · Specific zone · offgridevices.com
    4. Continue to summary → Create Token → Copy
EOF
  read -r -p "  Press Enter to open the page… " _
  open_url "https://dash.cloudflare.com/profile/api-tokens"
  while :; do
    read -r -s -p "  Paste the token here (it stays hidden), then Enter: " TOKEN; echo
    [ -n "$TOKEN" ] || continue
    if [ "$(cf_ok /user/tokens/verify)" = true ]; then ok "the token is active"; break; fi
    no "Cloudflare does not accept that token. Copy it again and paste."
  done

  # the account: the one the token is limited to
  accounts=$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$CF/accounts?per_page=50")
  ids=$(grep -o '"id":"[0-9a-f]\{32\}"' <<<"$accounts" | cut -d'"' -f4 | sort -u || true)
  if [ "$(wc -l <<<"$ids" | tr -d ' ')" = 1 ] && [ -n "$ids" ]; then
    ACCOUNT=$ids; ok "account found"
  else
    no "the token reaches $(grep -c . <<<"$ids" || true) accounts; it should be limited to one."
    read -r -p "  Paste the account ID (Cloudflare dashboard → Workers & Pages, right side): " ACCOUNT
  fi

  # each thing the deploy does, tried read-only with this token
  fail=0
  check() { if [ "$(cf_ok "$2")" = true ]; then ok "$1"; else no "$1"; fail=1; fi; }
  check "Workers (deploy the site and API)" "/accounts/$ACCOUNT/workers/scripts"
  check "D1 (database changes)" "/accounts/$ACCOUNT/d1/database"
  check "R2 (file storage)" "/accounts/$ACCOUNT/r2/buckets"
  zone=$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$CF/zones?name=$ZONE" | grep -o '"id":"[0-9a-f]\{32\}"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "$zone" ]; then check "Workers Routes on $ZONE (the site's address)" "/zones/$zone/workers/routes"
  else no "Zone $ZONE (the site's address)"; fail=1; fi
  # Containers has no simple read call to try; the first deploy proves it
  printf '  · Containers (the KiCad engine): checked by the first deploy\n'

  if [ $fail = 1 ]; then
    echo "  Something above is missing from the token. Edit it in Cloudflare (… → Edit), then run this again."
    read -r -p "  Save it anyway? [y/N] " a
    [[ $a =~ ^[Yy] ]] || exit 1
  fi
  save CLOUDFLARE_API_TOKEN "$TOKEN"
  save CLOUDFLARE_ACCOUNT_ID "$ACCOUNT"
  unset TOKEN
fi

# ---------------------------------------------------------------- Claude
say "2 of 2 · Claude token (for the review and @claude)"
if grep -qx CLAUDE_CODE_OAUTH_TOKEN <<<"$have"; then
  ok "already set"
  read -r -p "  Replace it? [y/N] " a
  [[ $a =~ ^[Yy] ]] || skip_claude=1
fi
if [ -z "${skip_claude:-}" ]; then
  command -v claude >/dev/null || { echo "  Install Claude Code first: https://claude.com/claude-code"; exit 1; }
  echo "  Claude Code signs you in in the browser, then prints a token (sk-ant-oat…)."
  read -r -p "  Press Enter to start… " _
  claude setup-token
  while :; do
    read -r -s -p "  Paste the token it printed (hidden), then Enter: " CT; echo
    case "$CT" in sk-ant-*) break ;; "") ;; *) no "That does not look like the token (it starts sk-ant-). Try again." ;; esac
  done
  save CLAUDE_CODE_OAUTH_TOKEN "$CT"
  unset CT
fi

say "Done"
gh secret list --repo "$REPO"
echo
echo "  Next: merge the CI pull request. That merge is the first automatic deploy."
