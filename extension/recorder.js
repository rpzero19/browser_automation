// Injected into the tab being recorded (again after every page load).
// Turns the user's clicks, typing and choices into steps and sends them to background.js.
// Password and file fields are never recorded.
(() => {
  if (window.__baRec) return window.__baRec.on();

  const ACTIONABLE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],' +
    '[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=tab],[role=checkbox],[role=radio],' +
    '[role=switch],[role=treeitem],[onclick]';
  const ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'title'];
  const NOT_TEXT = /^(checkbox|radio|submit|button|reset|image|file|hidden|range|color|password)$/;

  let active = true;
  let banner = null;
  const lastValue = new WeakMap();

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const short = (s) => (s.length > 40 ? s.slice(0, 39) + '…' : s);
  // ids/classes like "ember123", ":r5:", "a8f3c2d1" change between visits, so never rely on them
  const generated = (v) => /\d{4,}|[0-9a-f]{8,}|^:|^(ember|ext-|react|mui-|radix-|headlessui|rc_)/i.test(v);
  const quote = (v) => `"${v.replace(/["\\]/g, '\\$&')}"`;
  const isUnique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };
  const isTextField = (el) =>
    (el.localName === 'input' && !NOT_TEXT.test(el.type)) || el.localName === 'textarea';

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.id && !generated(n.id) && isUnique('#' + CSS.escape(n.id))) {
        parts.unshift('#' + CSS.escape(n.id));
        return parts.join(' > ');
      }
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) i++;
      parts.unshift(`${n.localName}:nth-of-type(${i})`);
    }
    return ['body', ...parts].join(' > ');
  }

  // Text of a <label>, without the text of the field inside it (a <select>'s options, for example).
  function labelText(label) {
    if (!label) return '';
    const copy = label.cloneNode(true);
    copy.querySelectorAll('input,select,textarea').forEach((f) => f.remove());
    return norm(copy.textContent);
  }

  function labelOf(el) {
    const isField = /^(input|select|textarea)$/.test(el.localName);
    return short(
      norm(el.getAttribute('aria-label')) ||
      labelText(el.labels?.[0]) ||
      norm(el.getAttribute('placeholder')) ||
      norm(el.getAttribute('title')) ||
      (isField ? '' : norm(el.innerText)) ||
      norm(el.getAttribute('name')) ||
      (el.type === 'submit' || el.type === 'button' ? norm(el.value) : '') ||
      el.localName,
    );
  }

  function target(el) {
    const tag = el.localName;
    const css = [];
    if (el.id && !generated(el.id)) {
      const s = '#' + CSS.escape(el.id);
      if (isUnique(s)) css.push(s);
    }
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || v.length > 80 || (a !== 'name' && generated(v))) continue;
      const s = `${tag}[${a}=${quote(v)}]`;
      if (isUnique(s)) css.push(s);
    }
    if (tag === 'a') {
      const h = el.getAttribute('href');
      if (h && h.length < 120 && !h.startsWith('javascript:')) {
        const s = `a[href=${quote(h)}]`;
        if (isUnique(s)) css.push(s);
      }
    }
    const text = /^(input|select|textarea)$/.test(tag) ? '' : norm(el.innerText);
    return { css, text: text.length <= 80 ? text : '', tag, path: cssPath(el), label: labelOf(el) };
  }

  function send(step) {
    if (!active) return;
    try { chrome.runtime.sendMessage({ type: 'rec-step', step }).catch(() => {}); } catch {}
  }

  function editableRoot(el) {
    while (el.parentElement?.isContentEditable) el = el.parentElement;
    return el;
  }

  function recordValue(el) {
    const value = el.isContentEditable ? el.innerText : el.value;
    if (lastValue.get(el) === value) return;
    lastValue.set(el, value);
    send({ type: 'input', target: target(el), value });
  }

  function onClick(e) {
    if (!active || !e.isTrusted || !(e.target instanceof Element) || banner?.contains(e.target)) return;
    const el = e.target.closest(ACTIONABLE) || e.target;
    if (el.localName === 'select' || el.localName === 'option' || isTextField(el)) return;
    if (el.localName === 'input' && /^(checkbox|radio|password|file)$/.test(el.type)) return; // recorded on change
    if (el.localName === 'label' && el.control && /^(checkbox|radio|file)$/.test(el.control.type)) return;
    if (el.isContentEditable) return;
    send({ type: 'click', target: target(el) });
  }

  // Untrusted change events count too: custom widgets (date pickers etc.) set a field from script.
  function onChange(e) {
    if (!active || !(e.target instanceof Element)) return;
    const el = e.target;
    if (el.localName === 'select') {
      send({ type: 'select', target: target(el), value: el.value, optionText: norm(el.selectedOptions[0]?.text) });
    } else if (el.localName === 'input' && /^(checkbox|radio)$/.test(el.type)) {
      send({ type: 'check', target: target(el), checked: el.checked });
    } else if (isTextField(el)) {
      recordValue(el);
    }
  }

  function onKey(e) {
    if (!active || !e.isTrusted || e.key !== 'Enter' || e.isComposing || !(e.target instanceof Element)) return;
    let el = e.target;
    if (el.localName === 'input' && isTextField(el)) {
      recordValue(el);
    } else if (el.isContentEditable) {
      el = editableRoot(el);
      recordValue(el);
    } else {
      return;
    }
    send({ type: 'key', key: 'Enter', target: target(el) });
  }

  function onFocusOut(e) {
    if (!active || !(e.target instanceof Element) || !e.target.isContentEditable) return;
    recordValue(editableRoot(e.target));
  }

  function showBanner() {
    banner = document.createElement('div');
    banner.textContent = '● Recording';
    Object.assign(banner.style, {
      position: 'fixed', top: '8px', right: '8px', zIndex: '2147483647', background: '#d93025', color: '#fff',
      font: '600 12px system-ui, sans-serif', padding: '4px 10px', borderRadius: '12px', pointerEvents: 'none', opacity: '0.9',
    });
    document.documentElement.appendChild(banner);
  }

  window.__baRec = {
    on() {
      active = true;
      if (!banner?.isConnected) showBanner();
    },
    off() {
      active = false;
      banner?.remove();
    },
  };
  addEventListener('click', onClick, true);
  addEventListener('change', onChange, true);
  addEventListener('keydown', onKey, true);
  addEventListener('focusout', onFocusOut, true);
  showBanner();
})();
