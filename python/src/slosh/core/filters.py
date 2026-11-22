"""Biquad filters (plain scalar floats, ``math`` only).

Direct-form-II-transposed, coefficients ``(b0, b1, b2, a1, a2)`` with ``a0 = 1``::

    y   = b0 x + z1
    z1' = b1 x - a1 y + z2
    z2' = b2 x - a2 y

The coefficients come from ``aac.hp.sos`` / ``aac.lp.sos`` in the shared parameter file, so the
TypeScript core uses bit-identical values.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence


class Biquad:
    """One second-order section in direct-form-II-transposed."""

    __slots__ = ("a1", "a2", "b0", "b1", "b2", "z1", "z2")

    def __init__(self, b0: float, b1: float, b2: float, a1: float, a2: float) -> None:
        self.b0 = float(b0)
        self.b1 = float(b1)
        self.b2 = float(b2)
        self.a1 = float(a1)
        self.a2 = float(a2)
        self.z1 = 0.0
        self.z2 = 0.0

    def step(self, x: float) -> float:
        y = self.b0 * x + self.z1
        self.z1 = self.b1 * x - self.a1 * y + self.z2
        self.z2 = self.b2 * x - self.a2 * y
        return y

    def reset(self) -> None:
        self.z1 = 0.0
        self.z2 = 0.0


class Sos:
    """Cascade of biquads; an empty cascade is the identity."""

    def __init__(self, sections: Iterable[Sequence[float]]) -> None:
        self.sections: list[Biquad] = []
        for row in sections:
            if len(row) != 5:
                raise ValueError(f"biquad row needs 5 coefficients, got {len(row)}")
            self.sections.append(Biquad(*row))

    def step(self, x: float) -> float:
        for s in self.sections:
            x = s.step(x)
        return x

    def reset(self) -> None:
        for s in self.sections:
            s.reset()
