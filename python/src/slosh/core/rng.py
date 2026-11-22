"""Seeded RNG: xoshiro128** on uint32, seeded by splitmix32, Gaussian by Box-Muller.

Exact algorithm (all arithmetic is modulo 2**32; ``rotl(v, r) = ((v << r) | (v >> (32 - r)))``):

splitmix32(seed) -- each call produces one word::

    a = (a + 0x9E3779B9) mod 2**32          # a starts as seed mod 2**32
    t = a ^ (a >> 16);  t = (t * 0x21F0AAAD) mod 2**32
    t = t ^ (t >> 15);  t = (t * 0x735A2D97) mod 2**32
    out = t ^ (t >> 15)

State: four words ``s0..s3`` are the first four splitmix32 outputs. (If all are zero, ``s0 = 1``.)

xoshiro128** ``next_u32``::

    result = rotl(s1 * 5, 7) * 9
    t = s1 << 9
    s2 ^= s0;  s3 ^= s1;  s1 ^= s2;  s0 ^= s3;  s2 ^= t;  s3 = rotl(s3, 11)

Uniform: ``u = (next_u32 + 0.5) / 2**32``, strictly inside (0, 1).

``normal()`` (Box-Muller, second value cached)::

    u1 = uniform(); u2 = uniform()           # drawn in this order, only when the cache is empty
    r = sqrt(-2 ln u1)
    z0 = r cos(2 pi u2)  -> returned;   z1 = r sin(2 pi u2)  -> cached for the next call

In TypeScript use ``Math.imul`` for the 32-bit multiplies and ``>>> 0`` to keep words unsigned.
``ln``/``cos``/``sin`` may differ in the last ulp between runtimes; the integer stream is exact.
"""

from __future__ import annotations

import math

_M32 = 0xFFFFFFFF
_TWO32 = 4294967296.0


def splitmix32(state: int) -> tuple[int, int]:
    """One splitmix32 step: returns ``(new_state, output)``."""
    a = (state + 0x9E3779B9) & _M32
    t = a ^ (a >> 16)
    t = (t * 0x21F0AAAD) & _M32
    t ^= t >> 15
    t = (t * 0x735A2D97) & _M32
    return a, t ^ (t >> 15)


def _rotl(v: int, r: int) -> int:
    return ((v << r) | (v >> (32 - r))) & _M32


class Rng:
    """xoshiro128** generator with Box-Muller normals."""

    def __init__(self, seed: int) -> None:
        a = seed & _M32
        s: list[int] = []
        for _ in range(4):
            a, out = splitmix32(a)
            s.append(out)
        if not any(s):
            s[0] = 1
        self.s = s
        self._cache: float | None = None

    def next_u32(self) -> int:
        s = self.s
        result = (_rotl((s[1] * 5) & _M32, 7) * 9) & _M32
        t = (s[1] << 9) & _M32
        s[2] ^= s[0]
        s[3] ^= s[1]
        s[1] ^= s[2]
        s[0] ^= s[3]
        s[2] ^= t
        s[3] = _rotl(s[3], 11)
        return result

    def uniform(self) -> float:
        """Uniform in the open interval (0, 1)."""
        return (self.next_u32() + 0.5) / _TWO32

    def normal(self) -> float:
        """Standard normal via Box-Muller (the sine partner is cached for the next call)."""
        if self._cache is not None:
            z, self._cache = self._cache, None
            return z
        u1 = self.uniform()
        u2 = self.uniform()
        r = math.sqrt(-2.0 * math.log(u1))
        ang = 2.0 * math.pi * u2
        self._cache = r * math.sin(ang)
        return r * math.cos(ang)
