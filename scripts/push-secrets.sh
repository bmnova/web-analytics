#!/usr/bin/env bash
# Create a writer key for one site and store it, plus the other WA_* settings, on the host.
# The key is written to a private temp dir, piped into the host CLI, and deleted; it is never printed.
#
#   scripts/push-secrets.sh vercel     <gcp-project> <site> [linked-vercel-project-dir]
#   scripts/push-secrets.sh cloudflare <gcp-project> <site> [worker-project-dir]
#
# Needs: gcloud (logged in), openssl, and `vercel` (project linked with `vercel link`) or `npx wrangler` (logged in).
set -euo pipefail

target=${1:?vercel or cloudflare}
project=${2:?gcp project id}
site=${3:?site label}
dir=${4:-.}
dataset=${WA_BQ_DATASET:-web_analytics}
sa="web-analytics-writer@${project}.iam.gserviceaccount.com"

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Creating a key for $sa ..."
gcloud iam service-accounts keys create "$tmp/key.json" --iam-account="$sa" --project="$project" --quiet >/dev/null 2>&1
salt=$(openssl rand -hex 32)

cd "$dir"
case "$target" in
  vercel)
    add() { printf %s "$2" | vercel env add "$1" production ${3:-} >/dev/null && echo "  set $1"; }
    add WA_GCP_SA_KEY "$(tr -d '\n' < "$tmp/key.json")" --sensitive
    add WA_SALT_SECRET "$salt" --sensitive
    add WA_BQ_PROJECT "$project"
    add WA_BQ_DATASET "$dataset"
    add WA_SITE "$site"
    echo "Done. Redeploy the Vercel project for the variables to take effect."
    ;;
  cloudflare)
    tr -d '\n' < "$tmp/key.json" | npx wrangler secret put WA_GCP_SA_KEY >/dev/null && echo "  set WA_GCP_SA_KEY"
    printf %s "$salt" | npx wrangler secret put WA_SALT_SECRET >/dev/null && echo "  set WA_SALT_SECRET"
    echo "Done. Add these non-secret vars to wrangler.jsonc \"vars\":"
    echo "  \"WA_BQ_PROJECT\": \"$project\", \"WA_BQ_DATASET\": \"$dataset\", \"WA_SITE\": \"$site\""
    ;;
  *) echo "unknown target: $target" >&2; exit 1 ;;
esac
