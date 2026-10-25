// Step shapes (recorded by recorder.js, replayed by player.js):
//   { type: 'click',  target }
//   { type: 'input',  target, value }
//   { type: 'select', target, value, optionText }
//   { type: 'check',  target, checked }
//   { type: 'key',    target, key }
//   { type: 'navigate', url }
//   { type: 'wait', seconds }
// target = { css: [unique selectors], text, tag, path, label }

export function describeStep(s) {
  const what = s.target?.label ? `"${s.target.label}"` : s.target?.tag || 'element';
  switch (s.type) {
    case 'click': return `Click ${what}`;
    case 'input': return `Type "${s.value}" into ${what}`;
    case 'select': return `Choose "${s.optionText || s.value}" in ${what}`;
    case 'check': return `${s.checked ? 'Tick' : 'Untick'} ${what}`;
    case 'key': return `Press ${s.key} in ${what}`;
    case 'navigate': return `Go to ${s.url}`;
    case 'wait': return `Wait ${s.seconds} s`;
  }
  return s.type;
}

export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
