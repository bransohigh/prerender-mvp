#!/usr/bin/env bash
# Generates a throwaway local CA + server certificate for the hardened
# CI/smoke TLS gateway (compose.hardened-ci.yml). CI-only: 1-day validity,
# nothing here is committed to the repo (see .gitignore), and the CA/server
# keys exist only for the lifetime of the workflow run.
#
# Usage: bash docker/gateway/generate-ci-cert.sh <output-dir>

set -Eeuo pipefail

OUT_DIR="${1:?usage: generate-ci-cert.sh <output-dir>}"
mkdir -p "$OUT_DIR"

CA_KEY="$OUT_DIR/ca.key"
CA_CRT="$OUT_DIR/ca.crt"
SERVER_KEY="$OUT_DIR/server.key"
SERVER_CSR="$OUT_DIR/server.csr"
SERVER_CRT="$OUT_DIR/server.crt"
SERVER_EXT="$OUT_DIR/server.ext"

openssl genrsa -out "$CA_KEY" 4096 > /dev/null 2>&1

openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 1 \
  -subj "/CN=prerender-mvp-ci-smoke-ca" -out "$CA_CRT"

openssl genrsa -out "$SERVER_KEY" 2048 > /dev/null 2>&1

openssl req -new -key "$SERVER_KEY" -subj "/CN=localhost" -out "$SERVER_CSR"

cat > "$SERVER_EXT" <<EOF
subjectAltName = DNS:localhost,IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF

openssl x509 -req -in "$SERVER_CSR" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$SERVER_CRT" -days 1 -sha256 -extfile "$SERVER_EXT"

rm -f "$SERVER_CSR" "$SERVER_EXT" "$OUT_DIR/ca.srl"
# World-readable (644), not 600: the gateway container's nginx worker runs
# as its own non-root "nginx" user (uid differs from the host user that
# generated these files) and must be able to read the bind-mounted key.
# Low risk here because this material is CI-run-only, 1-day validity, and
# never leaves the ephemeral runner (gitignored, deleted at job cleanup).
chmod 644 "$CA_KEY" "$SERVER_KEY"

echo "Generated CI-only TLS materials in $OUT_DIR:"
echo "  $CA_CRT   (public CA cert — use with curl --cacert for verification)"
echo "  $CA_KEY   (private, CI-run-only, gitignored)"
echo "  $SERVER_CRT / $SERVER_KEY (server cert/key for the gateway, gitignored)"
echo "SAN: DNS:localhost, IP:127.0.0.1 — validity: 1 day"
