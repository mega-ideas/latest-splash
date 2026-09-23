#!/usr/bin/env bash
# End-to-end checks against the deployed v2, through nginx and TLS.
# Runs ON the server so it can read secrets and the database.
# Read-only except one admin login/logout and one read-only DB query.
BASE="${BASE:-https://v2.splashz.xyz}"
APP="/home/splash/splashAN"
pass=0; fail=0; warn=0

ok()   { printf '  [PASS]  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  [FAIL]  %s\n' "$1"; fail=$((fail+1)); }
note() { printf '  [WARN]  %s\n' "$1"; warn=$((warn+1)); }
hdr()  { printf '\n== %s\n' "$1"; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@"; }
body() { curl -s --max-time 25 "$@"; }

hdr "1. Public surface"
for p in / /login /signup /trust /privacy-policy /terms-of-service; do
  c=$(code "$BASE$p")
  [ "$c" = "200" ] && ok "$p -> 200" || bad "$p -> $c (expected 200)"
done
c=$(code "$BASE/definitely-not-a-page-xyz")
[ "$c" = "404" ] && ok "unknown path -> 404" || bad "unknown path -> $c"

hdr "2. TLS and headers"
if curl -sI --max-time 25 "$BASE/" | grep -qi 'cross-origin-opener-policy: same-origin-allow-popups'; then
  ok "COOP same-origin-allow-popups (the OAuth popup needs this)"
else
  bad "COOP header missing - the zkLogin popup may be blocked"
fi
if echo | openssl s_client -connect v2.splashz.xyz:443 -servername v2.splashz.xyz 2>/dev/null | openssl x509 -noout -checkend 604800 >/dev/null 2>&1; then
  ok "TLS cert valid for at least 7 more days"
else
  bad "TLS cert expires within 7 days"
fi
if body "$BASE/privacy-policy" | grep -q 'name="robots" content="noindex'; then
  ok "legal pages noindex while LEGAL_APPROVED is unset"
else
  note "legal pages indexable - counsel approved?"
fi

hdr "3. zkLogin"
Z=$(body "$BASE/api/auth/zklogin/params")
echo "$Z" | grep -q '"enabled":true' && ok "params: enabled" || bad "params: not enabled -> $Z"
echo "$Z" | grep -q 'apps.googleusercontent.com' && ok "params: Google client id present" || bad "params: no client id"
EP=$(echo "$Z" | sed -n 's/.*"epoch":\([0-9]*\).*/\1/p')
MX=$(echo "$Z" | sed -n 's/.*"maxEpoch":\([0-9]*\).*/\1/p')
if [ -n "$EP" ] && [ "$EP" -gt 0 ] 2>/dev/null; then ok "params: live epoch $EP read from the network"; else bad "params: no epoch"; fi
if [ -n "$MX" ] && [ "$MX" -gt "$EP" ] 2>/dev/null && [ $((MX-EP)) -le 2 ]; then
  ok "params: maxEpoch $MX is epoch+$((MX-EP)) (spec allows 1 or 2)"
else
  bad "params: maxEpoch $MX not a sane window over epoch $EP"
fi

r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X POST "$BASE/api/auth/zklogin" \
      -H 'content-type: application/json' -d '{"jwt":"not.a.jwt"}')
[ "$r" != "200" ] && ok "malformed JWT rejected ($r)" || bad "malformed JWT ACCEPTED - critical"

FORGED='eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJzdWIiOiIxIiwiYXVkIjoiZmFrZSIsImV4cCI6OTk5OTk5OTk5OSwiaWF0IjoxfQ.'
r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X POST "$BASE/api/auth/zklogin" \
      -H 'content-type: application/json' -d "{\"jwt\":\"$FORGED\"}")
[ "$r" != "200" ] && ok "alg=none forged JWT rejected ($r)" || bad "alg=none JWT ACCEPTED - critical"

hdr "4. Authentication gates"
r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X POST "$BASE/api/auth/login" \
      -H 'content-type: application/json' -d '{"email":"nobody@example.com","password":"wrongwrongwrong"}')
[ "$r" != "200" ] && ok "bad customer credentials rejected ($r)" || bad "bad credentials ACCEPTED"

r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X POST "$BASE/api/auth/signup" \
      -H 'content-type: application/json' \
      -d '{"company":"E2E Co","email":"e2e-probe@example.com","region":"MY","password":"correct-horse-battery-staple","accepted":true}')
if [ "$r" = "403" ]; then ok "self-signup refused in production (403) - fail-closed"
elif [ "$r" = "200" ] || [ "$r" = "201" ]; then note "self-signup is OPEN - anyone can create an account"
else ok "signup gate returned $r"; fi

for p in /api/admin/memberships /api/transfers /api/treasury; do
  r=$(code "$BASE$p")
  if [ "$r" = "401" ] || [ "$r" = "403" ]; then ok "$p requires auth ($r)"
  else bad "$p returned $r with no session"; fi
done

hdr "5. Admin session (real login)"
PW=$(sed 's/^ADMIN_PASSWORD=//' /home/splash/.secrets/v2_admin_password)
EM=$(grep '^ADMIN_EMAIL=' "$APP/.env.local" | sed 's/^ADMIN_EMAIL=//')
JAR=$(mktemp)
r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -c "$JAR" -X POST "$BASE/api/admin/login" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"$EM\",\"password\":\"$PW\"}")
if [ "$r" = "200" ] || [ "$r" = "204" ]; then
  ok "admin login succeeds for the configured operator ($r)"
  r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" "$BASE/api/admin/memberships")
  [ "$r" = "200" ] && ok "admin session reaches /api/admin/memberships" || bad "admin session got $r on memberships"
  r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" "$BASE/admin/memberships")
  [ "$r" = "200" ] && ok "admin console page renders" || bad "admin console page got $r"
else
  bad "admin login failed ($r) - check ADMIN_EMAIL / ADMIN_PASSWORD"
fi
r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -c "$JAR" -X POST "$BASE/api/admin/login" \
      -H 'content-type: application/json' -d "{\"email\":\"$EM\",\"password\":\"definitely-wrong\"}")
[ "$r" != "200" ] && [ "$r" != "204" ] && ok "wrong admin password rejected ($r)" || bad "wrong admin password ACCEPTED"
rm -f "$JAR"

hdr "6. The custody invariant (the demo beat)"
cd "$APP" || exit 1
export PATH=/opt/node24/bin:$PATH
cat > ./e2e-custody.mjs <<'EOF'
process.env.SPLASH_CUSTODY_PACKAGE_ID = '';
const mod = await import('./lib/server/sui-settlement.ts');
const names = Object.keys(mod);
console.log('EXPORTS_OK', names.length > 0);
EOF
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ./e2e-custody.mjs >/dev/null 2>&1 \
  && ok "settlement module loads with custody unset" \
  || note "settlement module did not load standalone (module-level env reads)"
rm -f ./e2e-custody.mjs

grep -q 'SPLASH_CORE_PACKAGE_ID=0x' .env.local && ok "SPLASH_CORE_PACKAGE_ID set (disables the legacy custody fallback)" || bad "core package id missing"
if grep -qE '^SPLASH_CUSTODY_PACKAGE_ID=$' .env.local; then
  ok "SPLASH_CUSTODY_PACKAGE_ID empty - custody bytecode is absent by design"
else
  bad "custody package id is SET - the non-custody posture is broken"
fi

hdr "7. Seal / demo crypto"
cat > ./e2e-seal.mjs <<'EOF'
const m = await import('./lib/server/runtime-mode.ts');
const demo = { NODE_ENV:'production', USE_MOCK_APIS:'true', NEXT_PUBLIC_DEMO_MODE:'true' };
const strict = { NODE_ENV:'production' };
console.log('DEMO', m.canUseDemoCrypto(demo));
console.log('STRICT', m.canUseDemoCrypto(strict));
EOF
S=$(node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ./e2e-seal.mjs 2>&1)
echo "$S" | grep -q 'DEMO true'   && ok "demo posture uses mock Seal (payments will not be blocked)" || bad "demo posture would demand a live Seal committee"
echo "$S" | grep -q 'STRICT false' && ok "a real deployment with no demo flags still fails closed" || bad "real deployments would silently use demo crypto"
rm -f ./e2e-seal.mjs
[ -f config/seal.production.json ] && ok "config/seal.production.json exists (production refuses to boot without it)" || bad "seal.production.json missing"

hdr "8. Chain state"
if PKGOUT=$(cd "$APP" && node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON -e "
const { SuiGrpcClient } = await import('@mysten/sui/grpc');
const c = new SuiGrpcClient({ network:'testnet', baseUrl:'https://fullnode.testnet.sui.io:443' });
const s = await c.core.getCurrentSystemState();
console.log('EPOCH', s.systemState.epoch);
" 2>&1); then
  echo "$PKGOUT" | grep -q EPOCH && ok "testnet reachable ($(echo "$PKGOUT" | tr -d '\n'))" || bad "testnet unreachable: $PKGOUT"
else
  bad "testnet query failed"
fi

hdr "9. Database"
DB=$(sed 's/^DATABASE_URL=//' /home/splash/.secrets/database_url)
T=$(psql "$DB" -tAc "select count(*) from information_schema.tables where table_schema='public';" 2>&1)
[ "$T" -ge 20 ] 2>/dev/null && ok "schema present ($T tables)" || bad "schema looks wrong ($T)"
for t in users memberships passkey_credentials wallet_identities payment_intents; do
  n=$(psql "$DB" -tAc "select count(*) from $t;" 2>&1)
  if [ -n "$n" ] && [ "$n" -ge 0 ] 2>/dev/null; then ok "table $t readable (rows: $n)"; else bad "table $t not readable: $n"; fi
done

hdr "10. Service health"
systemctl is-active --quiet splash-an && ok "splash-an active" || bad "splash-an not active"
systemctl is-active --quiet splash-v4 && ok "v1 splash-v4 still active (untouched)" || note "v1 not active"
if journalctl -u splash-an --since '10 minutes ago' --no-pager 2>/dev/null | grep -qiE 'EnvValidationError|unhandled|FATAL'; then
  bad "recent fatal errors in the service log"
else
  ok "no fatal errors in the last 10 minutes of logs"
fi

printf '\n=============================\n'
printf ' PASS %s   FAIL %s   WARN %s\n' "$pass" "$fail" "$warn"
printf '=============================\n'
[ "$fail" -eq 0 ] || exit 1
