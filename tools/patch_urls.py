#!/usr/bin/env python3
"""
Patch the 3 encrypted server URLs inside ANGRY MOD v3.0's libUtility.so.

Recovered from disassembly (2026-10-20):
  Auth_URL   template at .rodata 0x1CE780, 29 bytes:
             bytes 0..23  XOR key8  d771330bb5e523cf (repeating)
             byte  24     XOR 0xD7
             byte  25     XOR 0x71
             byte  26     XOR 0x33
             byte  27     XOR 0x0B
             byte  28     XOR 0xB5   (this is the NUL terminator position
                                      for a 28-char URL)
             => content max 28 chars
  updateUrl  template at .rodata 0x1CE740, 32 bytes XOR key16
             2fa7a72ba383d161 2fa7a72ba383d161 ; code writes NUL at byte 32
             => content max 32 chars
  apkHashUrl template at .rodata 0x1CE666, 32 bytes XOR key16
             c13db3ff5d7f1de1 c13db3ff5d7f1de1 ; byte 32 handled by code
             => content max 32 chars

Usage:
  python3 patch_urls.py <extracted libUtility.so> <base_url>
  e.g. python3 patch_urls.py libUtility.so https://angrymod.com

The base_url is the panel origin with NO trailing slash.
Auth  = base + "/connect"     (must be <= 28 chars)
Update= base + "/update.php"  (must be <= 32 chars)
Hash  = base + "/apkhash.php" (must be <= 32 chars)
Shorter URLs are fine: the remaining template bytes encode NUL padding,
so strlen() in the native code stops at the right place.
"""
import sys

AUTH_OFF, AUTH_KEY = 0x1CE780, bytes.fromhex('d771330bb5e523cf')
AUTH_TAIL = [0xD7, 0x71, 0x33, 0x0B, 0xB5]
UPD_OFF, UPD_KEY = 0x1CE740, bytes.fromhex('2fa7a72ba383d1612fa7a72ba383d161')
HASH_OFF, HASH_KEY = 0x1CE666, bytes.fromhex('c13db3ff5d7f1de1c13db3ff5d7f1de1')


def enc_auth(url: str) -> bytes:
    p = url.encode()
    assert len(p) <= 28, f'Auth URL too long: {len(p)} > 28 ({url})'
    p = p + b'\x00' * (29 - len(p))
    out = bytearray(29)
    for i in range(24):
        out[i] = p[i] ^ AUTH_KEY[i % 8]
    for j, c in enumerate(AUTH_TAIL):
        out[24 + j] = p[24 + j] ^ c
    return bytes(out)


def enc16(url: str, key: bytes) -> bytes:
    p = url.encode()
    assert len(p) <= 32, f'URL too long: {len(p)} > 32 ({url})'
    p = p + b'\x00' * (32 - len(p))
    return bytes(p[i] ^ key[i % 16] for i in range(32))


def dec_auth(enc: bytes) -> str:
    out = bytearray(29)
    for i in range(24):
        out[i] = enc[i] ^ AUTH_KEY[i % 8]
    for j, c in enumerate(AUTH_TAIL):
        out[24 + j] = enc[24 + j] ^ c
    return out.split(b'\x00')[0].decode()


def dec16(enc: bytes, key: bytes) -> str:
    out = bytes(enc[i] ^ key[i % 16] for i in range(32))
    return out.split(b'\x00')[0].decode()


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    path, base = sys.argv[1], sys.argv[2].rstrip('/')
    auth, upd, h = base + '/connect', base + '/update.php', base + '/apkhash.php'
    data = bytearray(open(path, 'rb').read())
    print('OLD auth :', dec_auth(bytes(data[AUTH_OFF:AUTH_OFF + 29])))
    print('OLD upd  :', dec16(bytes(data[UPD_OFF:UPD_OFF + 32]), UPD_KEY))
    print('OLD hash :', dec16(bytes(data[HASH_OFF:HASH_OFF + 32]), HASH_KEY))
    data[AUTH_OFF:AUTH_OFF + 29] = enc_auth(auth)
    data[UPD_OFF:UPD_OFF + 32] = enc16(upd, UPD_KEY)
    data[HASH_OFF:HASH_OFF + 32] = enc16(h, HASH_KEY)
    # verify round-trip from the patched bytes
    assert dec_auth(bytes(data[AUTH_OFF:AUTH_OFF + 29])) == auth
    assert dec16(bytes(data[UPD_OFF:UPD_OFF + 32]), UPD_KEY) == upd
    assert dec16(bytes(data[HASH_OFF:HASH_OFF + 32]), HASH_KEY) == h
    open(path, 'wb').write(bytes(data))
    print('NEW auth :', auth)
    print('NEW upd  :', upd)
    print('NEW hash :', h)
    print('Patched OK ->', path)


if __name__ == '__main__':
    main()
