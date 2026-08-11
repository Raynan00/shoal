import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * The accessibility modality.
 *
 * A vision agent sees pixels. A screen-reader user does not — they perceive the
 * accessibility tree and move by keyboard. That is a *different user*, not a cheaper one,
 * and it finds a class of defect vision structurally cannot: unlabelled controls, wrong
 * roles, invisible focus, keyboard traps, controls that can never be reached at all.
 *
 * This browser exposes exactly what a screen-reader user has: a tree to read, Tab/Shift-Tab
 * to move, Enter/Space to activate, and typing. No coordinates, ever.
 */

let shared: Promise<Browser> | null = null;

function sharedBrowser(headless: boolean): Promise<Browser> {
  if (!shared) shared = chromium.launch({ headless });
  return shared;
}

export async function closeSharedA11yBrowser(): Promise<void> {
  if (shared) {
    const b = await shared;
    shared = null;
    await b.close().catch(() => {});
  }
}

export interface A11yAction {
  action:
    | "read_screen"
    | "next_element"
    | "previous_element"
    | "activate"
    | "type"
    | "read_focused"
    | "list_landmarks"
    | "go_back"
    | "wait";
  text?: string;
  count?: number;
}

/** Serialized in-page describer for the focused element (runs in the browser). */
const DESCRIBE_FOCUSED = `() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) {
    return { none: true };
  }
  const labelFor = (e) => {
    if (e.getAttribute('aria-label')) return e.getAttribute('aria-label').trim();
    const lb = e.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean);
      if (parts.length) return parts.map(p => (p.innerText || p.textContent || '').trim()).join(' ');
    }
    if (e.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
      if (lab) return (lab.innerText || lab.textContent || '').trim();
    }
    const wrap = e.closest('label');
    if (wrap) return (wrap.innerText || wrap.textContent || '').trim();
    if (e.getAttribute('alt')) return e.getAttribute('alt').trim();
    if (e.getAttribute('title')) return e.getAttribute('title').trim();
    const txt = (e.innerText || e.textContent || '').trim();
    if (txt) return txt.slice(0, 120);
    if (e.getAttribute('placeholder')) return '(placeholder) ' + e.getAttribute('placeholder').trim();
    return '';
  };
  const roleOf = (e) => {
    if (e.getAttribute('role')) return e.getAttribute('role');
    const t = e.tagName.toLowerCase();
    if (t === 'a') return e.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'button') return 'button';
    if (t === 'input') return (e.type === 'checkbox' || e.type === 'radio' || e.type === 'submit') ? e.type : 'textbox';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(t)) return 'heading level ' + t[1];
    return t;
  };
  // Does the focus ring actually render? Invisible focus is a real, reportable defect.
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth || '0') > 0;
  const ring = outline || (cs.boxShadow && cs.boxShadow !== 'none');
  const states = [];
  if (el.disabled) states.push('disabled');
  if (el.getAttribute('aria-disabled') === 'true') states.push('aria-disabled');
  if (el.checked) states.push('checked');
  if (el.getAttribute('aria-expanded')) states.push('expanded=' + el.getAttribute('aria-expanded'));
  if (el.required || el.getAttribute('aria-required') === 'true') states.push('required');
  if (el.value) states.push('value="' + String(el.value).slice(0, 60) + '"');
  return {
    none: false,
    role: roleOf(el),
    name: labelFor(el),
    tag: el.tagName.toLowerCase(),
    states,
    focusVisible: !!ring,
  };
}`;

const LIST_LANDMARKS = `() => {
  const out = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="navigation"],nav,main,[role="main"],form,[role="search"]').forEach(e => {
    const t = (e.innerText || e.textContent || '').trim().slice(0, 80);
    const kind = /^h[1-6]$/i.test(e.tagName) ? 'heading ' + e.tagName.toLowerCase() : (e.getAttribute('role') || e.tagName.toLowerCase());
    if (t) out.push(kind + ': ' + t.replace(/\\s+/g, ' '));
  });
  return out.slice(0, 40);
}`;

export class A11yBrowser {
  private context!: BrowserContext;
  page!: Page;

  async launch(url: string, headless: boolean): Promise<void> {
    const browser = await sharedBrowser(headless);
    this.context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    this.page = await this.context.newPage();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  /** The whole page as an ARIA tree — what a screen reader can survey. */
  async snapshot(): Promise<string> {
    try {
      const yaml = await this.page.locator("body").ariaSnapshot();
      if (yaml && yaml.trim()) return yaml.slice(0, 6000);
    } catch {
      /* fall through to the landmark summary */
    }
    // Fallback: at least give the structural skeleton a screen-reader user navigates by.
    try {
      const marks = (await this.page.evaluate(`(${LIST_LANDMARKS})()`)) as string[];
      return marks.length ? marks.join("\n") : "(page exposes no accessible structure)";
    } catch {
      return "(accessibility tree unavailable)";
    }
  }

  async describeFocused(): Promise<string> {
    // Wrapped in an IIFE: page.evaluate given a bare function string returns the
    // function itself (unserializable → undefined), not its result.
    const d = (await this.page.evaluate(`(${DESCRIBE_FOCUSED})()`)) as {
      none: boolean;
      role?: string;
      name?: string;
      tag?: string;
      states?: string[];
      focusVisible?: boolean;
    };
    if (d.none) return "Nothing is focused — you are at the top of the document.";
    const name = d.name && d.name.length ? `"${d.name}"` : "(NO ACCESSIBLE NAME — unlabelled)";
    const states = d.states && d.states.length ? ` [${d.states.join(", ")}]` : "";
    const ring = d.focusVisible ? "" : " [NO VISIBLE FOCUS INDICATOR]";
    return `Focused: ${d.role} ${name}${states}${ring}`;
  }

  /** Executes one screen-reader action; returns what the user would perceive. */
  async execute(input: A11yAction): Promise<string> {
    const { page } = this;
    switch (input.action) {
      case "read_screen":
        return `Accessibility tree:\n${await this.snapshot()}`;
      case "read_focused":
        return this.describeFocused();
      case "next_element":
      case "previous_element": {
        const times = Math.min(Math.max(input.count ?? 1, 1), 15);
        const key = input.action === "next_element" ? "Tab" : "Shift+Tab";
        const seen: string[] = [];
        for (let i = 0; i < times; i++) {
          await page.keyboard.press(key);
          await page.waitForTimeout(80);
          seen.push(await this.describeFocused());
        }
        return times === 1 ? seen[0] : seen.map((s, i) => `${i + 1}. ${s}`).join("\n");
      }
      case "activate": {
        const before = page.url();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
        const moved = page.url() !== before;
        return `Pressed Enter.${moved ? " The page navigated." : ""} Now: ${await this.describeFocused()}`;
      }
      case "type":
        await page.keyboard.type(input.text ?? "", { delay: 20 });
        return `Typed "${(input.text ?? "").slice(0, 40)}". ${await this.describeFocused()}`;
      case "list_landmarks": {
        const marks = (await page.evaluate(`(${LIST_LANDMARKS})()`)) as string[];
        return marks.length
          ? `Landmarks and headings:\n${marks.map((m) => `- ${m}`).join("\n")}`
          : "No headings or landmarks found — this page gives a screen-reader user no structure to navigate by.";
      }
      case "go_back":
        await page.goBack().catch(() => {});
        await page.waitForTimeout(400);
        return `Went back. ${await this.describeFocused()}`;
      case "wait":
        await page.waitForTimeout(1000);
        return "Waited.";
      default:
        return `Unsupported action: ${(input as A11yAction).action}`;
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
  }
}
