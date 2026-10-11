"""Read-only: decode the game's save file (KSRB header + MessagePack, LZ4BlockArray compression) to JSON.

  python read_save.py <persistent_user_data.bin> [out.json]

Only reads. Handy to see what the game really persisted (unlocked assets, saved blueprints, slot capacities).
"""
import json
import struct
import sys


def lz4_block_decompress(src, expected):
    out = bytearray()
    i = 0
    n = len(src)
    while i < n:
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        out += src[i:i + lit]
        i += lit
        if i >= n:
            break
        offset = src[i] | (src[i + 1] << 8)
        i += 2
        mlen = token & 15
        if mlen == 15:
            while True:
                b = src[i]
                i += 1
                mlen += b
                if b != 255:
                    break
        mlen += 4
        start = len(out) - offset
        for k in range(mlen):
            out.append(out[start + k])
    if expected is not None and len(out) != expected:
        raise ValueError("lz4: got %d bytes, expected %d" % (len(out), expected))
    return bytes(out)


class Reader:
    def __init__(self, data):
        self.d = data
        self.i = 0

    def take(self, n):
        v = self.d[self.i:self.i + n]
        if len(v) != n:
            raise EOFError
        self.i += n
        return v

    def u(self, fmt):
        size = struct.calcsize(fmt)
        return struct.unpack(">" + fmt, self.take(size))[0]

    def read(self):
        t = self.u("B")
        if t <= 0x7f:
            return t
        if t >= 0xe0:
            return t - 256
        if 0x80 <= t <= 0x8f:
            return self.map(t & 15)
        if 0x90 <= t <= 0x9f:
            return self.arr(t & 15)
        if 0xa0 <= t <= 0xbf:
            return self.str(t & 31)
        if t == 0xc0:
            return None
        if t == 0xc2:
            return False
        if t == 0xc3:
            return True
        if t == 0xc4:
            return self.binary(self.u("B"))
        if t == 0xc5:
            return self.binary(self.u("H"))
        if t == 0xc6:
            return self.binary(self.u("I"))
        if t == 0xc7:
            return self.ext(self.u("B"))
        if t == 0xc8:
            return self.ext(self.u("H"))
        if t == 0xc9:
            return self.ext(self.u("I"))
        if t == 0xca:
            return self.u("f")
        if t == 0xcb:
            return self.u("d")
        if t == 0xcc:
            return self.u("B")
        if t == 0xcd:
            return self.u("H")
        if t == 0xce:
            return self.u("I")
        if t == 0xcf:
            return self.u("Q")
        if t == 0xd0:
            return self.u("b")
        if t == 0xd1:
            return self.u("h")
        if t == 0xd2:
            return self.u("i")
        if t == 0xd3:
            return self.u("q")
        if t in (0xd4, 0xd5, 0xd6, 0xd7, 0xd8):
            return self.ext({0xd4: 1, 0xd5: 2, 0xd6: 4, 0xd7: 8, 0xd8: 16}[t])
        if t == 0xd9:
            return self.str(self.u("B"))
        if t == 0xda:
            return self.str(self.u("H"))
        if t == 0xdb:
            return self.str(self.u("I"))
        if t == 0xdc:
            return self.arr(self.u("H"))
        if t == 0xdd:
            return self.arr(self.u("I"))
        if t == 0xde:
            return self.map(self.u("H"))
        if t == 0xdf:
            return self.map(self.u("I"))
        raise ValueError("bad msgpack byte 0x%02x at %d" % (t, self.i - 1))

    def str(self, n):
        text = self.take(n).decode("utf-8", "replace")
        if text.startswith("eyJ"):  # the profile's signed ownership certificate: never print or store it
            return f"<token redacted, {len(text)} chars>"
        return text

    def binary(self, n):
        return {"$bin": self.take(n).hex()} if n <= 32 else {"$bin_len": n, "$head": self.take(n)[:16].hex()}

    def ext(self, n):
        code = struct.unpack(">b", self.take(1))[0]
        return {"$ext": code, "data": self.take(n).hex()}

    def arr(self, n):
        return [self.read() for _ in range(n)]

    def map(self, n):
        out = {}
        for _ in range(n):
            k = self.read()
            out[str(k)] = self.read()
        return out


def decode_file(path):
    raw = open(path, "rb").read()
    if raw[:4] != b"KSRB":
        raise SystemExit("not a KSRB save")
    body = raw[raw.index(b"\x93\xc7"):]  # start of the compressed MessagePack array
    r = Reader(body)
    count = r.u("B") & 15  # fixarray header
    ext_len = None
    t = r.u("B")
    assert t == 0xc7, hex(t)
    ext_len = r.u("B")
    code = struct.unpack(">b", r.take(1))[0]
    assert code == 98, code  # LZ4BlockArray
    lens_r = Reader(r.take(ext_len))
    lengths = []
    while lens_r.i < len(lens_r.d):
        lengths.append(lens_r.read())
    chunks = []
    for ln in lengths:
        t = r.u("B")
        size = {0xc4: "B", 0xc5: "H", 0xc6: "I"}[t]
        comp = r.take(r.u(size))
        chunks.append(lz4_block_decompress(comp, ln))
    return b"".join(chunks)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    data = decode_file(sys.argv[1])
    tree = Reader(data).read()
    text = json.dumps(tree, ensure_ascii=False, indent=1)
    if len(sys.argv) > 2:
        open(sys.argv[2], "w", encoding="utf-8").write(text)
        print("wrote", sys.argv[2], len(text), "chars; raw msgpack", len(data), "bytes")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)
