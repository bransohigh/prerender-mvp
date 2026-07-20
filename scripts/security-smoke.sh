#!/usr/bin/env bash
# Security smoke tests for hardened Docker compose
# Usage: bash scripts/security-smoke.sh
# Requires: docker, curl, jq
# Must be run with compose.hardened.yml already up and healthy.

set -Eeuo pipefail

COMPOSE_FILE="compose.hardened.yml"
RENDERER_SERVICE="renderer-api"
API_URL="http://127.0.0.1:3000"
API_KEY="${API_KEY:-}"

if [[ -z "$API_KEY" ]]; then
  echo "ERROR: API_KEY environment variable must be set"
  exit 1
fi

PASS=0
FAIL=0
ERRORS=()

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; ERRORS+=("$1"); }
section() { echo ""; echo "=== $1 ==="; }

renderer_exec() {
  docker compose -f "$COMPOSE_FILE" exec -T "$RENDERER_SERVICE" "$@" 2>/dev/null
}

get_container_id() {
  docker compose -f "$COMPOSE_FILE" ps -q "$1" 2>/dev/null | head -1
}

# ---- Container Identity ----
section "Container Identity"

RENDERER_UID=$(renderer_exec id -u || echo "error")
if [[ "$RENDERER_UID" =~ ^[0-9]+$ && "$RENDERER_UID" -ne 0 ]]; then
  pass "Renderer UID is $RENDERER_UID (non-root)"
else
  fail "Renderer is running as root or could not determine UID ($RENDERER_UID)"
fi

# ---- Read-only Filesystem ----
section "Read-only Filesystem"

WRITE_RESULT=$(renderer_exec sh -c 'touch /should-not-write 2>&1; echo "exit:$?"' || echo "exit:error")
if echo "$WRITE_RESULT" | grep -qi "read-only\|permission denied" || [[ "$WRITE_RESULT" == *"exit:1"* ]]; then
  pass "Root filesystem is read-only"
else
  fail "Root filesystem appears writable"
fi

if renderer_exec sh -c 'touch /tmp/test-write && rm /tmp/test-write'; then
  pass "/tmp is writable"
else
  fail "/tmp is not writable"
fi

# ---- Docker Inspect ----
section "Container Security Configuration"

CONTAINER_ID=$(get_container_id "$RENDERER_SERVICE")
if [[ -z "$CONTAINER_ID" ]]; then
  fail "Could not find renderer container"
  # Skip inspect-dependent tests
else
  INSPECT=$(docker inspect "$CONTAINER_ID")

  if echo "$INSPECT" | jq -e '.[0].HostConfig.Privileged == false' > /dev/null 2>&1; then
    pass "privileged=false"
  else
    fail "Container may be privileged"
  fi

  if echo "$INSPECT" | jq -e '.[0].HostConfig.SecurityOpt // [] | map(select(contains("no-new-privileges"))) | length > 0' > /dev/null 2>&1; then
    pass "no-new-privileges is set"
  else
    fail "no-new-privileges not found"
  fi

  SECCOMP=$(echo "$INSPECT" | jq -r '.[0].HostConfig.SecurityOpt // [] | map(select(startswith("seccomp"))) | .[0] // "none"' 2>/dev/null)
  if [[ "$SECCOMP" != "none" ]]; then
    pass "Seccomp profile is set"
  else
    fail "No seccomp profile found"
  fi

  if echo "$INSPECT" | jq -e '.[0].HostConfig.CapDrop // [] | index("ALL")' > /dev/null 2>&1; then
    pass "cap_drop ALL is set"
  else
    fail "cap_drop ALL not found"
  fi

  CAP_ADD=$(echo "$INSPECT" | jq -r '.[0].HostConfig.CapAdd // [] | length' 2>/dev/null)
  if [[ "$CAP_ADD" == "0" ]]; then
    pass "No capabilities added (no SYS_ADMIN)"
  else
    CAP_LIST=$(echo "$INSPECT" | jq -r '.[0].HostConfig.CapAdd // [] | join(",")' 2>/dev/null)
    fail "Capabilities added: $CAP_LIST"
  fi

  if echo "$INSPECT" | jq -e '.[0].HostConfig.ReadonlyRootfs == true' > /dev/null 2>&1; then
    pass "ReadonlyRootfs=true in inspect"
  else
    fail "ReadonlyRootfs not true in inspect"
  fi

  MEM_LIMIT=$(echo "$INSPECT" | jq -r '.[0].HostConfig.Memory // 0' 2>/dev/null)
  if [[ "$MEM_LIMIT" -gt 0 ]]; then
    pass "Memory limit set: $((MEM_LIMIT / 1024 / 1024)) MB"
  else
    fail "No memory limit"
  fi

  # CPU limit: check NanoCpus first, then CpuQuota
  CPU_NANO=$(echo "$INSPECT" | jq -r '.[0].HostConfig.NanoCpus // 0' 2>/dev/null)
  CPU_QUOTA=$(echo "$INSPECT" | jq -r '.[0].HostConfig.CpuQuota // 0' 2>/dev/null)
  if [[ "$CPU_NANO" -gt 0 ]]; then
    pass "CPU limit set via NanoCpus: $((CPU_NANO / 1000000000)) CPUs"
  elif [[ "$CPU_QUOTA" -gt 0 ]]; then
    pass "CPU limit set via CpuQuota: $CPU_QUOTA"
  else
    fail "No CPU limit"
  fi

  PID_LIMIT=$(echo "$INSPECT" | jq -r '.[0].HostConfig.PidsLimit // 0' 2>/dev/null)
  if [[ "$PID_LIMIT" -gt 0 ]]; then
    pass "PID limit set: $PID_LIMIT"
  else
    fail "No PID limit"
  fi

  # Check no Docker socket mount
  DOCKER_SOCK=$(echo "$INSPECT" | jq -r '[.[0].Mounts // [] | .[] | select(.Source | contains("docker.sock"))] | length' 2>/dev/null)
  if [[ "$DOCKER_SOCK" == "0" ]]; then
    pass "No Docker socket mount"
  else
    fail "Docker socket is mounted"
  fi

  # Check renderer is NOT on external network
  NETWORKS=$(echo "$INSPECT" | jq -r '.[0].NetworkSettings.Networks // {} | keys[]' 2>/dev/null)
  if echo "$NETWORKS" | grep -qi "external"; then
    fail "Renderer is connected to external network"
  else
    pass "Renderer NOT on external network"
  fi
fi

# Check proxy has no published host ports
section "Proxy Port Exposure"

PROXY_ID=$(get_container_id "egress-proxy")
if [[ -n "$PROXY_ID" ]]; then
  PROXY_PORTS=$(docker inspect "$PROXY_ID" | jq -r '.[0].HostConfig.PortBindings // {} | keys[]' 2>/dev/null || echo "")
  if [[ -z "$PROXY_PORTS" ]]; then
    pass "Proxy has no published ports"
  else
    fail "Proxy has published ports: $PROXY_PORTS"
  fi
else
  fail "Could not find proxy container"
fi

# ---- Direct Egress ----
section "Direct Internet Egress (should fail)"

if renderer_exec sh -c 'unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY && node -e "fetch(\"http://httpbin.org/ip\",{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))"' 2>/dev/null; then
  fail "Renderer can reach internet directly (without proxy)"
else
  pass "Direct internet access blocked from renderer"
fi

# ---- Proxy Public Access ----
section "Proxy Public Internet Access"

PUBLIC_HTTP_OK=false
for attempt in 1 2 3; do
  if renderer_exec node -e "
    fetch('http://httpbin.org/ip', { signal: AbortSignal.timeout(15000) })
      .then(r => { if (r.ok) process.exit(0); else process.exit(1); })
      .catch(() => process.exit(1));
  " 2>/dev/null; then
    PUBLIC_HTTP_OK=true
    break
  fi
  sleep 2
done
if $PUBLIC_HTTP_OK; then
  pass "Public HTTP via proxy works"
else
  fail "Public HTTP via proxy failed (3 attempts)"
fi

PUBLIC_HTTPS_OK=false
for attempt in 1 2 3; do
  if renderer_exec node -e "
    fetch('https://httpbin.org/ip', { signal: AbortSignal.timeout(15000) })
      .then(r => { if (r.ok) process.exit(0); else process.exit(1); })
      .catch(() => process.exit(1));
  " 2>/dev/null; then
    PUBLIC_HTTPS_OK=true
    break
  fi
  sleep 2
done
if $PUBLIC_HTTPS_OK; then
  pass "Public HTTPS via proxy works"
else
  fail "Public HTTPS via proxy failed (3 attempts)"
fi

# ---- Private Destination Blocking ----
section "Private Destination Blocking (via proxy)"

BLOCKED_TARGETS=(
  "http://127.0.0.1/"
  "http://localhost/"
  "http://10.0.0.1/"
  "http://169.254.169.254/latest/meta-data/"
  "http://metadata.google.internal/"
  "http://renderer-api:3000/"
  "http://egress-proxy:3128/"
)

for target in "${BLOCKED_TARGETS[@]}"; do
  RESULT=$(renderer_exec node -e "
    fetch('${target}', { signal: AbortSignal.timeout(5000) })
      .then(r => { console.log('status:' + r.status); process.exit(r.ok ? 1 : 0); })
      .catch(() => { console.log('blocked'); process.exit(0); });
  " 2>/dev/null; echo "exit:$?")

  if [[ "$RESULT" == *"exit:0"* ]]; then
    pass "Blocked: $target"
  else
    fail "NOT blocked: $target"
  fi
done

# ---- Non-standard Port Blocking ----
section "Non-standard Port Blocking (via proxy)"

BLOCKED_PORTS=(22 3000 3306 5432 6379 8080)
for port in "${BLOCKED_PORTS[@]}"; do
  RESULT=$(renderer_exec node -e "
    fetch('http://example.com:${port}/', { signal: AbortSignal.timeout(5000) })
      .then(r => { console.log('status:' + r.status); process.exit(r.ok ? 1 : 0); })
      .catch(() => { console.log('blocked'); process.exit(0); });
  " 2>/dev/null; echo "exit:$?")

  if [[ "$RESULT" == *"exit:0"* ]]; then
    pass "Port $port blocked"
  else
    fail "Port $port NOT blocked"
  fi
done

# ---- Renderer API ----
section "Renderer API (via gateway)"

HEALTH=$(curl -sf --connect-timeout 5 --max-time 10 "$API_URL/health" 2>/dev/null || echo '{"error":"timeout"}')
if echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  pass "/health returns ok"
else
  fail "/health failed: $HEALTH"
fi

RENDER=$(curl -sf --connect-timeout 10 --max-time 30 -X POST "$API_URL/v1/render" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"url":"https://example.com"}' 2>/dev/null || echo '{"error":"timeout"}')

if echo "$RENDER" | jq -e '.html | length > 100' > /dev/null 2>&1; then
  TITLE=$(echo "$RENDER" | jq -r '.title // "unknown"')
  pass "Render successful — title: $TITLE"
else
  fail "Render failed: $(echo "$RENDER" | head -c 200)"
fi

# ---- Summary ----
section "Summary"
echo "  PASSED: $PASS"
echo "  FAILED: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "  Failed tests:"
  for err in "${ERRORS[@]}"; do
    echo "    - $err"
  done
  exit 1
fi

echo ""
echo "  All security smoke tests passed."
exit 0
