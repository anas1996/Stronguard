// Element picker: hover to highlight, click to select, then hide it permanently
// (saved as a cosmetic filter for this site) or just remove it once.
// Injected on demand into the isolated world.

(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  if (globalThis.__stronguardPicker) {
    globalThis.__stronguardPicker.stop();
    return;
  }

  const host = document.createElement('stronguard-picker');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #ff3b5c;
             background: rgba(255,59,92,.18); border-radius: 3px; transition: all .04s linear; }
      .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(440px, calc(100vw - 32px));
               font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #e8eef6;
               background: #0f1722; border: 1px solid #2b3a4f; border-radius: 12px; padding: 12px;
               box-shadow: 0 12px 40px rgba(0,0,0,.45); }
      .title { font-weight: 700; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
      .hint { color: #9fb0c6; font-size: 12px; margin-bottom: 8px; }
      textarea { width: 100%; box-sizing: border-box; min-height: 52px; resize: vertical; background: #08101a; color: #e8eef6;
                 border: 1px solid #2b3a4f; border-radius: 8px; padding: 8px; font: 12px ui-monospace, Consolas, monospace; }
      .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      button { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; background: #1c2a3c; color: #e8eef6; font-weight: 600; }
      button:hover { background: #26384f; }
      button.primary { background: #ff3b5c; color: #fff; }
      button.primary:hover { background: #ff5875; }
      .count { color: #9fb0c6; font-size: 12px; margin-left: auto; align-self: center; }
    </style>
    <div class="box" hidden></div>
    <div class="panel">
      <div class="title"><span>Stronguard element picker</span><button data-act="cancel" title="Esc">✕</button></div>
      <div class="hint">Hover and click the element to block. Use ↑ to widen to its parent. Esc to quit.</div>
      <textarea spellcheck="false" placeholder="Click an element on the page"></textarea>
      <div class="row">
        <button data-act="parent">↑ Parent</button>
        <button data-act="child">↓ Child</button>
        <button data-act="once">Remove once</button>
        <button class="primary" data-act="save">Hide permanently</button>
        <span class="count"></span>
      </div>
    </div>`;
  const box = root.querySelector('.box');
  const panel = root.querySelector('.panel');
  const field = root.querySelector('textarea');
  const count = root.querySelector('.count');
  document.documentElement.appendChild(host);

  let hovered = null;
  let selected = null;
  let trail = [];

  const randomish = (s) => /\d{4,}|[a-f0-9]{8,}|^[a-z]{1,2}\d|__|--[a-z0-9]{5,}$/i.test(s) || s.length > 40;
  const esc = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'));

  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  function part(el) {
    if (el.id && !randomish(el.id)) return `#${esc(el.id)}`;
    let s = el.tagName.toLowerCase();
    const classes = [...el.classList].filter((c) => !randomish(c)).slice(0, 3);
    if (classes.length) s += classes.map((c) => `.${esc(c)}`).join('');
    return s;
  }

  function selectorFor(el) {
    const first = part(el);
    if (first.startsWith('#') && unique(first)) return first;
    if (unique(first)) return first;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && cur !== document.documentElement && depth < 6; depth++) {
      let p = part(cur);
      const parent = cur.parentElement;
      if (parent && !p.startsWith('#')) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(p);
      const sel = parts.join(' > ');
      if (p.startsWith('#') || unique(sel)) return sel;
      cur = parent;
    }
    return parts.join(' > ');
  }

  function frame(el) {
    if (!el) {
      box.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.hidden = false;
  }

  function updateCount() {
    try {
      const n = document.querySelectorAll(field.value.trim()).length;
      count.textContent = `${n} element${n === 1 ? '' : 's'}`;
    } catch (e) {
      count.textContent = 'invalid selector';
    }
  }

  function select(el) {
    selected = el;
    field.value = selectorFor(el);
    frame(el);
    updateCount();
  }

  const targetAt = (x, y) => document.elementsFromPoint(x, y).find((e) => e !== host && !host.contains(e)) || null;

  function onMove(ev) {
    if (selected) return;
    const el = targetAt(ev.clientX, ev.clientY);
    if (el && el !== hovered) {
      hovered = el;
      frame(el);
    }
  }

  function onClick(ev) {
    if (ev.composedPath().includes(host)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const el = targetAt(ev.clientX, ev.clientY);
    if (el) {
      trail = [];
      select(el);
    }
  }

  function block(ev) {
    if (ev.composedPath().includes(host)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') {
      stop();
      return;
    }
    if (!selected) return;
    if (ev.key === 'ArrowUp') act('parent');
    if (ev.key === 'ArrowDown') act('child');
  }

  function act(name) {
    if (name === 'cancel') return stop();
    if (name === 'parent' && selected && selected.parentElement && selected.parentElement !== document.body) {
      trail.push(selected);
      select(selected.parentElement);
    }
    if (name === 'child' && trail.length) select(trail.pop());
    const sel = field.value.trim();
    if (!sel) return;
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(sel)];
    } catch (e) {
      return;
    }
    if (name === 'once') {
      nodes.forEach((n) => n.remove());
      stop();
    }
    if (name === 'save') {
      nodes.forEach((n) => n.style.setProperty('display', 'none', 'important'));
      api.runtime.sendMessage({ t: 'picker:save', selector: sel, hostname: location.hostname });
      stop();
    }
  }

  panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (b) act(b.dataset.act);
  });
  field.addEventListener('input', () => {
    updateCount();
    try {
      frame(document.querySelector(field.value.trim()));
    } catch (e) {
      /* ignore */
    }
  });

  function stop() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick']) window.removeEventListener(t, block, true);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    delete globalThis.__stronguardPicker;
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick']) window.addEventListener(t, block, true);
  window.addEventListener('keydown', onKey, true);
  globalThis.__stronguardPicker = { stop };
})();
