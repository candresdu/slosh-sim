#!/usr/bin/env python3
"""Build blog/integration/preview.html: a local page that mimics an al-folio post.

It converts blog/slosh-testbed.md with the `markdown` package and replaces each
`{% include slosh-sim.html ... %}` with the output of the real Jekyll include (a tiny Liquid subset is
emulated: `include.x`, `{% if include.x %}` and the `relative_url` filter, which becomes "./"). Only the
first story-mode embed and the first replay-preset embed are kept, so the preview runs two components.

    python3 -m venv .venv-preview && .venv-preview/bin/pip install markdown
    cd web && npm run build && cd ..
    .venv-preview/bin/python blog/integration/build_preview.py      # also copies dist + images into
                                                                    # blog/integration/assets/ (git-ignored)
    cd blog/integration && python3 -m http.server 8000              # open http://localhost:8000/preview.html
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

import markdown

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
POST = ROOT / "blog" / "slosh-testbed.md"
INCLUDE = HERE / "_includes" / "slosh-sim.html"
OUT = HERE / "preview.html"
BASE = "."  # what relative_url prepends: preview.html sits next to assets/


def relative_url(path: str) -> str:
    return BASE + path


def parse_params(s: str) -> dict[str, str]:
    params: dict[str, str] = {}
    for m in re.finditer(r'(\w+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|(\S+))', s):
        params[m.group(1)] = next(g for g in m.groups()[1:] if g is not None)
    return params


def render_liquid(src: str, include: dict[str, str]) -> str:
    src = re.sub(r"\{%-?\s*comment\s*-?%\}.*?\{%-?\s*endcomment\s*-?%\}", "", src, flags=re.S)

    def truthy(name: str) -> bool:
        v = include.get(name)
        return v is not None and v not in ("false", "")

    src = re.sub(
        r"\{%\s*if include\.(\w+)\s*%\}(.*?)\{%\s*endif\s*%\}",
        lambda m: m.group(2) if truthy(m.group(1)) else "",
        src,
        flags=re.S,
    )
    src = re.sub(r"\{\{\s*include\.(\w+)\s*\}\}", lambda m: include.get(m.group(1), ""), src)
    return re.sub(
        r"\{\{\s*'([^']*)'\s*\|\s*relative_url\s*\}\}", lambda m: relative_url(m.group(1)), src
    )


def main() -> int:
    text = POST.read_text(encoding="utf-8")
    text = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S)
    title = re.search(r"^title:\s*\"?(.*?)\"?\s*$", POST.read_text(encoding="utf-8"), flags=re.M)
    template = INCLUDE.read_text(encoding="utf-8")

    seen: set[str] = set()
    stash: list[str] = []

    def embed(m: re.Match[str]) -> str:
        params = parse_params(m.group(1))
        kind = params.get("preset", "story")
        story = kind == "story"
        key = "story" if story else "replay"
        if key in seen:
            return ""  # the preview keeps one story embed and one replay embed
        seen.add(key)
        stash.append(render_liquid(template, params))
        return f"\n\nSLOSHEMBED{len(stash) - 1}X\n\n"

    text = re.sub(r"\{%\s*include slosh-sim\.html([^%]*)%\}", embed, text)

    # math, as kramdown hands it to al-folio's MathJax: a $$ block on its own lines is display math, an inline
    # $$…$$ is inline math. Stashed so Markdown does not touch the TeX.
    math: list[str] = []

    def stash_math(tex: str, display: bool) -> str:
        math.append(f"\\[{tex}\\]" if display else f"\\({tex}\\)")
        return f"SLOSHMATH{len(math) - 1}X"

    text = re.sub(r"^\$\$\n(.*?)\n\$\$$", lambda m: stash_math(m.group(1), True), text, flags=re.M | re.S)
    text = re.sub(r"\$\$(.+?)\$\$", lambda m: stash_math(m.group(1), False), text, flags=re.S)
    text = re.sub(
        r"\{\{\s*'([^']*)'\s*\|\s*relative_url\s*\}\}", lambda m: relative_url(m.group(1)), text
    )
    html = markdown.markdown(text, extensions=["extra", "sane_lists", "toc"])
    for i, e in enumerate(stash):
        html = html.replace(f"<p>SLOSHEMBED{i}X</p>", e)
    for i in reversed(range(len(math))):  # reversed: SLOSHMATH1X must not match inside SLOSHMATH12X
        html = html.replace(f"SLOSHMATH{i}X", math[i])
    if re.search(r"\{%|SLOSHEMBED|SLOSHMATH", html):
        print("unrendered Liquid left in the article", file=sys.stderr)
        return 1

    page = PAGE.replace("@@TITLE@@", title.group(1) if title else "slosh-sim preview").replace("@@BODY@@", html)
    OUT.write_text(page, encoding="utf-8")

    assets = HERE / "assets"
    dist = ROOT / "web" / "dist" / "slosh-sim.js"
    (assets / "js").mkdir(parents=True, exist_ok=True)
    (assets / "img" / "slosh").mkdir(parents=True, exist_ok=True)
    if dist.exists():
        shutil.copy2(dist, assets / "js" / "slosh-sim.js")
    else:
        print("web/dist/slosh-sim.js missing: run `cd web && npm run build` first", file=sys.stderr)
    for f in (ROOT / "blog" / "images").iterdir():
        if f.suffix in {".png", ".svg"}:
            shutil.copy2(f, assets / "img" / "slosh" / f.name)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(stash)} embeds)")
    return 0


PAGE = """<!doctype html>
<!-- GENERATED by build_preview.py from blog/slosh-testbed.md. Do not edit by hand. -->
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>@@TITLE@@ (local preview)</title>
    <style>
      /* Mimics al-folio: fixed top navbar, ~730 px post column, html[data-theme] light/dark custom properties. */
      html[data-theme='light'] { --global-bg-color: #ffffff; --global-text-color: #000000; --global-theme-color: #b509ac; --global-hover-color: #b509ac; }
      html[data-theme='dark'] { --global-bg-color: #1c1c1d; --global-text-color: #e8e8e8; --global-theme-color: #2698ba; --global-hover-color: #2698ba; }
      body { margin: 0; padding-top: 56px; font: 16px/1.6 system-ui, sans-serif; background: var(--global-bg-color); color: var(--global-text-color); }
      nav.navbar { position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 1030; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; background: var(--global-bg-color); border-bottom: 1px solid #8884; }
      nav.navbar a { color: var(--global-text-color); text-decoration: none; font-weight: 600; }
      nav.navbar button { display: inline-flex; padding: 6px; border: 0; border-radius: 50%; background: transparent; color: var(--global-text-color); cursor: pointer; opacity: .75; }
      nav.navbar button:hover, nav.navbar button:focus-visible { opacity: 1; color: var(--global-theme-color); }
      nav.navbar button svg { width: 20px; height: 20px; }
      html[data-theme='light'] .icon-sun, html[data-theme='dark'] .icon-moon { display: none; }
      mjx-container[display='true'] { overflow-x: auto; overflow-y: hidden; }
      .footnote { font-size: 0.9em; }
      main.container { max-width: 730px; margin: 0 auto; padding: 16px; }
      article img { max-width: 100%; height: auto; }
      h1, h2, h3 { line-height: 1.2; }
      a { color: var(--global-theme-color); }
      code { background: #8882; padding: 0 3px; border-radius: 3px; }
      slosh-sim { display: block; margin: 16px 0; }
    </style>
  </head>
  <body>
    <nav class="navbar" aria-label="Site">
      <a href="#top">al-folio preview</a>
      <button id="toggle" type="button" aria-label="Toggle theme" title="Toggle theme">
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
    </nav>
    <main class="container" id="top">
      <article>
@@BODY@@
      </article>
    </main>
    <script>
      // al-folio renders math with MathJax 3; SVG output needs no web fonts
      window.MathJax = { tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['\\\\[', '\\\\]']] } };
    </script>
    <script defer src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js"></script>
    <script>
      // al-folio flips html[data-theme]; the component observes that attribute.
      const root = document.documentElement;
      if (new URLSearchParams(location.search).get('theme') === 'dark') root.setAttribute('data-theme', 'dark');
      document.getElementById('toggle').addEventListener('click', () => {
        root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      });
    </script>
  </body>
</html>
"""

if __name__ == "__main__":
    raise SystemExit(main())
