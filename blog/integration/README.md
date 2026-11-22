# Embedding `<slosh-sim>` in the al-folio site (candresdu.github.io)

This folder holds what you copy into the [al-folio](https://github.com/alshedivat/al-folio) Jekyll site
repository (`candresdu.github.io`, served by GitHub Pages). The site repo is not part of this repository,
so you deploy these files by hand.

| File here | Destination in the site repo |
|---|---|
| `web/dist/slosh-sim.js` (after `npm run build`) | `assets/js/slosh-sim.js` |
| `blog/images/*` (PNG and SVG, including `slosh-fallback.png`) | `assets/img/slosh/` |
| `blog/integration/_includes/slosh-sim.html` | `_includes/slosh-sim.html` |
| `blog/slosh-testbed.md` | `_posts/YYYY-MM-DD-slosh-testbed.md` |

`blog/images/CAPTIONS.md` is documentation for this repo and does not need to be copied.

## Release flow

1. Build the module: `cd web && npm ci && npm run build` (output: `web/dist/slosh-sim.js`, one ES module with
   Three.js and uPlot bundled).
2. Copy the four items from the table above into the site repo, at exactly those paths. Name the post with the
   date you publish it, e.g. `_posts/2026-11-21-slosh-testbed.md`. The blog section must be enabled in the site
   (`_pages/blog.md`, and `blog_nav_title` / the navbar entry in `_config.yml`).
3. Bump the version in the include's `?v=` query (`_includes/slosh-sim.html`, the `<script type="module">` line,
   for example `?v=0.1.0` to `?v=0.1.1`). GitHub Pages serves static files with a cache lifetime, and the query
   string makes browsers fetch the new module.
4. Exclude the module from `jekyll-minifier`. al-folio enables that plugin, and its JavaScript compressor can
   mangle or fail on ES modules (the file is already minified by Vite). In the site's `_config.yml`:

   ```yaml
   jekyll-minifier:
     exclude: ["assets/js/slosh-sim.js"]
   ```

   If the site already has a `jekyll-minifier:` block, add the path to its existing `exclude` list instead of
   creating a second block. Keep any other settings in the block.
5. Commit and push the site repository. GitHub Pages rebuilds in a minute or two.

Check a post front matter is `layout: post`, as in the draft. The draft turns off comments and related posts;
change that to taste.

## Using the include

Default use is story mode, one continuous flight (stable, then gain shift, then AAC engaged). It needs no
parameters:

```liquid
{% include slosh-sim.html %}
```

With no `preset` param the include emits `<slosh-sim>` with no `preset` attribute, and the component starts in
story mode.

To start from a single figure's setup instead, pass a preset (`story`, `fig12`, `fig13`, `fig14` or `vb`):

```liquid
{% include slosh-sim.html preset="fig13" autoplay=true %}
```

| Param | Becomes | Notes |
|---|---|---|
| `preset` | `preset="…"` | Only emitted when given |
| `autoplay` | `autoplay` | `autoplay=true` starts playing on load. Ignored when the reader prefers reduced motion |
| `theme` | `theme="light"` or `"dark"` | Omit it to follow the site's light/dark toggle |
| `fullscreen_button` | `fullscreen-button="…"` | `"false"` hides the full-screen button |

The include also emits the module script, `<script type="module" src="{{ '/assets/js/slosh-sim.js' | relative_url }}?v=…">`,
and a `<img slot="fallback">` that the component shows only when WebGL is unavailable.

Several embeds on one page are fine: every embed uses the same module URL, so the browser executes the module
once, and the custom element is defined once.

## Theming

The component lives in a Shadow DOM and reads only al-folio's light/dark state (`html[data-theme]`). Its
colours come from these CSS custom properties, set on the element or on any ancestor:

```css
slosh-sim {
  --slosh-bg: #ffffff;      /* panel and chart background */
  --slosh-fg: #1a1a1a;      /* text and axes */
  --slosh-accent: #b509ac;  /* buttons, focus ring, highlights */
}
```

When a `--slosh-*` property is not set, it falls back to al-folio's `--global-bg-color`,
`--global-text-color` and `--global-theme-color` respectively, and then to the component's built-in palette.
Switching the site's theme toggle recolours the 3D scene, charts and controls without a reload.

## Local preview before deploying

`preview.html` mimics an al-folio post: a fixed top navbar, a 730 px column and a button that toggles
`html[data-theme]`. It shows the article converted from `blog/slosh-testbed.md`, with the Liquid include replaced
by its real output. Two components are kept (the story-mode one and the first replay-preset one). It is
generated, so regenerate it after editing the post or the include:

```sh
python3 -m venv .venv-preview && .venv-preview/bin/pip install markdown    # once
(cd web && npm ci && npm run build)
.venv-preview/bin/python blog/integration/build_preview.py    # writes preview.html, copies dist and images
                                                              # into blog/integration/assets/ (git-ignored)
cd blog/integration && python3 -m http.server 8000
```

Open <http://localhost:8000/preview.html>. Use the sun/moon button to check light and dark, and open the
browser console to confirm there is no error. Equations are rendered with MathJax 3 (loaded from jsDelivr), the way
al-folio renders them: write inline math as `$$…$$` in the post (kramdown turns it into `\(…\)` and leaves the TeX
alone), and display math as a `$$` block on its own lines.

Screenshots of a preview run, taken with the story-mode component in the page (light and dark theme):
`screenshots/preview-light.png`, `screenshots/preview-dark.png`.
