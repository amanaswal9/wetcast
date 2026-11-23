// Shows a clear message instead of a blank page on browsers the app can't run in (older than
// Safari 16.4, Chrome or Edge 111, Firefox 128). Runs at the end of <body>, as a separate file
// so the site's security policy can forbid inline scripts; it avoids eval for the same reason.
;(function () {
  var ok = true
  // Lookbehind in regular expressions arrived in Safari 16.4, the oldest Safari the app supports.
  try {
    new RegExp('(?<=a)b')
  } catch (e) {
    void e // old-style catch on purpose: this file must parse on old browsers too
    ok = false
  }
  // color-mix() in CSS: Chrome and Edge 111, Firefox 113.
  if (!(window.CSS && CSS.supports && CSS.supports('color', 'color-mix(in srgb, red, blue)'))) ok = false
  // CSS.registerProperty (registered custom properties, which Tailwind uses): Firefox 128, Safari 16.4, Chrome 78.
  if (!(window.CSS && typeof CSS.registerProperty === 'function')) ok = false
  if (!ok) document.getElementById('unsupported').hidden = false
})()
