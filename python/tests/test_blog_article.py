"""Structural checks of the al-folio blog article draft (blog/slosh-testbed.md)."""

from __future__ import annotations

import re
from pathlib import Path

BLOG = Path(__file__).resolve().parents[2] / "blog"
TEXT = (BLOG / "slosh-testbed.md").read_text()


def test_front_matter() -> None:
    head = TEXT.split("---")[1]
    for key in ("layout: post", "title:", "date:", "description:", "tags:", "categories:"):
        assert key in head, key


def test_eight_sections() -> None:
    heads = re.findall(r"^## (\d)\. ", TEXT, flags=re.M)
    assert heads == [str(i) for i in range(1, 9)]


def test_wording() -> None:
    assert "2018" not in TEXT
    assert "Demo Flight 2" in TEXT and "2007" in TEXT
    assert not re.search(r"inverted", TEXT, flags=re.I)
    assert "hanging" in TEXT
    assert not re.search(r"\bkick", TEXT, flags=re.I)
    assert "Play the story from the start" not in TEXT
    assert not re.search(r"\bQ-\d+", TEXT)
    assert "qualitatively" in TEXT


def test_walkthrough_terms() -> None:
    sec5 = TEXT.split("## 5.")[1].split("## 6.")[0]
    for term in (
        "Nominal · Fig 12",
        "Gain shift · Fig 13",
        "AAC engaged · Fig 14",
        "info banner",
        "shading",
        "Replay the paper",
        "Restart",
        "tap the 3D view",
        "story_sequence.png",
    ):
        assert term in sec5, term


def test_first_embed_is_story() -> None:
    first = re.search(r"\{% include slosh-sim\.html([^%]*)%\}", TEXT)
    assert first is not None
    assert "preset" not in first.group(1)


def test_images_exist() -> None:
    names = re.findall(r"/assets/img/slosh/([\w.\-]+)'", TEXT)
    assert names
    for n in names:
        assert (BLOG / "images" / n).stat().st_size > 1000, n


def test_one_widget() -> None:
    # one story-mode widget does the job of the single-figure presets
    assert len(re.findall(r"\{% include slosh-sim\.html", TEXT)) == 1


def test_parameter_table_not_in_post() -> None:
    # the full provenance table stays in blog/reconstruction.md; the post links to it
    assert "reconstruction-table" not in TEXT
    assert "reconstruction.md" in TEXT
    assert (BLOG / "reconstruction.md").stat().st_size > 1000


def test_inline_math_uses_double_dollars() -> None:
    # kramdown passes $$…$$ to MathJax untouched; single-$ math goes through Markdown first
    body = re.sub(r"\$\$.*?\$\$", "", TEXT, flags=re.S)
    assert "$" not in body
