// Compiles uBO/AdGuard procedural cosmetic selectors into a JSON step list that
// the content script executes. Example:
//   div.post:has-text(/sponsored/i):upward(2)
//   -> [["css","div.post"],["has-text","/sponsored/i"],["upward","2"]]
//
// Step types:
//   css <sel>            initial document.querySelectorAll
//   rel <sel>            relative query from each element (" > .x", " .x", "+ .x")
//   filter <sel>         keep elements matching <sel>
//   has <steps>          keep elements for which <steps> (relative) matches something
//   not <steps>          inverse of has
//   has-text <pattern>   textContent contains text or matches /regex/
//   upward <n|sel>       nth ancestor or closest ancestor matching sel
//   matches-css <arg>    computed style test ("prop: value" or "prop: /re/")
//   matches-css-before / matches-css-after
//   min-text-length <n>
//   matches-attr <arg>   attribute name/value test (text or /re/)
//   matches-path <pat>   page path test
//   matches-media <q>    media query test
//   xpath <expr>
//   noop                 (watch-attr etc.)

const OPS = new Set([
  'has-text', 'contains', '-abp-contains', 'upward', 'nth-ancestor', 'xpath', 'matches-css',
  'matches-css-before', 'matches-css-after', 'min-text-length', 'matches-attr', 'matches-path',
  'watch-attr', '-abp-has', 'if', 'if-not', 'matches-media', 'others',
]);
const CONTAINERS = new Set(['has', 'not', '-abp-has', 'if', 'if-not']);

function skipString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
  return j + 1;
}

export function findClosing(s, open) {
  // s[open] is '(' or '['; returns index of the matching closer
  const closeCh = s[open] === '(' ? ')' : ']';
  const openCh = s[open];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      // Strings only matter inside attribute selectors and quoted args
      i = skipString(s, i) - 1;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced');
}

// Regex arguments may contain unbalanced parentheses inside /.../, so read raw
// until the matching ')' while treating /.../ as opaque.
function findArgEnd(s, open) {
  if (s[open + 1] === '/') {
    // regex argument: find "/flags)" closing
    for (let i = open + 2; i < s.length; i++) {
      if (s[i] === '\\') {
        i++;
        continue;
      }
      if (s[i] === '/') {
        const m = /^\/[a-z]*\)/.exec(s.slice(i));
        if (m) return i + m[0].length - 1;
      }
    }
  }
  return findClosing(s, open);
}

export function containsProcedural(sel) {
  const re = /:([a-z-]+)\(/g;
  let m;
  while ((m = re.exec(sel))) if (OPS.has(m[1])) return true;
  return false;
}

function unquote(s) {
  const t = s.trim();
  const m = /^(['"])(.*)\1$/.exec(t);
  return m ? m[2] : t;
}

function makeStep(op, arg) {
  switch (op) {
    case 'has-text':
    case 'contains':
    case '-abp-contains':
      return ['has-text', unquote(arg)];
    case 'upward':
    case 'nth-ancestor': {
      const a = arg.trim();
      if (/^\d+$/.test(a)) {
        const n = Number(a);
        if (n < 1 || n > 256) throw new Error('upward range');
        return ['upward', n];
      }
      return ['upward', a];
    }
    case 'min-text-length':
      return ['min-text-length', Number(arg.trim()) || 0];
    case 'matches-css':
    case 'matches-css-before':
    case 'matches-css-after':
      return [op, arg.trim()];
    case 'matches-attr':
    case 'matches-path':
    case 'matches-media':
    case 'xpath':
      return [op, unquote(arg)];
    case 'watch-attr':
    case 'others':
      return ['noop'];
    case 'has':
    case '-abp-has':
    case 'if':
      return ['has', parseSteps(arg, false)];
    case 'not':
    case 'if-not':
      return ['not', parseSteps(arg, false)];
    default:
      throw new Error(`unsupported op ${op}`);
  }
}

function parseSteps(sel, root) {
  const steps = [];
  let i = 0;
  let cssStart = 0;
  const flush = (end) => {
    const css = sel.slice(cssStart, end);
    if (!css.trim()) return;
    if (steps.length === 0) steps.push(root ? ['css', css.trim()] : ['rel', css.trim()]);
    else if (/^\s*[>+~]/.test(css) || /^\s/.test(css)) steps.push(['rel', css.trim()]);
    else steps.push(['filter', css.trim()]);
  };
  while (i < sel.length) {
    const c = sel[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(sel, i);
      continue;
    }
    if (c === '[') {
      i = findClosing(sel, i) + 1;
      continue;
    }
    if (c === ':') {
      const m = /^:(-?[a-z-]+)\(/.exec(sel.slice(i));
      if (m) {
        const op = m[1];
        const open = i + m[0].length - 1;
        const close = findArgEnd(sel, open);
        const arg = sel.slice(open + 1, close);
        if (OPS.has(op) || (CONTAINERS.has(op) && containsProcedural(arg))) {
          flush(i);
          if (steps.length === 0 && root && op !== 'xpath') steps.push(['css', '*']);
          steps.push(makeStep(op, arg));
          i = close + 1;
          cssStart = i;
          continue;
        }
        i = close + 1;
        continue;
      }
    }
    if (c === '(') {
      i = findClosing(sel, i) + 1;
      continue;
    }
    i++;
  }
  flush(sel.length);
  if (!steps.length) throw new Error('empty');
  return steps;
}

export function compileProcedural(selector) {
  try {
    return parseSteps(selector.trim(), true);
  } catch {
    return null;
  }
}
