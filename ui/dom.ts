/** A tiny helper to build DOM elements without a framework. */
export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'open', 'indeterminate', 'min', 'max', 'step', 'multiple']);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (PROPS.has(k)) (el as unknown as Record<string, unknown>)[k] = v;
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Replaces an element's children (skipping null, false…). */
export function fill(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export function svg(tag: string, attrs: Record<string, string | number>, ...children: Node[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

export const fmtMin = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);

/** Short message in the corner. */
export function toast(msg: string, kind: 'ok' | 'error' = 'ok') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.classList.add('gone'), kind === 'error' ? 6000 : 2500);
  setTimeout(() => el.remove(), kind === 'error' ? 6600 : 3100);
}

export function lines(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** A card with a title and optional help text. */
export function section(title: string, help: Child, ...body: Child[]) {
  return h('section', { class: 'card' }, h('h2', null, title), help ? h('p', { class: 'help' }, help) : null, ...body);
}
