#!/usr/bin/env bash
# End-to-end verification of every OpenCrew user journey across the four repos.
SP=/c/Users/igorr/coding/opencrew-split
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
no()  { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m  %s  -- %s\n" "$1" "$2"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected '$3', got '$2'"; fi; }
sec() { printf "\n\033[1m== %s\033[0m\n" "$1"; }

code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

sec "SELF-HOST: build and boot"
cd "$SP/opencrew-server"
npm run build >/dev/null 2>&1 && ok "server builds" || no "server builds" "npm run build failed"
npm run fetch:app >/dev/null 2>&1 && ok "app fetched into web/" || no "app fetched" "fetch:app failed"
DATA=$(mktemp -d); rm -rf "$DATA"; mkdir -p "$DATA"
OPENCREW_DATA_DIR="$DATA" OPENCREW_PORT=8901 OPENCREW_WEB_DIR="$SP/opencrew-server/web" \
  node dist/index.js > /tmp/j-server.log 2>&1 &
for i in $(seq 1 40); do curl -sf http://127.0.0.1:8901/readyz >/dev/null 2>&1 && break; sleep 1; done
B=http://127.0.0.1:8901
chk "server /readyz" "$(code $B/readyz)" "200"
chk "app served at /" "$(code $B/)" "200"

sec "SELF-HOST: first-run security"
TOK=$(cat "$DATA/claim-token" 2>/dev/null)
[ -n "$TOK" ] && ok "claim token generated" || no "claim token" "missing"
chk "wrong claim token rejected" \
  "$(code -X POST $B/api/v1/auth/setup -H 'content-type: application/json' -d '{"email":"a@b.co","displayName":"X","password":"correct-horse-battery","claimToken":"wrong"}')" "403"
S=$(curl -s -X POST $B/api/v1/auth/setup -H 'content-type: application/json' \
  -d "{\"email\":\"igor@opencrew.test\",\"displayName\":\"Igor\",\"password\":\"correct-horse-battery-staple\",\"claimToken\":\"$TOK\"}")
T=$(echo "$S" | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
[ -n "$T" ] && ok "owner account created" || no "owner account" "$S"
chk "setup replay blocked" \
  "$(code -X POST $B/api/v1/auth/setup -H 'content-type: application/json' -d "{\"email\":\"x@y.co\",\"displayName\":\"Y\",\"password\":\"another-long-password\",\"claimToken\":\"$TOK\"}")" "409"
A="authorization: Bearer $T"
chk "authenticated /auth/me" "$(code $B/api/v1/auth/me -H "$A")" "200"
chk "unauthenticated /auth/me" "$(code $B/api/v1/auth/me)" "401"
chk "login works" "$(code -X POST $B/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"igor@opencrew.test","password":"correct-horse-battery-staple"}')" "200"
chk "wrong password rejected" "$(code -X POST $B/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"igor@opencrew.test","password":"wrong-password-here"}')" "401"

sec "SELF-HOST: provider, agent, conversation"
node "$SP/../fake-provider.mjs" > /tmp/j-provider.log 2>&1 &
for i in $(seq 1 20); do curl -sf http://127.0.0.1:9911/v1/models >/dev/null 2>&1 && break; sleep 1; done
P=$(curl -s -X POST $B/api/v1/providers -H "$A" -H 'content-type: application/json' \
  -d '{"id":"fake","kind":"openai-compatible","apiKey":"sk-secret-value","baseUrl":"http://127.0.0.1:9911/v1"}')
echo "$P" | grep -q '"hasApiKey":true' && ok "provider registered" || no "provider registered" "$P"
echo "$P" | grep -q 'sk-secret-value' && no "api key redacted" "key leaked in response" || ok "api key redacted"
curl -s $B/api/v1/providers/fake/models -H "$A" | grep -q "fake-model-1" && ok "models proxied" || no "models proxied" "no model list"
AG=$(curl -s -X POST $B/api/v1/agents -H "$A" -H 'content-type: application/json' \
  -d '{"name":"Scout","personality":"terse","modelPolicy":{"defaultProviderId":"fake","defaultModel":"fake-model-1"}}')
AID=$(echo "$AG" | python -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$AID" ] && ok "agent created" || no "agent created" "$AG"
CV=$(curl -s -X POST $B/api/v1/conversations -H "$A" -H 'content-type: application/json' -d "{\"participantId\":\"$AID\",\"participantType\":\"agent\"}")
CID=$(echo "$CV" | python -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$CID" ] && ok "conversation created" || no "conversation created" "$CV"
curl -s -X POST $B/api/v1/conversations/$CID/messages -H "$A" -H 'content-type: application/json' -d '{"body":"ping"}' >/dev/null
for i in $(seq 1 20); do
  M=$(curl -s "$B/api/v1/conversations/$CID/messages" -H "$A")
  N=$(echo "$M" | python -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
  [ "$N" -ge 2 ] && break; sleep 1
done
echo "$M" | grep -q "echo: ping" && ok "agent replied through the provider" || no "agent replied" "no assistant message"

sec "CLI: parsing and commands"
cd "$SP/opencrew-cli"
run_cli() { timeout 25 bun run src/index.ts "$@" 2>&1; }
run_cli --version | grep -q "opencrew" && ok "--version" || no "--version" "no output"
run_cli --help | grep -q "runtime list|install" && ok "help lists runtime command" || no "help lists runtime" "missing"
run_cli runtime list | grep -q "Claude Code" && ok "runtime list" || no "runtime list" "no output"
run_cli runtime install nonsense 2>&1 | grep -q "unknown runtime" && ok "bad runtime name rejected" || no "bad runtime name" "not rejected"
run_cli connect --json 2>&1 | grep -q 'unknown option "--json"' && ok "unknown flag named clearly" || no "unknown flag" "still parsed as URL"
run_cli bogus 2>&1 | grep -q "unknown command" && ok "unknown command rejected" || no "unknown command" "not rejected"
(timeout 25 bun run src/index.ts bogus >/dev/null 2>&1); chk "error exit code" "$?" "1"
printf '9\nx\n3\n' | timeout 25 bun run src/index.ts setup 2>&1 | grep -q "Enter a number from 1 to 3" \
  && ok "invalid menu input re-prompts" || no "menu re-prompt" "aborted instead"

sec "CLI: device pairing against the live server"
rm -f /tmp/j-connect.log
(timeout 90 bun run src/index.ts connect $B > /tmp/j-connect.log 2>&1 &)
for i in $(seq 1 30); do grep -qo "code [A-Z0-9]*" /tmp/j-connect.log 2>/dev/null && break; sleep 1; done
PC=$(grep -o "code [A-Z0-9]*" /tmp/j-connect.log | head -1 | awk '{print $2}')
[ -n "$PC" ] && ok "pairing code issued" || no "pairing code" "none printed"
curl -s $B/api/v1/devices/pairings/code/$PC -H "$A" | grep -q "deviceId" && ok "pairing visible to server" || no "pairing lookup" "not found"
curl -s -X POST $B/api/v1/devices/pairings/code/$PC/approve -H "$A" -H 'content-type: application/json' -d '{}' | grep -q approved \
  && ok "pairing approved" || no "pairing approved" "approve failed"
for i in $(seq 1 20); do grep -q "paired securely" /tmp/j-connect.log && break; sleep 1; done
grep -q "paired securely" /tmp/j-connect.log && ok "CLI confirms pairing" || no "CLI pairing" "$(tail -1 /tmp/j-connect.log)"
curl -s $B/api/v1/devices -H "$A" | grep -q "claude-code" && ok "device runtimes reported to server" || no "device runtimes" "not listed"

sec "CLOUD: control plane"
cd "$SP/opencrew-cloud"
npm run build >/dev/null 2>&1 && ok "cloud builds" || no "cloud builds" "build failed"
CDATA=$(mktemp -d); rm -rf "$CDATA"; mkdir -p "$CDATA"
OPENCREW_CLOUD_ADMIN_TOKEN=test-admin-token-aaaaaaaaaaaaaaaaaaaaaaaa OPENCREW_CLOUD_PORT=4201 \
  OPENCREW_CLOUD_DATA_DIR="$CDATA" OPENCREW_CLOUD_PUBLIC_URL=http://127.0.0.1:4201 \
  node dist/index.js > /tmp/j-cloud.log 2>&1 &
for i in $(seq 1 40); do curl -sf http://127.0.0.1:4201/ >/dev/null 2>&1 && break; sleep 1; done
C=http://127.0.0.1:4201; CJ=$(mktemp)
chk "cloud console served" "$(code $C/)" "200"
curl -s -c $CJ -X POST $C/api/v1/auth/signup -H 'content-type: application/json' -H "origin: $C" \
  -d '{"email":"igor@opencrew.test","password":"correct-horse-battery-staple","displayName":"Igor","organization":{"name":"Acme","slug":"acme"}}' | grep -q '"user"' \
  && ok "cloud signup" || no "cloud signup" "failed"
curl -s -b $CJ $C/api/v1/auth/session | grep -q '"user"' && ok "cloud session" || no "cloud session" "unauthorized"
OID=$(curl -s -b $CJ $C/api/v1/organizations | python -c "import sys,json;print(json.load(sys.stdin)['organizations'][0]['id'])" 2>/dev/null)
[ -n "$OID" ] && ok "organization created" || no "organization" "none"
chk "CSRF: foreign origin rejected" \
  "$(code -b $CJ -X POST $C/api/v1/organizations/$OID/deployments -H 'content-type: application/json' -H 'origin: http://evil.example' -d '{"name":"evil","region":"x","plan":"starter"}')" "403"
chk "customer self-serve provisioning" \
  "$(code -b $CJ -X POST $C/api/v1/organizations/$OID/deployments -H 'content-type: application/json' -H "origin: $C" -d '{"name":"acme","region":"eu","plan":"starter"}')" "201"
OT='authorization: Bearer test-admin-token-aaaaaaaaaaaaaaaaaaaaaaaa'
curl -s -X POST $C/api/v1/organizations/$OID/deployments -H 'content-type: application/json' -H "$OT" -H "origin: $C" \
  -d '{"name":"acme-prod","region":"eu-central","plan":"starter"}' | grep -q '"operation"' \
  && ok "operator provisioning queues an operation" || no "operator provisioning" "failed"

sec "RESULTS"
printf "  passed: %s   failed: %s\n\n" "$PASS" "$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
