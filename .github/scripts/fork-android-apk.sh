#!/usr/bin/env bash
# Builds the Android app of a fork release (fork-android-apk.yml) as one
# installable APK: the production app under its own package id, so it installs
# beside the Play Store app, with Expo's over-the-air updates off, so the
# official channel never replaces this build's code.
#
#   fork-android-apk.sh build VERSION OUT_DIR   Gradle's APK, OUT_DIR/unsigned.apk
#   fork-android-apk.sh sign VERSION OUT_DIR    OUT_DIR/T3-Code-VERSION.apk
#
# Two steps, because the build runs dependency code and must not see the key.
# sign reads ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD and
# ANDROID_KEY_ALIAS, the key every release is signed with, so a phone installs
# a new APK over the old one. Without them a key is made for this build only,
# and a phone must uninstall the previous APK first.
#
# Needs: the workspace install, JDK 17, and ANDROID_HOME with build-tools.
set -euo pipefail

usage="usage: fork-android-apk.sh build|sign VERSION OUT_DIR"
mode=${1:?$usage}
version=${2:?$usage}
out=${3:?$usage}
root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$out"
out=$(cd "$out" && pwd)
name="T3-Code-$version.apk"
package=${T3CODE_FORK_ANDROID_PACKAGE:-com.t3tools.t3code.fork}
abis=${T3CODE_FORK_ANDROID_ABIS:-arm64-v8a}

if [ "$mode" = sign ]; then
  [ -f "$out/unsigned.apk" ] || { echo "fork-android-apk: run build first, no $out/unsigned.apk" >&2; exit 1; }
  build_tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 | sort -V | tail -n 1)
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
    printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$work/release.jks"
    : "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD is needed with ANDROID_KEYSTORE_BASE64}"
    alias=${ANDROID_KEY_ALIAS:-t3code}
    key=stable
  else
    ANDROID_KEYSTORE_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
    alias=t3code
    KS_PASS=$ANDROID_KEYSTORE_PASSWORD keytool -genkeypair -noprompt -keystore "$work/release.jks" \
      -storetype PKCS12 -storepass:env KS_PASS -alias "$alias" -keyalg RSA -keysize 4096 \
      -validity 36500 -dname "CN=T3 Code fork build"
    key=one-off
    echo "::warning::No ANDROID_KEYSTORE_BASE64 secret: this APK is signed with a key made for this build, so a phone must uninstall the previous APK before installing it."
  fi
  # Gradle signed the release with the debug key; apksigner replaces that signature.
  KS_PASS=$ANDROID_KEYSTORE_PASSWORD "$build_tools/apksigner" sign \
    --ks "$work/release.jks" --ks-pass env:KS_PASS --ks-key-alias "$alias" \
    --out "$out/$name" "$out/unsigned.apk"
  "$build_tools/apksigner" verify --print-certs "$out/$name" | head -n 3
  rm -f "$out/$name.idsig" "$out/unsigned.apk"
  echo "fork-android-apk: $out/$name ($key key)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    { echo "apk=$out/$name"; echo "name=$name"; echo "key=$key"; } >> "$GITHUB_OUTPUT"
  fi
  exit 0
fi
[ "$mode" = build ] || { echo "$usage" >&2; exit 1; }

code=$(node -e 'console.log(require(process.argv[1]).androidVersionCode(process.argv[2]))' \
  "$root/.github/scripts/fork-release-version.cjs" "$version")

export APP_VARIANT=production
export T3CODE_MOBILE_UPDATES_ENABLED=0
export EXPO_NO_GIT_STATUS=1
export EXPO_NO_TELEMETRY=1
export CI=1

cd "$root/apps/mobile"
"$root/apps/mobile/node_modules/.bin/expo" prebuild --clean --platform android --no-install

# Prebuild writes the package from app.config.ts and versionCode 1. Only the
# installed id changes: the Kotlin namespace stays, so no source moves.
gradle_file=android/app/build.gradle
sed -i -E \
  -e "s/^( *applicationId ).*/\1'$package'/" \
  -e "s/^( *versionCode ).*/\1$code/" \
  "$gradle_file"
grep -q "applicationId '$package'" "$gradle_file" || { echo "fork-android-apk: applicationId not set in $gradle_file" >&2; exit 1; }
grep -qE "^ *versionCode $code$" "$gradle_file" || { echo "fork-android-apk: versionCode not set in $gradle_file" >&2; exit 1; }

(cd android && ./gradlew --no-daemon app:assembleRelease \
  -PreactNativeArchitectures="$abis" -x lintVitalAnalyzeRelease -x lintVitalRelease)

apk=android/app/build/outputs/apk/release/app-release.apk
[ -f "$apk" ] || { echo "fork-android-apk: Gradle made no $apk" >&2; exit 1; }

cp "$apk" "$out/unsigned.apk"
echo "fork-android-apk: $out/unsigned.apk (versionCode $code, $package, $abis)"
