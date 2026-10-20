# ANGRY MOD — New Panel & Auth Server

Original server built 2026-10-20 to replace the lost angrymod.com panel
(CodeIgniter) for the ANGRY MOD v3.0 APK (`com.angry.mod`). Zero npm
dependencies: `node:http` + `node:sqlite` (Node >= 22.5).

## Protocol (recovered from libUtility.so `nativeLogin`)

The APK POSTs form fields to its Auth URL. From disassembly, the body is
built from these fragments: `secret=…`, `&game=fuckfire`, `&user_key=…`,
`&serial=…`. This server requires only `user_key` + `serial` and ignores
the rest.

- `POST /connect`
  - success → `{"status": true, "data": {"user_key": "...", "expired_date": "YYYY-MM-DD HH:MM:SS", "registrator": "Admin", "seller_name": "ANGRY MOD"}}`
    (the app shows "Login Success" + "Expired : <expired_date>")
  - failure → `{"status": false, "reason": "..."}` (app displays `reason`)
  - blocked → same + `"crash": true` (app's crash path)
  - First successful login binds `serial` to the key. A different serial
    is rejected until an admin unbinds it in the dashboard.
- `GET /connect` → `{"web_info": {"_client": "ANGRY MOD", "license": ..., "version": "1.0.0"}, "web__dev": {...}}`
- `GET /update.php?version_code=N` → JSON with latest version info.
  NOTE: exact response format the APK's update checker expects could not
  be fully confirmed from static analysis (the old server 404s it too).
- `GET /apkhash.php` → plain-text MD5 of the official APK (set in dashboard).

## Admin panel

- `/login` → username/password (env `ADMIN_USER`, default `admin`;
  env `ADMIN_PASS` — if unset, a random password is generated and printed
  to the server console on first start. SAVE IT.)
- `/dashboard` — create keys (custom or auto `ANGRY-XXXX-XXXX-XXXX`, expiry
  in days, seller name, registrator), ban / unban / crash / unbind serial /
  delete, settings (latest version, update URL/message, official APK MD5,
  crash-all switch), and the last 50 login attempts.

## Run locally

```bash
ADMIN_USER=admin ADMIN_PASS='choose-a-strong-one' PORT=8080 node server.js
```

Data lives in `data/panel.db` (override with `DATA_DIR`).

## Deploy (Render)

Docker runtime via the included `Dockerfile` / `render.yaml`
(Node 22 image; `node:sqlite` needs >= 22.5). Set `ADMIN_USER` and
`ADMIN_PASS` env vars on the service. Note: free-tier disk is ephemeral —
keys/logs reset on redeploy unless a persistent disk / external DB is used.

## Pointing the APK at this panel (URL patch)

The APK's three server URLs are XOR-encrypted inside
`lib/arm64-v8a/libUtility.so` with fixed-size slots:

| Slot | Max length | Endpoint |
| --- | --- | --- |
| Auth_URL | 28 chars | `<base>/connect` |
| updateUrl | 32 chars | `<base>/update.php` |
| apkHashUrl | 32 chars | `<base>/apkhash.php` |

So the base origin must be <= 20 chars, e.g. `https://angrymod.com`
(host <= 12 chars over https). A `*.onrender.com` URL does NOT fit —
deploy behind a short custom domain.

```bash
# 1) patch + rebuild + sign (test pipeline, verified 2026-10-20)
tools/test_patch.sh https://your-short-domain.example
#    - extracts libUtility.so, re-encodes the 3 URLs (tools/patch_urls.py)
#    - replaces the lib (kept STORED/uncompressed), zipaligns, signs
#    - verifies the decoded URLs inside the final APK

# 2) after signing, the APK file hash changes:
#    put the NEW APK's MD5 into the dashboard setting "Official APK MD5".
```

Signing uses a fresh keystore in the test script, so users must reinstall
the patched APK (it cannot update-install over the original signature).
If the original ArmLite keystore is available, sign with that instead.
