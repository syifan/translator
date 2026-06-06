#!/usr/bin/env bash
#
# One-time setup: create a stable, self-signed code-signing identity in your
# login keychain so packaged builds keep the SAME signature across rebuilds.
#
# Why: macOS ties a TCC permission grant (Screen & System Audio Recording) to the
# app's code signature. Ad-hoc builds get a new signature every time, so the grant
# resets and you're re-prompted on every rebuild. A reused self-signed cert keeps
# the signature stable, so the grant sticks.
#
# This may prompt for your login/keychain password (and Touch ID) — that's normal.
#
# Usage:  npm run sign:setup      (then:  npm run package:signed)
set -euo pipefail

IDENTITY="Live Translator Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ Code-signing identity \"$IDENTITY\" already exists — nothing to do."
  echo "  Build with:  npm run package:signed"
  exit 0
fi

echo "Creating self-signed code-signing certificate \"$IDENTITY\"…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# OpenSSL config (config-file form works on both LibreSSL and OpenSSL).
cat > "$TMP/req.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions    = v3_codesign
prompt             = no
[ dn ]
CN = $IDENTITY
[ v3_codesign ]
basicConstraints   = critical,CA:FALSE
keyUsage           = critical,digitalSignature
extendedKeyUsage   = critical,codeSigning
EOF

# 1) Self-signed cert + key with the codeSigning extended key usage.
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -config "$TMP/req.cnf" -extensions v3_codesign

# 2) Bundle into a password-less PKCS#12.
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$IDENTITY" -out "$TMP/identity.p12" -passout pass:

# 3) Import the key+cert into the login keychain, pre-authorizing codesign.
security import "$TMP/identity.p12" -k "$KEYCHAIN" -P "" -T /usr/bin/codesign

# 4) Trust it for code signing so electron-builder/codesign accept it.
#    (User-domain trust; will prompt for your password.)
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

echo
if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  echo "✓ Identity \"$IDENTITY\" is ready."
  echo "  Now build with:  npm run package:signed"
  echo "  On the FIRST signed build, if macOS asks to let codesign use the key,"
  echo "  click \"Always Allow\". After that, builds are silent and your"
  echo "  Screen & System Audio Recording grant persists across rebuilds."
else
  echo "⚠︎ Could not confirm the identity. You can also create it via Keychain"
  echo "  Access → Certificate Assistant → Create a Certificate → Code Signing."
  exit 1
fi
