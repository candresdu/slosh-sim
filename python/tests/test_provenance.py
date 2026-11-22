"""The reconstruction disclaimer lists every parameter that is not from R-1 Table 2."""

from __future__ import annotations

import json
import re
from pathlib import Path

from slosh import provenance
from slosh.params import DEFAULT_PARAMS_PATH

BLOG = Path(__file__).resolve().parents[2] / "blog"


def _all_leaves(node: dict, path: str = "") -> list[tuple[str, str]]:
    out = []
    for k, v in node.items():
        if isinstance(v, dict):
            sub = f"{path}.{k}" if path else k
            if "v" in v and "src" in v:
                out.append((sub, v["src"]))
            else:
                out.extend(_all_leaves(v, sub))
    return out


def test_lists_every_non_table2_parameter() -> None:
    tree = json.loads(DEFAULT_PARAMS_PATH.read_text())
    md = provenance.to_markdown()
    leaves = _all_leaves(tree)
    assert len(leaves) > 30
    for path, src in leaves:
        listed = f"`{path}`" in md
        assert listed == (src != "R-1 Table 2"), path


def test_no_internal_question_numbers() -> None:
    assert not re.search(r"\bQ-\d+", provenance.to_markdown())


def test_states_qualitative() -> None:
    assert "qualitatively" in provenance.to_markdown()


def test_committed_file_is_current() -> None:
    assert (BLOG / "reconstruction.md").read_text() == provenance.to_markdown() + "\n"
