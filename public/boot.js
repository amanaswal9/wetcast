// Runs before the page is drawn (a plain script in <head>, not a module), so there is no flash
// of the wrong theme. A separate file rather than inline, so the site's security policy can
// forbid inline scripts altogether.

// Theme: a saved choice wins; on a first visit, a device set to dark gets the night theme.
try {
  var saved = localStorage.getItem('weatherai.theme')
  var theme = saved === 'light' || saved === 'night' || saved === 'dark' ? saved
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'light'
  document.documentElement.dataset.theme = theme
  var bar = { light: '#000080', night: '#1f4e8c', dark: '#800080' }[theme]
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bar)
} catch (e) {
  void e // old-style catch on purpose: this file must parse on old browsers too
  document.documentElement.dataset.theme = 'light'
}

// Pixel-exact bevels: make --px a whole number of screen pixels (see :root in index.css),
// and update it when the browser zoom or the screen changes.
;(function sharpPixels() {
  var dpr = window.devicePixelRatio || 1
  document.documentElement.style.setProperty('--px', Math.max(1, Math.round(dpr)) / dpr + 'px')
  if (window.matchMedia) {
    window.matchMedia('(resolution: ' + dpr + 'dppx)').addEventListener('change', sharpPixels, { once: true })
  }
})()
