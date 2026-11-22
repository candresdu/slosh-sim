# Pre-publication check

Checked on 2026-11-22, on branch `agent/rev-11`, before the repository is made public.

| Check | Command or method | Result |
|---|---|---|
| No PDF anywhere in git history | `git log --all --name-only --pretty=format: \| grep -i '\.pdf$'` | **Pass**: no output |
| No PDF in the working tree | `git ls-files '*.pdf'` | **Pass**: no output |
| LICENSE present and MIT | `head -1 LICENSE` | **Pass**: `MIT License` |
| README links the references | read `README.md` | **Pass**: links `docs/references.md` (twice) |
| No internal question or task numbers in the README or the references | `grep -nE "Q-[0-9]+\|#[0-9]+" README.md docs/references.md` | **Pass**: no match |
| Paper citation complete | read `docs/references.md` | **Pass**: venue, year, paper number and DOI (10.2514/6.2019-0114), with BibTeX |
| No long excerpts of the paper | search of every tracked Markdown file for block quotes and long quoted strings; read of the blog post and the README | **Pass**, with a limit: the paper's text is not in the repository, so nothing was compared word for word. The only block quote is the paper's citation in the README. The blog post describes the paper in its own words and cites its equations and figures by number. |
| No internal planning tags anywhere | `git grep -nE "Q-[0-9]+"` over all tracked files | **Pass**: no match. The tags were removed from comments, reports and the parameter provenance; the golden traces were regenerated (identical data, new parameter-file checksum) |
| No secrets | `git grep -niE "api[_-]?key\|token\|password\|secret"` | **Pass**: one match, the word "tokens" in a parser comment |
| No large binaries | largest tracked files | **Pass**: largest are the golden traces (`golden/*.json`, 1.9 to 4.9 MB), which are deliberate |

The design-decision records originally planned for `docs/decisions/` were dropped at the owner's
request. The blog post and `reports/` explain the modelling choices.

## Noted, not blocking

- **Commit authors.** Most commits are authored by "Engineer agent
  &lt;agent@agent-workspace.local&gt;", the coding agent that did the work. That name is public once the
  history is.
- **Blog link.** The README links the blog index. Replace it with the post's own URL once it is
  published.
