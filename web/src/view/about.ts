// "About these parameters" panel: a native <details> listing every parameter whose provenance is not
// "R-1 Table 2", marked as assumed, designed or tuned (a reconstruction, since the original values
// are not available).

/** Provenance string of values taken directly from the paper's parameter table. */
export const R1_TABLE2 = 'R-1 Table 2';

export const ABOUT_CSS = `
.sc-about { font: 14px/1.4 system-ui, sans-serif; color: var(--sc-fg, inherit); border: 1px solid var(--sc-border, currentColor); border-radius: 6px; padding: 6px 10px; }
.sc-about summary { cursor: pointer; font-weight: 600; }
.sc-about summary:focus-visible { outline: 3px solid var(--sc-focus, #0b5cad); outline-offset: 2px; }
.sc-about p { margin: 6px 0; color: var(--sc-muted, inherit); }
.sc-about ul { margin: 4px 0 8px; padding-left: 18px; }
.sc-about li { margin: 2px 0; }
.sc-about code { font-family: ui-monospace, monospace; font-size: 12px; }
.sc-about .sc-src { color: var(--sc-muted, inherit); }
`;

export interface AboutEntry {
  path: string;
  /** Display text of the value ('' if the value is unknown). */
  value: string;
  /** Provenance exactly as in the parameter file. */
  src: string;
  /** Provenance for display (internal question references removed). */
  label: string;
  /** Assumed, designed or tuned, i.e. part of the reconstruction. */
  reconstruction: boolean;
}

/** Remove internal planning tags such as "(Q-<n>)" if any remain in a provenance string. */
export function cleanSource(src: string): string {
  return src.replace(/\s*\(Q-\d+\)/g, '').trim();
}

function isReconstruction(src: string): boolean {
  return /^(assumed|designed|tuned)\b/.test(src);
}

function lookup(params: unknown, path: string): unknown {
  let cur: unknown = params;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function fmtValue(v: unknown): string {
  if (typeof v === 'number') return String(Number(v.toPrecision(5)));
  if (typeof v === 'boolean' || typeof v === 'string') return String(v);
  if (v === null) return 'not set';
  if (Array.isArray(v)) return `${v.length} coefficient rows`;
  return '';
}

/** All parameters whose provenance is not R-1 Table 2, in the order of the provenance map. */
export function aboutEntries(provenance: Readonly<Record<string, string>>, params?: unknown): AboutEntry[] {
  const out: AboutEntry[] = [];
  for (const [path, src] of Object.entries(provenance)) {
    if (src === R1_TABLE2) continue;
    out.push({
      path,
      value: params === undefined ? '' : fmtValue(lookup(params, path)),
      src,
      label: cleanSource(src),
      reconstruction: isReconstruction(src),
    });
  }
  return out;
}

export interface AboutHandle {
  readonly element: HTMLDetailsElement;
  readonly entries: readonly AboutEntry[];
  dispose(): void;
}

export function createAbout(
  container: HTMLElement,
  provenance: Readonly<Record<string, string>>,
  params?: unknown,
): AboutHandle {
  const doc = container.ownerDocument;
  const entries = aboutEntries(provenance, params);
  const details = doc.createElement('details');
  details.className = 'sc-about';
  const summary = doc.createElement('summary');
  summary.textContent = 'About these parameters';
  details.appendChild(summary);

  const intro = doc.createElement('p');
  intro.textContent =
    'The vehicle and pendulum values listed in the paper’s parameter table are used as given. The original controller gains, ' +
    'motor time constant, controller rate, adaptive-law settings and detection threshold are not available, so the values ' +
    'below are a reconstruction: assumed, designed or tuned for this simulation to reproduce the published behaviour qualitatively.';
  details.appendChild(intro);

  const ul = doc.createElement('ul');
  for (const e of entries) {
    const li = doc.createElement('li');
    li.dataset.param = e.path;
    li.dataset.src = e.src;
    li.dataset.reconstruction = String(e.reconstruction);
    const code = doc.createElement('code');
    code.textContent = e.path;
    const src = doc.createElement('span');
    src.className = 'sc-src';
    src.textContent = ` ${e.value === '' ? '' : `= ${e.value} `}(${e.label}${e.reconstruction && !e.label.includes('reconstruction') ? ', reconstruction' : ''})`;
    li.append(code, src);
    ul.appendChild(li);
  }
  details.appendChild(ul);
  container.appendChild(details);
  return { element: details, entries, dispose: () => details.remove() };
}
