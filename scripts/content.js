// =============================================================================
// Teamther.ai — Content Script (content.js)
// Runs on: LinkedIn and Indeed profile pages
// Responsibilities:
//   1. Validate that the current page is a real candidate profile
//   2. Auto-click all "See More" / "Show all experiences" buttons so hidden
//      content is expanded before we extract text
//   3. Extract profile text — targeting specific profile containers first,
//      falling back to body if none are found. Strips navigation junk.
//   4. Listen for SCRAPE_PROFILE messages from the background service worker
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Injection guard — content scripts can be injected multiple times in MV3
// when executeScript() is called on the same tab. This guard ensures we only
// run once per page, preventing "already declared" SyntaxErrors and duplicate
// message listeners.
// ---------------------------------------------------------------------------
if (window.__teamtherContentInjected) {
  // Already loaded — skip everything. The existing listener is still active.
  throw new Error('[Teamther.ai] content.js: already injected, skipping re-init.');
}
window.__teamtherContentInjected = true;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect which platform we are on. Returns 'linkedin' | 'indeed' | null */
function detectPlatform() {
  const host = window.location.hostname.toLowerCase();
  if (host.includes('linkedin.com')) return 'linkedin';
  if (host.includes('indeed.com')) return 'indeed';
  return null;
}

/** Sleep for a given number of milliseconds */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Scrolls the page to the bottom in 500px steps so lazy-loaded sections
 * (e.g. LinkedIn Languages) are rendered into the DOM before scraping.
 * Stops when scroll position no longer changes.
 */
async function scrollToBottom() {
  await new Promise(resolve => {
    let lastPos = -1;
    const interval = setInterval(async () => {
      window.scrollBy(0, 500);
      // Brief pause so the browser can trigger intersection observers
      await sleep(300);
      if (window.scrollY === lastPos) {
        clearInterval(interval);
        resolve();
      }
      lastPos = window.scrollY;
    }, 350);
  });
  // Scroll back to top so the user sees the page normally after scraping
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Step 1 — Validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the current page looks like a valid candidate profile.
 */
function validatePage(platform) {
  if (!platform) {
    return {
      valid: false,
      reason: 'Invalid Profile — Please open a LinkedIn or Indeed profile page.'
    };
  }

  const bodyText = (document.body?.innerText || '').toLowerCase();

  if (platform === 'linkedin') {
    const path = window.location.pathname.toLowerCase();
    const isProfilePath = path.startsWith('/in/') ||
      path.includes('/talent/profile/');
    if (!isProfilePath) {
      return {
        valid: false,
        reason: 'Invalid Profile — Please open a LinkedIn profile (/in/username).'
      };
    }
  }

  if (platform === 'indeed') {
    const path = window.location.pathname.toLowerCase();
    const isProfilePath = path.includes('/r/') ||
      path.includes('/resume/') ||
      path.includes('/profile/');
    if (!isProfilePath) {
      return {
        valid: false,
        reason: 'Invalid Profile — Please open an Indeed resume page.'
      };
    }
  }

  const profileKeywords = [
    'experience',
    'education',
    'expérience',
    'formation',
    'skills',
    'compétences',
    'work history',
    'resume',
    'summary',
  ];

  const hasKeyword = profileKeywords.some(kw => bodyText.includes(kw));

  if (!hasKeyword) {
    return {
      valid: false,
      reason: 'Invalid Profile — Please open a LinkedIn or Indeed resume.'
    };
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Step 2 — "See More" / "Show all" button auto-clicker
// ---------------------------------------------------------------------------

const EXPAND_BUTTON_SELECTORS = [
  // ── LinkedIn ──────────────────────────────────────────────────────────────
  'a[data-field="experience_see_more"]',
  'a[data-field="education_see_more"]',
  'a[data-field="skills_see_more"]',
  'a[data-field="recommendations_see_more"]',
  'a[data-field="projects_see_more"]',
  'a[data-field="courses_see_more"]',
  'a[data-field="volunteer_see_more"]',
  'a[data-field="publications_see_more"]',
  'a[data-field="patents_see_more"]',
  'a[data-field="languages_see_more"]',
  'button[aria-label*="show all"]',
  'button[aria-label*="Show all"]',
  'button.inline-show-more-text__button',
  'span.inline-show-more-text__link-container-collapsed button',
  'button[aria-label="Show more, About"]',
  'button.pv-profile-section__see-more-inline',
  'button.lt-line-clamp__more',
  // ── Indeed ────────────────────────────────────────────────────────────────
  'button[data-testid="formatted-resume-show-more"]',
  'button[aria-label*="Show more"]',
  'button[aria-label*="show more"]',
  'span[class*="ShowMoreButton"] button',
  'button[class*="showMore"]',
  'a[class*="show-more"]',
];

/**
 * Clicks every visible expand button. Uses href-swap trick to prevent
 * LinkedIn <a> tags from triggering full page navigation.
 */
function clickExpandButtons() {
  let clicked = 0;

  for (const selector of EXPAND_BUTTON_SELECTORS) {
    let elements;
    try {
      elements = document.querySelectorAll(selector);
    } catch (_) {
      continue;
    }

    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const isVisible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        el.offsetParent !== null;

      if (!isVisible) continue;
      if (el.disabled) continue;

      try {
        if (el.tagName === 'A' && el.href) {
          const savedHref = el.getAttribute('href');
          el.removeAttribute('href');
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          requestAnimationFrame(() => {
            if (savedHref) el.setAttribute('href', savedHref);
          });
        } else {
          el.click();
        }
        clicked++;
      } catch (_) {
        // Ignore errors on individual elements
      }
    }
  }

  return clicked;
}

/**
 * Three-pass expand with increasingly longer DOM-settle delays.
 * Extra passes catch nested "see more" buttons that appear after
 * an earlier expand causes new content to render.
 */
async function expandAllSections() {
  // Pass 1 — click all currently visible expand buttons
  const pass1 = clickExpandButtons();
  if (pass1 > 0) {
    await sleep(2500);   // wait longer for nested content to render
  }
  // Pass 2 — catches buttons that appeared after pass 1
  const pass2 = clickExpandButtons();
  if (pass2 > 0) {
    await sleep(1500);
  }
  // Pass 3 — final sweep for any remaining collapsed sections
  await sleep(1000);
  clickExpandButtons();
}

// ---------------------------------------------------------------------------
// Step 3 — Smart Extraction
// ---------------------------------------------------------------------------

/**
 * LinkedIn profile section selectors in priority order.
 * We try each and use the first one that exists and has meaningful text.
 */
const LINKEDIN_PROFILE_SELECTORS = [
  '.scaffold-layout__main',
  '[data-view-name="profile-card"]',
  '.pv-profile-section-list',
  '#profile-content',
  '#main-content',
  'main[aria-label]',
  'main',
];

/**
 * Indeed profile section selectors in priority order.
 */
const INDEED_PROFILE_SELECTORS = [
  '.applicant-resume-container',
  '[data-testid="resume-body"]',
  '.formatted-resume',
  '#resume-preview-card',
  'main',
  '#main',
];

/**
 * DOM elements to strip from the cloned profile node before text extraction.
 * These are navigation, ads, sidebars, and other junk that pollutes the CV text.
 */
const JUNK_SELECTORS = [
  // LinkedIn nav / chrome
  'header',
  'nav',
  'footer',
  '.global-nav',
  '.authentication-outlet',
  '.feed-identity-module',
  '.artdeco-global-alert-container',
  '.msg-overlay-list-bubble',
  '.notification-badge',
  // LinkedIn sidebar / ads
  '.scaffold-layout__aside',
  '.ad-banner-container',
  '[data-ad-banner]',
  '.premium-upsell-link',
  // LinkedIn action buttons
  '.pvs-profile-actions',
  '.pv-top-card-v2-ctas',
  '.pv-s-profile-actions',
  // LinkedIn "People also viewed"
  '.pv-browsemap-section',
  '.browsemap',
  // Indeed nav
  '.iaHeaderTopbar',
  '.IA_Header',
  '.ia-BasePage-footer',
  // Generic
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[aria-label="Messaging"]',
  '[aria-label="LinkedIn News"]',
  'script',
  'style',
  'noscript',
  'svg',
];

/**
 * Extract text from the best available profile container.
 * Clones the element and strips junk nodes before reading innerText,
 * so navigation, ads, and sidebars are excluded from the result.
 *
 * @param {string} platform — 'linkedin' | 'indeed'
 * @returns {string} cleaned profile text
 */
function extractProfileText(platform) {
  const selectors = platform === 'linkedin'
    ? LINKEDIN_PROFILE_SELECTORS
    : INDEED_PROFILE_SELECTORS;

  let profileEl = null;

  // Find the first selector that yields a non-trivial element
  for (const sel of selectors) {
    const candidate = document.querySelector(sel);
    if (candidate && candidate.innerText && candidate.innerText.trim().length > 200) {
      profileEl = candidate;
      break;
    }
  }

  // Absolute fallback — use whole body
  if (!profileEl) {
    profileEl = document.body;
  }

  // Clone so we can safely remove junk without mutating the live DOM
  const clone = profileEl.cloneNode(true);

  // Strip noisy elements from the clone
  for (const junkSel of JUNK_SELECTORS) {
    clone.querySelectorAll(junkSel).forEach(el => el.remove());
  }

  // Read text, then clean up excessive whitespace
  const rawText = clone.innerText || '';

  return rawText
    .replace(/\r\n/g, '\n')          // normalise line endings
    .replace(/[ \t]+/g, ' ')         // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')      // collapse 3+ blank lines to 2
    .replace(/^\s+|\s+$/gm, '')      // trim each line
    .trim();
}

/**
 * Try to extract the candidate's name from well-known DOM elements.
 */
function extractCandidateName(platform) {
  if (platform === 'linkedin') {
    const h1 = document.querySelector(
      'h1.text-heading-xlarge, ' +
      '.pv-text-details__left-panel h1, ' +
      '.top-card-layout__title, ' +
      'h1[class*="top-card"]'
    );
    if (h1?.innerText?.trim()) return h1.innerText.trim();
  }

  if (platform === 'indeed') {
    const nameEl = document.querySelector(
      '[data-testid="applicant-name"], ' +
      '.applicant-resume-container h1, ' +
      '.css-1rcco43 h1'
    );
    if (nameEl?.innerText?.trim()) return nameEl.innerText.trim();
  }

  const titleParts = document.title.split('|');
  if (titleParts.length > 0 && titleParts[0].trim()) {
    return titleParts[0].trim();
  }

  return 'Unknown Candidate';
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

async function scrapeProfile() {
  const platform = detectPlatform();

  const { valid, reason } = validatePage(platform);
  if (!valid) {
    return { success: false, error: reason };
  }

  // Step 1 — Scroll to bottom so lazy-loaded sections (Languages, etc.) are in DOM
  await scrollToBottom();
  await sleep(1500);             // let intersection observers and lazy loaders settle

  // Step 2 — Expand all collapsed sections (3-pass, with waits)
  await expandAllSections();
  await sleep(1000);             // final settle before reading DOM

  // Step 3 — Extract
  const cv_text = extractProfileText(platform);
  const candidateName = extractCandidateName(platform);
  const source_url = window.location.href;

  if (!cv_text || cv_text.length < 100) {
    return {
      success: false,
      error: 'Could not extract profile content. Make sure the page is fully loaded.'
    };
  }

  return {
    success: true,
    data: {
      cv_text,
      source_url,
      candidateName,
      platform
    }
  };
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== 'SCRAPE_PROFILE') return false;

  scrapeProfile()
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ success: false, error: String(err) }));

  return true;
});
