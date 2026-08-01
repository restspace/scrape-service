// Chromium lifecycle. One launch per job; contexts per surface.
//
// The desktop User-Agent changes from the original 'WebsiteReconstructionBot/1.0'
// to a UA carrying a contact URL. Same intent — identify honestly — but a server
// crawling third-party sites should say who to complain to.

import { chromium, devices } from 'playwright';

export const DESKTOP_VIEWPORT = { width: 1366, height: 900 };

export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

export async function makeDesktopContext(browser, { userAgent, ignoreHTTPSErrors = false }) {
  return browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    userAgent,
    ignoreHTTPSErrors,
  });
}

/**
 * iPhone 13 emulation, as the original used. `ignoreHTTPSErrors` is exposed
 * because the scan path deliberately tolerates bad certificates — a broken
 * certificate is a scored signal there, not a reason to abandon the site.
 */
export async function makeMobileContext(browser, { ignoreHTTPSErrors = false } = {}) {
  return browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors });
}

export async function chromiumVersion() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    return browser.version();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
