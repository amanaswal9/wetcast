// Lighthouse CI for Wetcast. Runs the production build (dist/) on a phone profile, three times per
// page, and checks the scores (see below). Reports are written to ./reports, never uploaded anywhere.
//
// CI has no backend, so the /api calls fail and the console logs those failures: that check is off.
// Weather comes live from Open-Meteo, and the biggest text on the Dashboard and Forecast waits for it,
// so the timings only warn. Each score is a page's best of its three runs (Lighthouse CI's default).
// Performance floor 0.85 (2026-11-24): every page scored 0.92 or more on CI after the move to Preact,
// and 0.81-0.89 before it, so a slide back to the old speed fails the build.
module.exports = {
  ci: {
    collect: {
      staticDistDir: '../../dist',
      url: [
        'http://localhost/#/dashboard',
        'http://localhost/#/forecast',
        'http://localhost/#/about',
        'http://localhost/mini/',
      ],
      numberOfRuns: 3,
      settings: {
        // CI runs as root in a container, where Chromium's sandbox can't start.
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      assertions: {
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        'categories:seo': ['error', { minScore: 0.9 }],
        'categories:performance': ['error', { minScore: 0.85 }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 3000 }],
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['warn', { maxNumericValue: 300 }],
        'errors-in-console': 'off',
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './reports',
    },
  },
}
