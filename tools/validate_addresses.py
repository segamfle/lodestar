"""Verify every payout address before it goes into a submission form.

A single transposed character in a payout address sends money to a hole in the
ground with no undo. Most address families carry their own checksum; this script
actually verifies them instead of eyeballing string length.

Dependency-free on purpose. Keccak-256 is implemented inline because Python's
hashlib.sha3_256 is NIST SHA-3, which pads differently than the original Keccak
that Ethereum EIP-55 checksums are built on. Using the wrong one silently passes
bad addresses, which is worse than not checking at all.

    python tools/validate_addresses.py
"""

import hashlib
import json
import os
import sys

# ---------------------------------------------------------------- keccak-256

ROUND_CONSTANTS = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]

ROTATION_OFFSETS = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]

MASK64 = (1 << 64) - 1


def rotate_left_64(value, shift):
    shift %= 64
    if shift == 0:
        return value & MASK64
    return ((value << shift) | (value >> (64 - shift))) & MASK64


def keccak_f1600(state):
    for round_index in range(24):
        column_parity = [
            state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4]
            for x in range(5)
        ]
        theta_delta = [
            column_parity[(x - 1) % 5] ^ rotate_left_64(column_parity[(x + 1) % 5], 1)
            for x in range(5)
        ]
        for x in range(5):
            for y in range(5):
                state[x][y] ^= theta_delta[x]

        rotated = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                rotated[y][(2 * x + 3 * y) % 5] = rotate_left_64(
                    state[x][y], ROTATION_OFFSETS[x][y]
                )

        for x in range(5):
            for y in range(5):
                state[x][y] = rotated[x][y] ^ (
                    (~rotated[(x + 1) % 5][y]) & rotated[(x + 2) % 5][y]
                )

        state[0][0] ^= ROUND_CONSTANTS[round_index]
    return state


def keccak256(message):
    """Original Keccak-256, padding byte 0x01. This is Ethereum's hash."""
    rate_bytes = 136
    padded = bytearray(message)
    padded.append(0x01)
    while len(padded) % rate_bytes != 0:
        padded.append(0x00)
    padded[-1] ^= 0x80

    state = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate_bytes):
        block = padded[offset:offset + rate_bytes]
        for lane_index in range(rate_bytes // 8):
            lane = int.from_bytes(block[lane_index * 8:lane_index * 8 + 8], "little")
            state[lane_index % 5][lane_index // 5] ^= lane
        keccak_f1600(state)

    digest = bytearray()
    for lane_index in range(4):
        digest += state[lane_index % 5][lane_index // 5].to_bytes(8, "little")
    return bytes(digest)


# ---------------------------------------------------------------- base58

BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_decode(text):
    number = 0
    for character in text:
        index = BASE58_ALPHABET.find(character)
        if index == -1:
            raise ValueError("character %r is not in the base58 alphabet" % character)
        number = number * 58 + index

    decoded = number.to_bytes((number.bit_length() + 7) // 8, "big")
    leading_zeros = len(text) - len(text.lstrip("1"))
    return b"\x00" * leading_zeros + decoded


# ---------------------------------------------------------------- bech32

BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def bech32_polymod(values):
    generators = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    checksum = 1
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value
        for bit in range(5):
            if (top >> bit) & 1:
                checksum ^= generators[bit]
    return checksum


def verify_bech32(address):
    if address.lower() != address and address.upper() != address:
        return False, "mixed case is not allowed in bech32"
    address = address.lower()
    separator = address.rfind("1")
    if separator < 1 or separator + 7 > len(address):
        return False, "malformed human-readable part"

    human_readable = address[:separator]
    try:
        data = [BECH32_CHARSET.index(c) for c in address[separator + 1:]]
    except ValueError as error:
        return False, "invalid bech32 character (%s)" % error

    expanded = (
        [ord(c) >> 5 for c in human_readable]
        + [0]
        + [ord(c) & 31 for c in human_readable]
    )
    checksum = bech32_polymod(expanded + data)

    witness_version = data[0]
    # Segwit v0 uses bech32, v1 and up use bech32m with a different constant.
    expected = 1 if witness_version == 0 else 0x2BC830A3
    if checksum != expected:
        return False, "checksum FAILED - the address is mistyped"
    encoding = "bech32" if witness_version == 0 else "bech32m"
    return True, "%s verified, witness v%d, hrp=%s" % (
        encoding, witness_version, human_readable
    )


# ---------------------------------------------------------------- cashaddr

CASHADDR_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def verify_cashaddr(address, prefix="bitcoincash"):
    if ":" in address:
        prefix, address = address.split(":", 1)
    if not address or any(c not in CASHADDR_CHARSET for c in address.lower()):
        return False, "contains characters outside the cashaddr charset"

    # Unlike bech32, cashaddr expands its prefix with the low five bits only.
    expanded = [ord(c) & 0x1F for c in prefix] + [0]
    data = [CASHADDR_CHARSET.index(c) for c in address.lower()]

    generators = [0x98F2BC8E61, 0x79B76D99E2, 0xF33E5FB3C4, 0xAE2EABE2A8, 0x1E4F43E470]
    checksum = 1
    for value in expanded + data:
        top = checksum >> 35
        checksum = ((checksum & 0x07FFFFFFFF) << 5) ^ value
        for bit in range(5):
            if (top >> bit) & 1:
                checksum ^= generators[bit]

    if (checksum ^ 1) != 0:
        return False, "checksum FAILED - the address is mistyped"
    return True, "cashaddr checksum verified against prefix '%s'" % prefix


# ---------------------------------------------------------------- validators


def verify_evm(address):
    if not address.startswith("0x") or len(address) != 42:
        return False, "must be 0x followed by 40 hex characters"
    body = address[2:]
    try:
        int(body, 16)
    except ValueError:
        return False, "contains non-hex characters"

    if body == body.lower() or body == body.upper():
        return True, "valid hex, but not EIP-55 checksummed so typos are undetectable"

    digest = keccak256(body.lower().encode()).hex()
    expected = "".join(
        character.upper() if int(digest[i], 16) >= 8 else character
        for i, character in enumerate(body.lower())
    )
    if expected != body:
        return False, "EIP-55 checksum FAILED - the address is mistyped"
    return True, "EIP-55 checksum verified"


def verify_base58check(address, allowed_versions, label):
    try:
        raw = base58_decode(address)
    except ValueError as error:
        return False, str(error)
    if len(raw) != 25:
        return False, "decodes to %d bytes, expected 25" % len(raw)

    payload, checksum = raw[:21], raw[21:]
    if hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] != checksum:
        return False, "base58check checksum FAILED - the address is mistyped"
    version = payload[0]
    if version not in allowed_versions:
        return False, "version byte 0x%02X is not a %s address" % (version, label)
    return True, "base58check verified, version byte 0x%02X" % version


def verify_solana(address):
    try:
        raw = base58_decode(address)
    except ValueError as error:
        return False, str(error)
    if len(raw) != 32:
        return False, "decodes to %d bytes, a Solana pubkey must be exactly 32" % len(raw)
    # A Solana address is a bare ed25519 public key. It carries no checksum, so
    # length plus a strict alphabet is everything that can be checked offline.
    return True, "32-byte ed25519 pubkey, well-formed (no checksum exists to verify)"


# Addresses live in config/payout-addresses.json, which is deliberately gitignored. A public
# repository would tie every one of them to the owner's GitHub identity permanently, and a
# payout address published alongside a name makes its whole balance and history readable by
# anyone who looks. Copy payout-addresses.example.json and fill it in.
CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "config",
    "payout-addresses.json",
)

VERIFIERS = {
    "btc": ("BTC", verify_bech32),
    "ltc": ("LTC", lambda a: verify_base58check(a, {0x30, 0x32}, "Litecoin")),
    "doge": ("DOGE", lambda a: verify_base58check(a, {0x1E}, "Dogecoin")),
    "bch": ("BCH", verify_cashaddr),
    "sol": ("SOL", verify_solana),
    "tron": ("TRON", lambda a: verify_base58check(a, {0x41}, "TRON")),
    "evm": ("EVM", verify_evm),
}


def load_wallet():
    if not os.path.exists(CONFIG_PATH):
        print("No %s found." % CONFIG_PATH)
        print("Copy config/payout-addresses.example.json to it and fill in your addresses.")
        raise SystemExit(2)
    with open(CONFIG_PATH, encoding="utf-8") as handle:
        config = json.load(handle)

    wallet = []
    for key, (label, verifier) in VERIFIERS.items():
        address = config.get(key)
        if address:
            wallet.append((label, address, verifier))
    return wallet


def self_test():
    """Nothing below this line is trustworthy if the primitives are wrong."""
    empty = keccak256(b"").hex()
    assert empty == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", empty
    abc = keccak256(b"abc").hex()
    assert abc == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", abc

    assert base58_decode("1") == b"\x00"
    assert base58_decode("z") == b"\x39"

    # A known-good checksummed address, and the same address with two characters
    # swapped, which must be rejected.
    known_good = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
    assert verify_evm(known_good)[0], "EIP-55 verifier rejects a valid address"
    assert not verify_evm("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAde")[0], \
        "EIP-55 verifier accepts a corrupted address"


def main():
    self_test()
    wallet = load_wallet()
    failures = 0
    width = max(len(name) for name, _, _ in wallet)
    for name, address, verifier in wallet:
        ok, detail = verifier(address)
        if not ok:
            failures += 1
        print("%s  %s  %s" % ("PASS" if ok else "FAIL", name.ljust(width), detail))
        print("      %s  %s" % (" ".ljust(width), address))
    print()
    if failures:
        print("%d address(es) FAILED verification. Do not use them." % failures)
    else:
        print("All %d verified. Safe to paste into payout forms." % len(wallet))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
