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

  APPARMOR_OPT=$(echo "$INSPECT" | jq -r '.[0].AppArmorProfile // "none"' 2>/dev/null)
  if [[ "$APPARMOR_OPT" == "chromium-hardened" ]]; then
    pass "AppArmor profile is chromium-hardened (docker-default + userns,)"
  else
    fail "AppArmor profile is not chromium-hardened: $APPARMOR_OPT"
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

  # Check renderer networks
  NETWORKS=$(echo "$INSPECT" | jq -r '.[0].NetworkSettings.Networks // {} | keys[]' 2>/dev/null)
  echo "  INFO: Renderer networks: $NETWORKS"
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
section "Direct Internet Egress"

# Note: With internal:true network, direct egress is blocked at Docker level.
# Without internal:true, the renderer relies on proxy configuration and
# application-level SSRF controls. This test checks if Chromium traffic
# goes through the proxy (verified by the proxy access tests below).

# ---- Chromium Sandbox ----
section "Chromium Sandbox"

echo "  INFO: Kernel: $(renderer_exec uname -a 2>/dev/null || echo unknown)"
echo "  INFO: Docker version: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
echo "  INFO: Container UID/GID: $(renderer_exec sh -c 'id' 2>/dev/null || echo unknown)"
echo "  INFO: unprivileged_userns_clone: $(renderer_exec cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 'n/a (not exposed in container)')"
echo "  INFO: max_user_namespaces: $(renderer_exec cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 'n/a (not exposed in container)')"
echo "  INFO: Seccomp profile path: docker/security/chromium-seccomp.json"
echo "  INFO: Live AppArmor label: $(renderer_exec cat /proc/self/attr/current 2>/dev/null || echo unknown)"
echo "  INFO: Raw unshare --user test: $(renderer_exec sh -c 'unshare --user --map-root-user id 2>&1' || echo failed)"

SANDBOX_CHECK=$(renderer_exec node -e "
import('playwright').then(async ({ chromium }) => {
  const fs = await import('node:fs/promises');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ['--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--no-first-run'],
  });
  console.log('LAUNCH_OK');

  let cmdlines = [];
  try {
    const pids = await fs.readdir('/proc');
    for (const pid of pids) {
      if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue;
      try {
        const raw = await fs.readFile('/proc/' + pid + '/cmdline', 'utf8');
        if (raw.includes('chrome-headless-shell')) cmdlines.push(raw.replace(/\x00/g, ' ').trim());
      } catch {}
    }
  } catch {}
  console.log('CMDLINE_COUNT:' + cmdlines.length);
  console.log('CMDLINE_ONE:' + (cmdlines[0] || '').slice(0, 200));
  const noSandboxMatch = cmdlines.find((c) => c.includes('--no-sandbox'));
  const setuidMatch = cmdlines.find((c) => c.includes('--disable-setuid-sandbox'));
  console.log('CMDLINE_HAS_NO_SANDBOX:' + !!noSandboxMatch);
  console.log('CMDLINE_HAS_DISABLE_SETUID:' + !!setuidMatch);
  if (noSandboxMatch) console.log('MATCH_NO_SANDBOX:' + noSandboxMatch.slice(0, 400));
  if (setuidMatch) console.log('MATCH_SETUID:' + setuidMatch.slice(0, 400));

  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'networkidle', timeout: 15000 });
  const title = await page.title();
  console.log('RENDER_OK:' + title);
  await browser.close();
  console.log('CLOSE_OK');
}).catch((e) => { console.log('LAUNCH_FAIL:' + e.message); process.exit(1); });
" 2>&1) || true

if echo "$SANDBOX_CHECK" | grep -q "LAUNCH_OK"; then
  pass "Chromium launched with chromiumSandbox=true"
else
  fail "Chromium sandbox launch failed"
  echo "  DETAIL: $SANDBOX_CHECK"
fi

if echo "$SANDBOX_CHECK" | grep -q "RENDER_OK"; then
  pass "Sandboxed render succeeded ($(echo "$SANDBOX_CHECK" | grep -o 'RENDER_OK:.*'))"
else
  fail "Sandboxed render did not complete"
fi

if echo "$SANDBOX_CHECK" | grep -q "CLOSE_OK"; then
  pass "Sandboxed browser closed cleanly"
else
  fail "Sandboxed browser did not close cleanly"
fi

if echo "$SANDBOX_CHECK" | grep -q "CMDLINE_HAS_NO_SANDBOX:false" && \
   echo "$SANDBOX_CHECK" | grep -q "CMDLINE_HAS_DISABLE_SETUID:false"; then
  pass "No forbidden sandbox-bypass flags on live Chromium command line"
else
  fail "Forbidden sandbox-bypass flag found on live Chromium command line"
  echo "  DEBUG: $(echo "$SANDBOX_CHECK" | grep -E 'CMDLINE_HAS|CMDLINE_ONE:|MATCH_NO_SANDBOX|MATCH_SETUID')"
fi

echo "  INFO: $(echo "$SANDBOX_CHECK" | grep -o 'CMDLINE_COUNT:.*')"

# No lingering Chromium processes after the sandbox check closes its browser.
# Each grep here checks only ONE substring, so neither grep's own argv/cmdline
# (visible to itself in /proc) ever contains both substrings at once --
# a single combined pattern would match its own invocation (quining).
sleep 3
LEFTOVER=$(renderer_exec sh -c 'count=0; for f in /proc/[0-9]*/cmdline; do grep -q ms-playwright "$f" 2>/dev/null && grep -q chrome-headless-shell "$f" 2>/dev/null && count=$((count+1)); done; echo $count' 2>/dev/null || echo "0")
LEFTOVER="${LEFTOVER//[[:space:]]/}"
if [[ "$LEFTOVER" =~ ^[0-9]+$ ]] && [[ "$LEFTOVER" -eq 0 ]]; then
  pass "No leftover Chromium processes after sandboxed launch"
else
  fail "Leftover Chromium processes detected: $LEFTOVER"
  renderer_exec sh -c 'for f in /proc/[0-9]*/cmdline; do grep -q ms-playwright "$f" 2>/dev/null && grep -q chrome-headless-shell "$f" 2>/dev/null && { echo "  DEBUG: $f:"; tr "\0" " " < "$f"; echo; }; done' || true
fi

# Restart/recovery: the renderer must be able to launch a fresh sandboxed
# browser again after the previous one closed (simulates crash recovery).
RECOVERY_CHECK=$(renderer_exec node -e "
import('playwright').then(async ({ chromium }) => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'networkidle', timeout: 15000 });
  console.log('RECOVERY_OK:' + (await page.title()));
  await browser.close();
}).catch((e) => console.log('RECOVERY_FAIL:' + e.message));
" 2>&1) || true
if echo "$RECOVERY_CHECK" | grep -q "RECOVERY_OK"; then
  pass "Sandboxed browser can relaunch after previous instance closed"
else
  fail "Sandboxed browser failed to relaunch: $RECOVERY_CHECK"
fi

# chrome://sandbox is not reliably readable in headless mode; this is
# informational only and does not gate pass/fail. The authoritative signals
# are: successful sandboxed launch above, chromiumSandbox=true, absence of
# --no-sandbox/--disable-setuid-sandbox on the live process, active seccomp
# profile, and non-root UID (all checked above/elsewhere in this script).
SANDBOX_PAGE=$(renderer_exec node -e "
import('playwright').then(async ({ chromium }) => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto('chrome://sandbox', { timeout: 5000 }).catch(() => {});
  const text = await page.content().catch(() => '');
  console.log(text.replace(/\n/g, ' ').slice(0, 500));
  await browser.close();
}).catch((e) => console.log('UNREADABLE:' + e.message));
" 2>&1) || true
if [[ -z "$SANDBOX_PAGE" || "$SANDBOX_PAGE" == UNREADABLE* ]]; then
  echo "  INFO: chrome://sandbox not readable in headless mode (expected) — relying on launch/cmdline/seccomp/UID evidence above instead."
else
  echo "  INFO: chrome://sandbox output (best-effort): ${SANDBOX_PAGE:0:300}"
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
