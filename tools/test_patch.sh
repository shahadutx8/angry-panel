#!/bin/bash
# Test: patch libUtility.so URLs -> rebuild APK -> zipalign -> sign -> verify
set -e
export PATH="$HOME/workspace/.tmp-jdk/jdk-17.0.20.1+1/bin:$PATH"
BT="$HOME/android-sdk/build-tools/34.0.0"
WORK=/tmp/apk_patch_test
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

BASE="${1:-https://amod.top}"
echo "== extract lib =="
unzip -o -q "$HOME/workspace/user/files/ANGRY_MOD_V3_sign_0_3fdp.apk" "lib/arm64-v8a/libUtility.so"
cp lib/arm64-v8a/libUtility.so /tmp/libUtility.orig.so

echo "== patch urls to $BASE =="
python3 "$HOME/workspace/angry-panel/tools/patch_urls.py" lib/arm64-v8a/libUtility.so "$BASE"

echo "== rebuild apk (replace lib, drop old signature) =="
cp "$HOME/workspace/user/files/ANGRY_MOD_V3_sign_0_3fdp.apk" app_patched.apk
zip -q -d app_patched.apk "META-INF/*"
# native libs MUST stay STORED (uncompressed) or Android refuses to load them
zip -q -0 app_patched.apk lib/arm64-v8a/libUtility.so

echo "== zipalign + sign with fresh ArmLite key =="
"$BT/zipalign" -f -p 4 app_patched.apk app_aligned.apk
if [ ! -f /tmp/angry-test.keystore ]; then
  keytool -genkeypair -keystore /tmp/angry-test.keystore -storepass angrytest -keypass angrytest \
    -alias angrylite -keyalg RSA -keysize 2048 -validity 3650 \
    -dname "CN=Md Shahadut Hossain, OU=ArmLite, O=ArmLite, L=Dhaka, ST=Dhaka, C=BD" 2>/dev/null
fi
"$BT/apksigner" sign --ks /tmp/angry-test.keystore --ks-pass pass:angrytest --key-pass pass:angrytest \
  --out ANGRY_MOD_V3_patched.apk app_aligned.apk
"$BT/apksigner" verify --print-certs ANGRY_MOD_V3_patched.apk | head -n 3

echo "== verify patched lib inside final apk =="
unzip -o -q ANGRY_MOD_V3_patched.apk "lib/arm64-v8a/libUtility.so" -d verify_dir
python3 - << PYEOF
import sys
sys.path.insert(0, "$HOME/workspace/angry-panel/tools")
from patch_urls import dec_auth, dec16, AUTH_OFF, UPD_OFF, HASH_OFF, UPD_KEY, HASH_KEY
d = open("verify_dir/lib/arm64-v8a/libUtility.so","rb").read()
print("auth :", dec_auth(d[AUTH_OFF:AUTH_OFF+29]))
print("upd  :", dec16(d[UPD_OFF:UPD_OFF+32], UPD_KEY))
print("hash :", dec16(d[HASH_OFF:HASH_OFF+32], HASH_KEY))
PYEOF
md5sum ANGRY_MOD_V3_patched.apk
ls -lh ANGRY_MOD_V3_patched.apk
echo "PATCH PIPELINE OK"
