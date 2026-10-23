// Price Hider - content script
// Finds price-looking elements and masks them. Runs at document_start so
// prices are hidden before first paint; a MutationObserver catches lazy-loaded
// and infinite-scroll content.

(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    mode: "blur",        // "blur" | "hide"
    peek: true,          // hover to reveal one price at a time
    siteOnly: false,     // only run on sites in the allowlist below
    extraSelectors: [],  // user-added CSS selectors
  };

  // Sites known to be shopping sites. Used only when siteOnly = true.
  const SHOPPING_HOSTS = [
    "amazon.", "ebay.", "etsy.", "argos.", "currys.", "johnlewis.",
    "asos.", "nike.", "adidas.", "very.", "littlewoods.", "screwfix.",
    "wickes.", "diy.com", "ikea.", "wayfair.", "shein.", "temu.",
    "aliexpress.", "walmart.", "target.", "bestbuy.", "homedepot.",
    "lego.", "footlocker.", "jd-sports.", "sportsdirect.", "boohoo.",
    "zalando.", "decathlon.", "toolstation.", "smythstoys.", "boots.",
    "harveynorman.", "screwfix.", "theworks.", "waterstones.", "ao.com",
    "overclockers.", "scan.co.uk", "ebuyer.", "nvidia.", "apple.com",
  ];

  // Selectors that almost always wrap a price on real shops.
  const PRICE_SELECTORS = [
    "[itemprop='price']",
    "[data-testid*='price' i]",
    "[data-price]",
    "[class*='price' i]",
    "[id*='price' i]",
    "[class*='Price']",
    "[aria-label*='price' i]",
    "[class*='amount' i]",
    "[class*='cost' i]",
  ];

  // Currency shapes. Deliberately strict-ish to avoid tagging model
  // numbers, quantities, "4.5 stars", "2.5kg", "£" alone etc.
  // Require a currency symbol/code AND decimals, or a symbol with a
  // plausible magnitude.
  const RE_CURRENCY_PREFIX = /(?:^|[\s(])([£$€¥])\s?\d[\d,.]*/;
  const RE_CURRENCY_SUFFIX = /\d[\d,.]*\s?(?:£|€|\$|USD|GBP|EUR|p\b|pp\b)/i;
  const RE_CODE_PREFIX = /(?:^|[\s(])(?:GBP|USD|EUR|CAD|AUD)\s?\d/i;

  // A price token anywhere inside a run of text. Used to mask just the number
  // in "Free delivery from £4.95" without blurring the sentence.
  // Deliberately NOT global: a /g/ regex used with .test() keeps lastIndex
  // state between calls and starts returning false. maskPriceTokens builds its
  // own global copy per call.
  const RE_PRICE_TOKEN =
    /(?<![\w£$€¥])(?:[£$€¥]\s?\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?|\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?\s?(?:GBP|USD|EUR))/i;

  // A whole string that is nothing but a price. Used for compound widgets
  // where the currency symbol and the digits live in separate spans
  // (Amazon does this: £ / 21 / . / 50), so no single text node matches.
  const RE_WHOLE_PRICE =
    /^(?:[£$€¥]\s?\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?|\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?\s?(?:[£$€¥]|GBP|USD|EUR))$/i;

  // Collapse whitespace and strip an exact repeated copy. Amazon renders each
  // price twice - once in a visually-hidden .a-offscreen span and once as
  // visible fragments - so textContent is "£21.50£21.50".
  const normalisePriceText = (raw) => {
    const s = (raw || "").replace(/\s+/g, "");
    const n = s.length;
    if (!n) return s;
    for (let k = 1; k <= n / 2; k++) {
      if (n % k === 0 && s.slice(0, k).repeat(n / k) === s) return s.slice(0, k);
    }
    return s;
  };

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "IFRAME",
    "CODE", "PRE", "TEXTAREA", "INPUT", "SELECT",
  ]);

  let settings = { ...DEFAULTS };
  let observer = null;
  const masked = new WeakSet();
  let peekBadge = null;

  const isShoppingSite = () =>
    SHOPPING_HOSTS.some((h) => window.location.hostname.includes(h));

  const looksLikePrice = (text) => {
    const t = text.trim();
    if (!t || t.length > 24) return false;       // prices are short
    if (!t.match(/\d/)) return false;            // must contain a digit
    if (RE_CURRENCY_PREFIX.test(t)) return true;
    if (RE_CURRENCY_SUFFIX.test(t)) return true;
    if (RE_CODE_PREFIX.test(t)) return true;
    return false;
  };

  const shouldSkipElement = (el) => {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (masked.has(el)) return true;
    if (el.classList && el.classList.contains("pb-hidden-price")) return true;
    // Never mask the extension's own badge
    if (el.classList && el.classList.contains("pb-peek-badge")) return true;
    // Already contains a mask deeper down (wrapped by the selector pass)
    if (el.querySelector && el.querySelector(".pb-hidden-price")) return true;
    return false;
  };

  // Split-price widgets: the symbol and digits sit in separate child spans, so
  // no single text node is price-shaped. If a tight element's combined text is
  // exactly a price, mask the element itself. Runs first so it wins over the
  // text-node passes.
  const compoundPass = (root) => {
    const cands = [];
    const els = root.querySelectorAll("span,div,strong,b,em,td,li,p,a");
    for (const el of els) {
      if (el.childElementCount === 0 || el.childElementCount > 8) continue;
      const t = el.textContent || "";
      if (t.length > 26) continue;                  // cheap prefilter
      if (shouldSkipElement(el)) continue;
      const u = normalisePriceText(t);
      if (u.length < 2 || u.length > 15) continue;
      if (!RE_WHOLE_PRICE.test(u)) continue;
      // Tight box only - a price widget, not a card that contains one.
      // A width of 0 means the widget is hidden right now (off-screen carousel,
      // collapsed panel). Do not skip it: it may be revealed later and nothing
      // would rescan it.
      const w = el.getBoundingClientRect().width;
      if (w > 240) continue;
      cands.push(el);
    }
    // Deepest first: an inner £21.50 beats an outer price range.
    const depth = (n) => { let d = 0; while ((n = n.parentElement)) d++; return d; };
    cands.sort((a, b) => depth(b) - depth(a));
    for (const el of cands) {
      if (el.closest(".pb-hidden-price")) continue;
      if (el.querySelector(".pb-hidden-price")) continue;
      el.classList.add("pb-hidden-price");
      masked.add(el);
      if (settings.mode === "hide") el.classList.add("pb-mode-hide");
    }
  };

  // Wrap a single text node in an inline span and mask the span. Doing it at
  // Mask only the price token inside a text node, leaving the surrounding
  // words sharp. Splitting the node once is safe; "from £4.95" loses just the
  // "£4.95" and the sentence stays readable.
  const maskPriceTokens = (textNode) => {
    const parent = textNode.parentElement;
    if (!parent) return false;
    if (parent.closest(".pb-hidden-price")) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;

    const text = textNode.nodeValue || "";
    if (!text || text.length > 2000) return false;

    const re = new RegExp(RE_PRICE_TOKEN.source, "gi");
    const frag = document.createDocumentFragment();
    let last = 0;
    let hits = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const span = document.createElement("span");
      span.className = "pb-hidden-price pb-inline";
      if (settings.mode === "hide") span.classList.add("pb-mode-hide");
      span.textContent = m[0];
      frag.appendChild(span);
      masked.add(span);
      last = m.index + m[0].length;
      hits++;
      if (hits > 40) break;   // page furniture, not a price list
    }
    if (!hits) return false;
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
    return true;
  };

  // Mask whatever price text lives in this element.
  // Handles "£129.00", "$249.99", and rows like "£129.00 £179.00" by masking
  // each price token separately.
  const maskElement = (el) => {
    if (!el || masked.has(el)) return;
    if (el.closest && el.closest(".pb-hidden-price")) return;

    // Collect the element's own text nodes (not descendants already handled)
    // NOTE: collect everything BEFORE mutating. Swapping a text node for a
    // span mid-walk invalidates the TreeWalker and silently ends the loop.
    const texts = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (n.parentElement && n.parentElement.closest(".pb-hidden-price")) continue;
      if (RE_PRICE_TOKEN.test(n.nodeValue || "")) texts.push(n);
    }

    if (!texts.length) {
      // Fallback: mask the element itself if it is a clean single price leaf
      if (el.childElementCount === 0 && looksLikePrice(el.textContent || "")) {
        el.classList.add("pb-hidden-price");
        masked.add(el);
        if (settings.mode === "hide") el.classList.add("pb-mode-hide");
      }
      return;
    }

    // Masking a text node loses its parent's reference, so snapshot first.
    for (const t of texts) maskPriceTokens(t);
  };

  // Walk text nodes. Leaf-level walk keeps it cheap and avoids masking a
  // huge container just because it contains a price somewhere inside.
  const scanNode = (root) => {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

    // 0. Split-price widgets first - they win over the text-node passes.
    compoundPass(root);

    // 1. Explicit and heuristic selectors first.
    // Collect candidates, then narrow every one to its price leaf before
    // masking, so a container matched by [class*='price'] never wins over
    // the actual <span> holding the number.
    const selectorList = [...PRICE_SELECTORS, ...(settings.extraSelectors || [])];
    const candidates = new Set();
    for (const sel of selectorList) {
      let found;
      try {
        found = root.querySelectorAll(sel);
      } catch {
        continue; // user supplied a bad selector, ignore it
      }
      for (const el of found) candidates.add(el);
    }

    for (const el of candidates) {
      if (shouldSkipElement(el)) continue;
      if (el.childElementCount > 3) continue; // too structural
      const text = el.textContent || "";
      if (!looksLikePrice(text)) continue;
      // maskElement walks inside and masks each price-shaped text node
      maskElement(el);
    }

    // 2. Fallback: mask every price token in the text, wherever it sits.
    // Token-level masking means a price inside a sentence is caught without
    // blurring the whole sentence.
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          // The text may sit inside an element already masked, or inside a
          // subtree where a mask already exists. Either way, leave it alone.
          if (parent.closest(".pb-hidden-price")) return NodeFilter.FILTER_REJECT;
          if (!RE_PRICE_TOKEN.test(node.nodeValue || "")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    // Collect first, then mutate - the same TreeWalker invalidation applies.
    const hits = [];
    let n;
    let count = 0;
    while ((n = walker.nextNode()) && count < 4000) {
      count++;
      hits.push(n);
    }
    for (const t of hits) maskPriceTokens(t);
  };

  // ---- hover to peek ------------------------------------------------------
  const ensureBadge = () => {
    if (peekBadge && peekBadge.isConnected) return peekBadge;
    peekBadge = document.createElement("div");
    peekBadge.className = "pb-peek-badge";
    peekBadge.textContent = "Hold Shift to peek";
    document.documentElement.appendChild(peekBadge);
    return peekBadge;
  };

  let peekTimer = null;

  const onMouseOver = (e) => {
    if (!settings.peek) return;
    const el = e.target;
    if (!el || !el.classList || !el.classList.contains("pb-hidden-price")) return;
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = setTimeout(() => el.classList.add("pb-revealed"), 220);
  };

  const onMouseOut = (e) => {
    const el = e.target;
    if (!el || !el.classList || !el.classList.contains("pb-hidden-price")) return;
    if (peekTimer) clearTimeout(peekTimer);
    el.classList.remove("pb-revealed");
  };

  // Shift-hold reveals everything for as long as it is held.
  const onKeyDown = (e) => {
    if (e.key !== "Shift" || !settings.peek) return;
    document.querySelectorAll(".pb-hidden-price").forEach((el) =>
      el.classList.add("pb-revealed")
    );
    const b = ensureBadge();
    b.textContent = "Prices visible — release Shift";
    b.classList.add("pb-show");
  };

  const onKeyUp = (e) => {
    if (e.key !== "Shift") return;
    document.querySelectorAll(".pb-hidden-price").forEach((el) =>
      el.classList.remove("pb-revealed")
    );
    if (peekBadge) peekBadge.classList.remove("pb-show");
  };

  // ---- lifecycle ----------------------------------------------------------
  // Batch added nodes: every node seen since the last flush must be scanned.
  // Keeping only the first root silently drops client-rendered content, which
  // is how React/Vue shops (Argos) rendered every price unmasked.
  let pendingRoots = null;
  let scanScheduled = false;

  const flushScan = () => {
    scanScheduled = false;
    const roots = pendingRoots ? [...pendingRoots] : [];
    pendingRoots = null;
    for (const r of roots) {
      if (r && r.isConnected) scanNode(r);
    }
  };

  const queueScan = (root) => {
    if (root && root.nodeType === Node.ELEMENT_NODE) {
      if (!pendingRoots) pendingRoots = new Set();
      pendingRoots.add(root);
    }
    if (scanScheduled) return;
    scanScheduled = true;
    // requestIdleCallback keeps the main thread responsive on big pages
    if ("requestIdleCallback" in window) {
      requestIdleCallback(flushScan, { timeout: 300 });
    } else {
      setTimeout(flushScan, 50);
    }
  };

  const start = () => {
    if (!settings.enabled) return;
    if (settings.siteOnly && !isShoppingSite()) return;

    scanNode(document.documentElement);

    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes && m.addedNodes.length) {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) queueScan(node);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);

    // Hydration sweep: SPA shops keep painting for seconds after DOMContentLoaded
    // and some widgets are only revealed (or moved out of a hidden panel) later.
    // A few cheap full rescans catch anything the observer path missed.
    const sweep = (ms) => {
      setTimeout(() => {
        if (!settings.enabled || !observer) return;
        queueScan(document.body);
      }, ms);
    };
    [1200, 3500, 8000].forEach(sweep);
  };

  const stop = () => {
    if (observer) observer.disconnect();
    observer = null;
    document.querySelectorAll(".pb-hidden-price").forEach((el) => {
      el.classList.remove("pb-hidden-price", "pb-revealed", "pb-mode-hide");
    });
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    if (peekBadge) peekBadge.remove();
    peekBadge = null;
  };

  const applyMode = () => {
    document.querySelectorAll(".pb-hidden-price").forEach((el) => {
      el.classList.toggle("pb-mode-hide", settings.mode === "hide");
    });
  };

  // ---- boot ---------------------------------------------------------------
  // Guard against double-injection on the same frame
  if (window.__priceBlockerLoaded) return;
  window.__priceBlockerLoaded = true;

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let needsRestart = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === "enabled" || key === "siteOnly") needsRestart = true;
      settings[key] = newValue;
    }
    if (needsRestart) {
      stop();
      start();
    } else {
      applyMode();
      if (settings.enabled) queueScan(document.body);
    }
  });

  // Popup asks for the count it should display
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "pb:stats") {
      sendResponse({
        masked: document.querySelectorAll(".pb-hidden-price").length,
        site: window.location.hostname,
        siteOnlySkip: settings.siteOnly && !isShoppingSite(),
      });
      return true;
    }
    if (msg && msg.type === "pb:rescan") {
      queueScan(document.body);
      sendResponse({ ok: true });
      return true;
    }
  });
})();
