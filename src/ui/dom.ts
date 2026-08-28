/**
 * Minimal typed DOM helpers.
 *
 * The UI is plain DOM on purpose: a virtual-DOM framework would add bundle
 * weight and a second state model for screens that are mostly static panels
 * over a 3D canvas. These helpers exist so element construction stays terse
 * and consistent without pulling in a dependency.
 */

type Falsy = null | undefined | false;

export type Child = Node | string | number | Falsy;

export interface ElementOptions {
  class?: string | (string | Falsy)[];
  text?: string;
  html?: string;
  id?: string;
  /** Applied via setAttribute. Use for aria-*, data-*, role, type, etc. */
  attrs?: Record<string, string | number | boolean | Falsy>;
  style?: Partial<CSSStyleDeclaration> & Record<string, string | number>;
  dataset?: Record<string, string | number | Falsy>;
  children?: Child[];
  on?: {
    [K in keyof HTMLElementEventMap]?: (
      ev: HTMLElementEventMap[K],
    ) => void;
  };
}

function normaliseClass(value: ElementOptions['class']): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  const parts = value.filter((c): c is string => typeof c === 'string' && c.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  const className = normaliseClass(options.class);
  if (className) node.className = className;
  if (options.id) node.id = options.id;

  // `text` is preferred; `html` is only for trusted authored markup.
  if (options.text !== undefined) node.textContent = options.text;
  else if (options.html !== undefined) node.innerHTML = options.html;

  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
  }

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      if (value === null || value === undefined || value === false) continue;
      node.dataset[key] = String(value);
    }
  }

  if (options.style) {
    for (const [key, value] of Object.entries(options.style)) {
      if (value === null || value === undefined) continue;
      // Support custom properties (--foo) alongside normal style keys.
      if (key.startsWith('--')) node.style.setProperty(key, String(value));
      else (node.style as unknown as Record<string, string>)[key] = String(value);
    }
  }

  if (options.children) append(node, ...options.children);

  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      if (typeof handler === 'function') {
        node.addEventListener(event, handler as EventListener);
      }
    }
  }

  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function remove(node: ChildNode | null | undefined): void {
  node?.parentNode?.removeChild(node);
}

/** Throws rather than returning null so boot failures are loud, not silent. */
export function requireElement<T extends HTMLElement = HTMLElement>(
  selector: string,
): T {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Required element not found: ${selector}`);
  }
  return found;
}
