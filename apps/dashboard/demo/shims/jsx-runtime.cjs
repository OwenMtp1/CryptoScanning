// Automatic JSX runtime on top of the React 18 UMD global (cdnjs).
var R = window.React;
function create(type, props, key, isStatic) {
  var p = {};
  var children;
  for (var k in props) {
    if (k === "children") children = props.children;
    else p[k] = props[k];
  }
  if (key !== undefined) p.key = key;
  if (children === undefined) return R.createElement(type, p);
  if (isStatic && Array.isArray(children)) return R.createElement.apply(null, [type, p].concat(children));
  return R.createElement(type, p, children);
}
exports.jsx = function (t, p, k) { return create(t, p, k, false); };
exports.jsxs = function (t, p, k) { return create(t, p, k, true); };
exports.jsxDEV = exports.jsx;
exports.Fragment = R.Fragment;
