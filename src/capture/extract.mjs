// The single in-page extractor.
//
// The pipeline previously carried two copies of this: the full one in crawl.mjs
// and a trimmed clone in scan.mjs that dropped images, blocks, the a11y tree and
// readable text. They drifted. Here there is one function and a capability set —
// a deep crawl asks for everything, a shallow scan asks for less.
//
// This function is serialised and evaluated inside the browser, so it must be
// entirely self-contained: no imports, no closure over module scope. The
// capability set arrives as page.evaluate's single argument.
//
// Parity note: with all capabilities enabled the output must be byte-identical
// to what the original crawl.mjs produced. Every gate below is written so that
// the enabled branch is the original code, untouched.

/** Everything on — what a deep crawl asks for, and the parity baseline. */
export const FULL_CAPABILITIES = {
  images: true,
  blocks: true,
  readable: true,
  accessibilityTree: true,
  visibleTextLimit: 600,
  visibleTextBoundingBox: true,
};

/**
 * What a shallow scan needs: enough to score a site, none of the heavy trees.
 *
 * The two numeric differences are not arbitrary — the scan's copy of this
 * extractor capped visible text at 400 nodes and omitted bounding boxes. Those
 * are carried here deliberately so unifying the two copies does not silently
 * change the artefacts `signals.mjs` reads downstream.
 */
export const SCAN_CAPABILITIES = {
  images: false,
  blocks: false,
  readable: false,
  accessibilityTree: false,
  visibleTextLimit: 400,
  visibleTextBoundingBox: false,
};

export function extractInPage(caps) {
  const want = Object.assign(
    {
      images: true,
      blocks: true,
      readable: true,
      accessibilityTree: true,
      visibleTextLimit: 600,
      visibleTextBoundingBox: true,
    },
    caps || {},
  );

  const cssPath = (el) => {
    if (!(el instanceof Element)) return null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let sel = node.nodeName.toLowerCase();
      if (node.id) {
        sel = `${sel}#${node.id}`;
        parts.unshift(sel);
        break;
      }
      const parent = node.parentNode;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.nodeName === node.nodeName);
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(' > ');
  };

  const regionOf = (el) => {
    let n = el;
    while (n) {
      const tag = n.nodeName ? n.nodeName.toLowerCase() : '';
      const role = n.getAttribute ? n.getAttribute('role') : null;
      if (tag === 'header' || role === 'banner') return 'header';
      if (tag === 'nav' || role === 'navigation') return 'navigation';
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (tag === 'main' || role === 'main') return 'main';
      if (tag === 'aside') return 'aside';
      n = n.parentElement;
    }
    return 'body';
  };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };

  // headings
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter(visible)
    .map((h) => ({ level: +h.nodeName[1], text: h.textContent.trim().slice(0, 300), selector: cssPath(h) }))
    .filter((h) => h.text);

  // links
  const origin = location.origin;
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => {
      const href = a.href;
      let type = 'internal';
      if (href.startsWith('mailto:')) type = 'email';
      else if (href.startsWith('tel:')) type = 'phone';
      else if (!href.startsWith(origin)) type = 'external';
      return {
        text: a.textContent.trim().slice(0, 160),
        href,
        type,
        selector: cssPath(a),
        appearsIn: regionOf(a),
      };
    })
    .filter((l) => l.href);

  // images — <img> (incl. lazy-load attrs + srcset) AND CSS background-image.
  // Page builders (WPBakery, Salient, etc.) often render team/hero photos as
  // background-image divs or lazy data-src, which a plain <img> scan misses.
  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const firstFromSrcset = (ss) => (ss || '').split(',')[0]?.trim().split(/\s+/)[0] || '';
  const seenSrc = new Set();
  const images = [];
  const pushImg = (src, o) => { const a = absUrl(src); if (!a || seenSrc.has(a)) return; seenSrc.add(a); images.push({ src: a, ...o }); };

  // NOTE: we do NOT guess an image's role/identity here — HTML is too varied for reliable
  // heuristics. Instead capture neutral DOM context so the LLM can judge later what each
  // image is (staff portrait, premises, logo, stock, icon…) and who/what it depicts.
  const clamp = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const ancestorClasses = (el, n = 3) => {
    const out = []; let node = el; let i = 0;
    while (node && node.nodeType === 1 && i < n) { const c = node.getAttribute && node.getAttribute('class'); if (c) out.push(clamp(c, 120)); node = node.parentElement; i++; }
    return out;
  };
  // Trimmed text of the smallest "card-like" ancestor (short text block) around the image —
  // this naturally contains a caption or person's name without us deciding which it is.
  const containerText = (el) => {
    let node = el.parentElement, i = 0;
    while (node && i < 4) { const t = clamp(node.innerText || node.textContent || '', 240); if (t) return t; node = node.parentElement; i++; }
    return '';
  };
  // Nearest preceding heading (section context).
  const nearestHeading = (el) => {
    let node = el;
    while (node && node !== document.body) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return clamp(sib.textContent, 120);
        const h = sib.querySelector && sib.querySelector('h1,h2,h3,h4,h5,h6');
        if (h) return clamp(h.textContent, 120);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  };
  const figcap = (el) => { const f = el.closest && el.closest('figure'); const c = f && f.querySelector('figcaption'); return c ? clamp(c.textContent, 160) : ''; };
  const linkNear = (el) => { const a = (el.closest && el.closest('a[href]')) || (el.parentElement && el.parentElement.querySelector && el.parentElement.querySelector('a[href]')); return a ? a.href : ''; };

  if (want.images) {
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || firstFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
      const r = img.getBoundingClientRect();
      pushImg(src, {
        alt: img.getAttribute('alt') || '',
        title: img.getAttribute('title') || '',
        width: img.naturalWidth || img.width || null,
        height: img.naturalHeight || img.height || null,
        selector: cssPath(img),
        region: regionOf(img),
        source: 'img',
        context: {
          containerClasses: ancestorClasses(img),
          containerText: containerText(img),
          nearestHeading: nearestHeading(img),
          figcaption: figcap(img),
          linkHref: linkNear(img),
          aboveFold: r.top < window.innerHeight && r.top >= 0,
        },
      });
    }
    // CSS background-image + common lazy-bg data attributes (cap to keep crawl bounded)
    const bgEls = document.querySelectorAll('[style*="background"], [class*="bg"], [data-bg], [data-bg-src], [data-background], [data-src], header, section, div, a, span, figure');
    let bgScanned = 0;
    for (const el of bgEls) {
      if (bgScanned > 1200) break; bgScanned++;
      const r = el.getBoundingClientRect();
      // ignore tiny decorative slivers — but only when small in BOTH dimensions:
      // JS galleries (e.g. Elementor) can report height 0 before layout settles,
      // yet their background-image URLs are real page imagery we must keep
      if (r.width < 40 && r.height < 40) continue;
      let url = el.getAttribute('data-bg') || el.getAttribute('data-bg-src') || el.getAttribute('data-background') || '';
      if (!url) { const bg = getComputedStyle(el).backgroundImage; const m = bg && bg.match(/url\((['"]?)(.*?)\1\)/i); if (m) url = m[2]; }
      if (!url || /^data:|^none$/i.test(url)) continue;
      pushImg(url, {
        alt: clamp(el.getAttribute('aria-label') || el.getAttribute('title') || '', 160),
        title: '',
        width: Math.round(r.width),
        height: Math.round(r.height),
        selector: cssPath(el),
        region: regionOf(el),
        source: 'background',
        context: {
          containerClasses: ancestorClasses(el),
          containerText: containerText(el),
          nearestHeading: nearestHeading(el),
          figcaption: figcap(el),
          linkHref: linkNear(el),
          aboveFold: r.top < window.innerHeight && r.top >= 0,
        },
      });
    }
  }

  // forms
  const forms = [...document.querySelectorAll('form')].map((f) => ({
    selector: cssPath(f),
    method: (f.getAttribute('method') || 'GET').toUpperCase(),
    action: f.getAttribute('action') || '',
    fields: [...f.querySelectorAll('input,textarea,select')]
      .filter((el) => el.type !== 'hidden')
      .map((el) => {
        let label = '';
        if (el.id) {
          const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lab) label = lab.textContent.trim();
        }
        if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
        return {
          name: el.name || '',
          label: label.slice(0, 120),
          type: el.tagName.toLowerCase() === 'textarea' ? 'textarea' : el.type || el.tagName.toLowerCase(),
          required: el.required || false,
        };
      }),
  }));

  // buttons / CTAs (buttons + link-buttons)
  const ctaSel = 'button, a.btn, a.button, a.cta, [class*="btn"], [role="button"]';
  const buttons = [...document.querySelectorAll(ctaSel)]
    .filter(visible)
    .slice(0, 60)
    .map((b) => {
      const r = b.getBoundingClientRect();
      return {
        text: b.textContent.trim().slice(0, 120),
        target: b.tagName.toLowerCase() === 'a' ? b.href : (b.getAttribute('formaction') || null),
        selector: cssPath(b),
        position: r.top < vh ? 'above_fold' : 'below_fold',
      };
    })
    .filter((b) => b.text);

  // structured data (JSON-LD)
  const structuredData = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      structuredData.push(parsed);
    } catch {
      /* skip invalid */
    }
  }

  // metadata
  const metaGet = (sel, attr = 'content') => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute(attr) : null;
  };
  const og = {};
  for (const m of document.querySelectorAll('meta[property^="og:"]')) og[m.getAttribute('property')] = m.content;
  const tw = {};
  for (const m of document.querySelectorAll('meta[name^="twitter:"]')) tw[m.getAttribute('name')] = m.content;

  const metadata = {
    title: document.title || null,
    metaDescription: metaGet('meta[name="description"]'),
    canonicalUrl: metaGet('link[rel="canonical"]', 'href'),
    robotsMeta: metaGet('meta[name="robots"]'),
    language: document.documentElement.getAttribute('lang') || null,
    openGraph: og,
    twitterCard: tw,
    // Declared icon links, for the scan path's favicon signal — "does the page
    // declare an icon at all", which is a different question from whether
    // /favicon.ico happens to resolve. `~=` matches the whitespace-separated
    // token, so `rel="shortcut icon"` counts and `rel="apple-touch-icon"` does
    // not, matching what signals.mjs records as its evidence.
    //
    // Appended last on purpose: the existing key order is what downstream
    // consumers and the parity fixtures were written against.
    iconLinks: [...document.querySelectorAll('link[rel~="icon"]')]
      .map((l) => l.getAttribute('href'))
      .filter(Boolean),
  };

  // visible text with order + fold + bbox
  const textNodes = [];
  let order = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const txt = node.textContent.replace(/\s+/g, ' ').trim();
    if (!txt || txt.length < 2) continue;
    const el = node.parentElement;
    if (!el || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    order++;
    // boundingBox is appended last so the serialised key order matches what the
    // original crawler wrote — these files are compared byte-for-byte.
    const entry = {
      text: txt.slice(0, 500),
      selector: cssPath(el),
      region: regionOf(el),
      pageOrder: order,
      aboveFold: r.top < vh,
    };
    if (want.visibleTextBoundingBox) {
      entry.boundingBox = { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) };
    }
    textNodes.push(entry);
    if (textNodes.length > want.visibleTextLimit) break;
  }

  // candidate blocks: semantic sections + heading-led containers
  let blocks = [];
  if (want.blocks) {
    const blockEls = new Set();
    document.querySelectorAll('header, nav, main > section, main > div, section, article, aside, footer').forEach((e) => {
      const r = e.getBoundingClientRect();
      if (r.height > 40 && r.width > 0) blockEls.add(e);
    });
    let blockIdx = 0;
    blocks = [...blockEls]
      .filter((e) => ![...blockEls].some((other) => other !== e && other.contains(e) && other.tagName === e.tagName))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .slice(0, 40)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const cards = e.querySelectorAll(':scope > * ').length;
        const cls = (e.className && typeof e.className === 'string' ? e.className : '').toLowerCase();
        blockIdx++;
        return {
          localId: `block.${String(blockIdx).padStart(3, '0')}`,
          selector: cssPath(e),
          tag: e.tagName.toLowerCase(),
          className: cls.slice(0, 200),
          region: regionOf(e),
          pageOrder: blockIdx,
          aboveFold: r.top < vh,
          rawText: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 1200),
          headings: [...e.querySelectorAll('h1,h2,h3,h4')].map((h) => h.textContent.trim().slice(0, 200)).filter(Boolean),
          links: [...e.querySelectorAll('a[href]')].slice(0, 20).map((a) => ({ text: a.textContent.trim().slice(0, 120), href: a.href })),
          imageCount: e.querySelectorAll('img').length,
          visualHints: {
            repeatedCards: (() => {
              const kids = [...e.children];
              const tags = {};
              kids.forEach((k) => (tags[k.tagName] = (tags[k.tagName] || 0) + 1));
              return Math.max(0, ...Object.values(tags).map((v) => (v >= 3 ? v : 0)));
            })(),
            horizontalScroll: getComputedStyle(e).overflowX === 'auto' || getComputedStyle(e).overflowX === 'scroll',
            hasCarouselControls: !!e.querySelector('[class*="carousel"],[class*="slider"],[class*="swiper"]'),
            hasMapEmbed: !!e.querySelector('iframe[src*="google.com/maps"],iframe[src*="maps"]'),
            hasForm: !!e.querySelector('form'),
          },
        };
      });
  }

  // readable text (main content fallback to body)
  const main = document.querySelector('main') || document.body;
  const readable = want.readable ? main.innerText.replace(/\n{3,}/g, '\n\n').trim() : '';
  // raw main-content HTML — preserves inline links/images that innerText loses,
  // so verbatim content passthrough can rebuild pages link-faithfully
  const contentHtml = want.readable ? main.innerHTML.slice(0, 400_000) : '';

  // simplified accessibility tree (landmark + heading + interactive outline)
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.nodeName.toLowerCase();
    const map = { header: 'banner', nav: 'navigation', main: 'main', footer: 'contentinfo', aside: 'complementary', form: 'form', section: 'region', article: 'article', a: el.hasAttribute('href') ? 'link' : null, button: 'button', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading' };
    return map[tag] || null;
  };
  const axName = (el) => {
    const al = el.getAttribute('aria-label');
    if (al) return al.trim().slice(0, 120);
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 120);
  };
  const buildAx = (el, depth) => {
    if (depth > 6 || !visible(el)) return null;
    const role = roleOf(el);
    const children = [];
    for (const c of el.children) {
      const node = buildAx(c, role ? depth + 1 : depth);
      if (node) children.push(node);
    }
    if (!role) {
      // pass through children of non-semantic wrappers
      return children.length === 1 ? children[0] : (children.length ? { role: 'group', children } : null);
    }
    const node = { role };
    const name = axName(el);
    if (name) node.name = name;
    if (role === 'heading') node.level = /^h[1-6]$/.test(el.nodeName.toLowerCase()) ? +el.nodeName[1] : (+el.getAttribute('aria-level') || undefined);
    if (children.length) node.children = children.slice(0, 30);
    return node;
  };
  const accessibilityTree = want.accessibilityTree ? buildAx(document.body, 0) : null;

  return { headings, links, images, forms, buttons, structuredData, metadata, visibleText: textNodes, blocks, readable, contentHtml, accessibilityTree };
}

// ---------- metadata image fallback ----------
// og:image / twitter:image meta tags and JSON-LD ImageObject entries often record real
// page imagery even when a delayed-JS gallery never enters the DOM. Runs in Node on the
// extracted data; entries are tagged source/region 'metadata' so downstream consumers
// can distinguish them from DOM-found images.
export function collectMetadataImages(data, baseUrl) {
  const found = new Map(); // absolute url -> { src, alt, width, height }
  const add = (u, extra = {}) => {
    if (typeof u !== 'string' || !u.trim()) return;
    let a;
    try { a = new URL(u.trim(), baseUrl).href; } catch { return; }
    if (!/^https?:/i.test(a)) return;
    if (!found.has(a)) found.set(a, { src: a, ...extra });
  };
  const og = (data.metadata && data.metadata.openGraph) || {};
  const tw = (data.metadata && data.metadata.twitterCard) || {};
  const ogAlt = og['og:image:alt'] || tw['twitter:image:alt'] || '';
  const ogDims = { width: parseInt(og['og:image:width'], 10) || null, height: parseInt(og['og:image:height'], 10) || null };
  add(og['og:image'], { alt: ogAlt, ...ogDims });
  add(og['og:image:secure_url'], { alt: ogAlt, ...ogDims });
  add(tw['twitter:image'], { alt: ogAlt });
  add(tw['twitter:image:src'], { alt: ogAlt });
  // JSON-LD: ImageObject url/contentUrl + primaryImageOfPage refs (string form only —
  // {"@id": "...#primaryimage"} refs resolve to an ImageObject the walk visits anyway)
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    if (typeof node !== 'object') return;
    const types = [].concat(node['@type'] || []);
    if (types.includes('ImageObject')) {
      const meta = {
        alt: (typeof node.caption === 'string' ? node.caption : '') || (typeof node.name === 'string' ? node.name : ''),
        width: parseInt(node.width, 10) || null,
        height: parseInt(node.height, 10) || null,
      };
      if (typeof node.url === 'string') add(node.url, meta);
      if (typeof node.contentUrl === 'string') add(node.contentUrl, meta);
    }
    if (typeof node.primaryImageOfPage === 'string' && !node.primaryImageOfPage.includes('#')) add(node.primaryImageOfPage);
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(data.structuredData);
  return [...found.values()].map((f) => ({
    src: f.src,
    alt: f.alt || '',
    width: f.width || null,
    height: f.height || null,
    source: 'metadata',
    region: 'metadata',
  }));
}
