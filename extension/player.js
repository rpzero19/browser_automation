// Replays one step inside the page. background.js injects this function with
// chrome.scripting.executeScript, so it must not use anything from outside its own body.
// Returns { ok: true } or { ok: false, error }.
export async function playStep(step, timeoutMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const t = step.target || {};
  // Only clicks and key presses need the element on screen; form fields may be visually hidden (custom checkboxes).
  const mustSee = step.type === 'click' || step.type === 'key';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const query = (sel) => {
    try {
      const all = [...document.querySelectorAll(sel)];
      return mustSee ? all.filter(visible) : all;
    } catch {
      return [];
    }
  };
  const textOf = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label'));
  const innermost = (els) => els.filter((e) => !els.some((o) => o !== e && e.contains(o)));

  function find() {
    // 1. selectors that were unique when recorded (id, name, aria-label, href...)
    for (const sel of t.css || []) {
      const els = query(sel);
      if (els.length === 1) return els[0];
      if (els.length > 1 && t.text) {
        const m = els.find((e) => textOf(e) === t.text);
        if (m) return m;
      }
    }
    // 2. same kind of element with the same visible text ("Download CSV")
    if (t.text) {
      const els = innermost(query(t.tag || '*').filter((e) => textOf(e) === t.text));
      if (els.length) return els[0];
    }
    // 3. position in the page (breaks most easily, so last)
    if (t.path) {
      const els = query(t.path);
      if (els.length) return els[0];
    }
    for (const sel of t.css || []) {
      const els = query(sel);
      if (els.length) return els[0];
    }
    return null;
  }

  const end = Date.now() + timeoutMs;
  let el = find();
  while (!el || (step.type === 'click' && el.disabled)) {
    if (Date.now() > end) {
      const what = t.label ? `"${t.label}"` : 'the element';
      return { ok: false, error: el ? `${what} stayed disabled` : `could not find ${what} on ${location.origin}${location.pathname}` };
    }
    await sleep(250);
    el = find();
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });

  const fire = (type, Ctor = MouseEvent) =>
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
  const setValue = (v) => {
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, v);
      return;
    }
    // Use the built-in setter so frameworks like React notice the change.
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc?.set) desc.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  switch (step.type) {
    case 'click':
      fire('pointerover', PointerEvent);
      fire('mouseover');
      fire('pointerdown', PointerEvent);
      fire('mousedown');
      el.focus?.();
      fire('pointerup', PointerEvent);
      fire('mouseup');
      el.click();
      break;
    case 'input':
      el.focus?.();
      setValue(step.value ?? '');
      break;
    case 'select': {
      const opts = [...el.options];
      const opt = opts.find((o) => o.value === step.value) || opts.find((o) => norm(o.text) === step.optionText);
      if (!opt) return { ok: false, error: `option "${step.optionText || step.value}" not found` };
      setValue(opt.value);
      break;
    }
    case 'check':
      if (el.checked !== step.checked) el.click();
      break;
    case 'key': {
      const init = { key: step.key, code: step.key, keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.focus?.();
      const notHandled = el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keypress', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      // A synthetic Enter does not submit a form by itself, so do what the browser would have done.
      if (notHandled && step.key === 'Enter' && el.form) el.form.requestSubmit();
      break;
    }
    default:
      return { ok: false, error: `unknown step type ${step.type}` };
  }
  return { ok: true };
}
