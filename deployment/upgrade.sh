#!/bin/sh
set -eu
: "${HAPI_OLD_HUB_CONTAINER:?Set the container running the old Hub}"
deployment_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Use the reviewed deployment file even when invoked inside an existing HAPI session.
unset HAPI_HOME DB_PATH DATABASE_URL HAPI_UID HAPI_GID HAPI_POSTGRES_DATA_DIR
unset POSTGRES_ADMIN_PASSWORD HAPI_DATABASE_PASSWORD HAPI_BIND_ADDRESS HAPI_PORT HAPI_PUBLIC_URL
docker compose --env-file "$deployment_dir/.env" -f "$deployment_dir/compose.yml" config --quiet
docker compose --env-file "$deployment_dir/.env" -f "$deployment_dir/compose.yml" build hub
docker compose --env-file "$deployment_dir/.env" -f "$deployment_dir/compose.yml" up -d --wait --wait-timeout 180 postgres
# Source data remains fixed until import, verification and readiness complete.
docker stop "$HAPI_OLD_HUB_CONTAINER"
docker compose --env-file "$deployment_dir/.env" -f "$deployment_dir/compose.yml" up -d --no-build --wait --wait-timeout 900 hub
