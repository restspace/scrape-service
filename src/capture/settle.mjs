// The anti-lazy-load ritual, lifted from the pipeline's crawl.mjs.
//
// This is the least obvious and most valuable code in the crawler. Sites using
// LiteSpeed Cache or WP Rocket's "delay JS until user interaction" never boot
// their scripts in a headless browser, because those scripts wait for a real
// mousemove/wheel/keydown. Without this, gallery and team images simply never
// enter the DOM and the capture silently under-reports the site's imagery.
//
// Playwright's input events are trusted, so they satisfy that wait. The scroll
// pass then triggers intersection-observer lazy loading, and the final settle
// gives late-booting scripts time to render before extraction.

/**
 * Detect the delayed-JS script tags the major cache plugins emit. Pages that
 * have them need materially longer settles, so this is worth knowing up front.
 */
export async function hasDelayedJs(page) {
  return page
    .evaluate(() => !!document.querySelector('script[type="litespeed/javascript"], script[data-litespeed-src], script[type="rocketlazyloadscripts"]'))
    .catch(() => false);
}

/**
 * Boot delayed JS, scroll the full page to trigger lazy loading, then return to
 * the top and settle. Returns whether the page used delayed JS, which the caller
 * records. Never throws: a crashed or closed page degrades to a partial settle
 * rather than failing the whole page capture.
 */
export async function settlePage(page) {
  await page.waitForTimeout(600);

  // fire TRUSTED user-input events first: LiteSpeed Cache-style "delay JS until user
  // interaction" never boots headless otherwise (gallery scripts wait for a real
  // mousemove/wheel/keydown, so gallery images never enter the DOM without this)
  const hadDelayedJs = await hasDelayedJs(page);
  try {
    await page.mouse.move(200, 200);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 200);
    await page.keyboard.press('Shift'); // safe key: cannot submit forms or type into inputs
  } catch { /* crashed/closed page — scroll pass below may still work */ }

  // let the freshly-booted delayed scripts render (Elementor galleries etc.) before
  // the scroll pass, so their lazy observers exist while we scroll past them
  if (hadDelayedJs) await page.waitForTimeout(1500);

  await page.evaluate(async () => {
    await new Promise((res) => {
      let y = 0; const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
      const t = setInterval(() => { window.scrollBy(0, step); y += step; if (y >= document.body.scrollHeight + window.innerHeight) { clearInterval(t); res(); } }, 80);
      setTimeout(() => { clearInterval(t); res(); }, 8000);
    });
    window.scrollTo(0, 0);
  }).catch(() => {});

  // delayed-JS boot may only start fetching after the interaction + scroll pass —
  // give late network activity a moment, then re-settle at the top before extracting
  // (note: waitForLoadState resolves instantly if already idle, hence the extra
  // fixed settle on delayed-JS pages whose galleries render seconds after boot)
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(hadDelayedJs ? 2000 : 500);

  return hadDelayedJs;
}
