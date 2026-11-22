"""The figure script writes every model-generated article image."""

from __future__ import annotations

import xml.dom.minidom
from pathlib import Path

from slosh import figures

EXPECTED = [
    "nichols_outer.png",
    "fig12_like.png",
    "fig13_like.png",
    "fig14_like.png",
    "vb_sequence.png",
    "story_sequence.png",
    "architecture.svg",
]


def test_figures_written(tmp_path: Path) -> None:
    figures.main(["--out", str(tmp_path)])
    for name in EXPECTED:
        assert (tmp_path / name).stat().st_size > 1000, name
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(EXPECTED)
    xml.dom.minidom.parse(str(tmp_path / "architecture.svg"))
