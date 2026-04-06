// =============================================================================
// Teamther.ai — Background Service Worker (background.js)
//
// Responsibilities:
//   1. Bootstrap on install — init scan counter + guest token
//   2. Open the Side Panel when the action icon is clicked
//   3. Handle SCORE_CANDIDATE — scrape LinkedIn/Indeed tab → analyzeCV
//   4. Handle SCORE_PDF — analyzeCV with extracted PDF text (no scraping step)
//   5. Handle INIT_SESSION, GET_STATUS utility messages from sidepanel
//   6. Tab cleanup — clear in-memory CV data when a tab is closed
// =============================================================================

'use strict';

import { generateFingerprint, initGuestSession, analyzeCV, login, getUserProfile, logout, analyzeCVAuth } from './api.js';

// ---------------------------------------------------------------------------
// In-memory scratchpad — cleared on tab close
// { [tabId]: { cv_text, source_url, candidateName } }
// ---------------------------------------------------------------------------
const tempCvStore = {};

// ---------------------------------------------------------------------------
// 1. Bootstrap on Install
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== 'install' && reason !== 'update') return;

    const stored = await chrome.storage.local.get(['scan_count', 'guest_token']);

    if (reason === 'install' && stored.scan_count === undefined) {
        await chrome.storage.local.set({ scan_count: 0 });
    }

    if (!stored.guest_token) {
        try {
            await initGuestSession();
        } catch (err) {
            console.warn('[Teamther.ai] Could not init guest session on install:', err.message);
        }
    }
});

// Re-try guest session init on service worker startup
// IMPORTANT: Only init guest session if the user is NOT already logged in.
// Calling initGuestSession() while logged in would overwrite remaining_credits
// with the guest default (5), making the UI show "5/5 Free Scans" incorrectly.
(async () => {
    try {
        const stored = await chrome.storage.local.get(['guest_token', 'isLoggedIn']);
        // Skip entirely if the user is authenticated
        if (stored.isLoggedIn) return;
        if (!stored.guest_token) {
            await initGuestSession();
        }
    } catch (err) {
        console.warn('[Teamther.ai] Startup guest session init skipped:', err.message);
    }
})();

// ---------------------------------------------------------------------------
// 2. Side Panel — open on action icon click
// ---------------------------------------------------------------------------

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {/* older Chrome, no-op */ });

// ---------------------------------------------------------------------------
// 3a. Credit Extraction Helper
// ---------------------------------------------------------------------------

/**
 * Extracts remaining credits from a user profile object,
 * trying all known field name variants the Teamther.ai API may return.
 *
 * @param {object} profile
 * @returns {number|null} remaining credits, or null if unknown
 */
function extractRemainingCredits(profile) {
    if (!profile) return null;

    const pkg = profile.package ?? profile.subscription ?? profile.plan ?? {};

    // custom_total_ai_limit is the user-level override (e.g. 500) — check first.
    // total_transaction_ai is the package-level base (e.g. 250).
    const totalCredits =
        profile.custom_total_ai_limit  ??
        pkg.credits_ai_cv_analysis     ??
        pkg.cv_analysis_credits        ??
        pkg.ai_credits                 ??
        pkg.total_transaction_ai       ??
        pkg.credits                    ??
        pkg.total_credits              ??
        pkg.limit                      ??
        profile.total_credits          ??
        null;

    // total_ai_usage = lifetime usage; current_month_ai_usage = this month only.
    const used =
        profile.total_ai_usage         ??
        profile.credits_used           ??
        profile.used_credits           ??
        profile.ai_credits_used        ??
        profile.scans_used             ??
        0;

    // Try a direct "remaining" field first
    const directRemaining =
        profile.remaining_credits  ??
        profile.credits_remaining  ??
        profile.available_credits  ??
        null;

    if (directRemaining !== null) return Math.max(0, directRemaining);
    if (totalCredits !== null) return Math.max(0, totalCredits - used);
    return null; // unknown — let the UI handle it
}

// ---------------------------------------------------------------------------
// 3b. Scan Quota Gate
// ---------------------------------------------------------------------------

const MAX_FREE_SCANS = 5;
const UPGRADE_URL = 'https://app.teamther.ai/packages?lang=en';

/**
 * Checks + increments the scan count.
 * Throws 'QUOTA_EXCEEDED' if the user is over the limit.
 * @param {number|null} activeTabId — if provided, redirected to upgrade page on quota hit
 * @returns {Promise<number>} remaining scans after increment
 */
async function enforceScanQuota(activeTabId = null) {
    // Logged-in users have their own credits — skip the local guest quota gate entirely
    const { isLoggedIn } = await chrome.storage.local.get('isLoggedIn');
    if (isLoggedIn) return Infinity;

    const { scan_count = 0 } = await chrome.storage.local.get('scan_count');

    if (scan_count >= MAX_FREE_SCANS) {
        if (activeTabId) {
            await chrome.tabs.update(activeTabId, { url: UPGRADE_URL }).catch(() => { });
        }
        throw new Error('QUOTA_EXCEEDED');
    }

    const newCount = scan_count + 1;
    await chrome.storage.local.set({ scan_count: newCount });
    return MAX_FREE_SCANS - newCount;
}

// ---------------------------------------------------------------------------
// 4. Content Script Injection Helper
// ---------------------------------------------------------------------------

async function ensureContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['scripts/content.js'],
        });
    } catch (_) {
        // Already injected or restricted origin — safe to ignore
    }
}

// ---------------------------------------------------------------------------
// 5a. SCORE_CANDIDATE — scrape then analyze
// ---------------------------------------------------------------------------

async function handleScoreCandidate(tabId, jobTitle, jobDescription, jobLanguage, sendResponse) {
    try {
        // ── Read auth state ONCE — used consistently to route to auth vs guest endpoint ──
        const { isLoggedIn } = await chrome.storage.local.get('isLoggedIn');

        // Quota gate — for logged-in users this always returns Infinity
        let remainingScans;
        try {
            remainingScans = isLoggedIn ? Infinity : await (async () => {
                const { scan_count = 0 } = await chrome.storage.local.get('scan_count');
                if (scan_count >= MAX_FREE_SCANS) {
                    await chrome.tabs.update(tabId, { url: UPGRADE_URL }).catch(() => {});
                    throw new Error('QUOTA_EXCEEDED');
                }
                const newCount = scan_count + 1;
                await chrome.storage.local.set({ scan_count: newCount });
                return MAX_FREE_SCANS - newCount;
            })();
        } catch (err) {
            if (err.message === 'QUOTA_EXCEEDED') {
                sendResponse({ success: false, error: 'QUOTA_EXCEEDED', remainingScans: 0 });
                return;
            }
            throw err;
        }

        // Inject content script
        await ensureContentScript(tabId);
        await new Promise(r => setTimeout(r, 150));

        // Scrape the profile
        let scrapeResult;
        try {
            scrapeResult = await chrome.tabs.sendMessage(tabId, { action: 'SCRAPE_PROFILE' });
        } catch (err) {
            sendResponse({
                success: false,
                error: 'Could not communicate with the page. Try refreshing the LinkedIn/Indeed tab.'
            });
            return;
        }

        if (!scrapeResult?.success) {
            sendResponse({ success: false, error: scrapeResult?.error || 'Scrape failed.' });
            return;
        }

        const { cv_text, source_url, candidateName } = scrapeResult.data;
        tempCvStore[tabId] = { cv_text, source_url, candidateName };

        let apiResult, creditsRemaining;

        if (isLoggedIn) {
            // ── Authenticated path — uses JWT Bearer token ─────────────────────────
            apiResult = await analyzeCVAuth({ cv_text, source_url, jobTitle, jobDescription, jobLanguage, candidateName });
            // New endpoint returns credits_remaining synchronously - no extra profile fetch needed
            creditsRemaining = apiResult.credits_remaining ?? null;
        } else {
            // ── Guest path — uses guest token ──────────────────────────────────────
            // Ensure we have a valid guest token before calling the guest endpoint
            let { guest_token } = await chrome.storage.local.get('guest_token');
            if (!guest_token) {
                try { await initGuestSession(); } catch (initErr) {
                    sendResponse({ success: false, error: `Could not connect to Teamther.ai servers. (${initErr.message})` });
                    return;
                }
                const recheck = await chrome.storage.local.get('guest_token');
                guest_token = recheck.guest_token;
                if (!guest_token) {
                    sendResponse({ success: false, error: 'Could not obtain a guest token. Please try again in a moment.' });
                    return;
                }
            }
            apiResult = await analyzeCV({ cv_text, source_url, jobTitle, jobDescription });
            creditsRemaining = remainingScans;
        }

        sendResponse({
            success: true,
            data: {
                score: apiResult.score ?? 0,
                recommendation: apiResult.recommendation ?? 'N/A',
                strengths: apiResult.strengths ?? [],
                weaknesses: apiResult.weaknesses ?? [],
                reasoning: apiResult.reasoning ?? null,
                // Sub-scores — must be forwarded explicitly or sidepanel shows 0
                experience_score: apiResult.experience_score ?? null,
                skills_score:     apiResult.skills_score     ?? null,
                education_score:  apiResult.education_score  ?? null,
                language_score:   apiResult.language_score   ?? null,
                candidateName,
                source_url,
                remainingScans: creditsRemaining,
            }
        });

    } catch (err) {
        console.error('[Teamther.ai] handleScoreCandidate error:', err);

        // SESSION_EXPIRED: fetchWithAuth tried refresh and it also failed — must re-login
        // NOTE: We do NOT wipe storage here. The user may just need to re-authenticate.
        // Wiping isLoggedIn here caused users to get kicked out due to service worker restarts.
        if (err.message === 'SESSION_EXPIRED' || err.status === 401) {
            sendResponse({ success: false, error: 'SESSION_EXPIRED' });
            return;
        }
        // 403 = paid credits exhausted — keep logged in, show upgrade prompt
        if (err.status === 403) {
            sendResponse({ success: false, error: 'CREDITS_EXHAUSTED' });
            return;
        }
        sendResponse({ success: false, error: err.message || 'Unexpected error.' });
    }
}

// ---------------------------------------------------------------------------
// 5b. SCORE_PDF — analyze extracted PDF text directly (no scraping step)
// ---------------------------------------------------------------------------

async function handleScorePdf(cvText, fileName, jobTitle, jobDescription, jobLanguage, sendResponse) {
    try {
        // ── Read auth state ONCE ─────────────────────────────────────────────────
        const { isLoggedIn } = await chrome.storage.local.get('isLoggedIn');

        // Quota gate — for logged-in users skip local quota
        let remainingScans;
        try {
            remainingScans = isLoggedIn ? Infinity : await (async () => {
                const { scan_count = 0 } = await chrome.storage.local.get('scan_count');
                if (scan_count >= MAX_FREE_SCANS) throw new Error('QUOTA_EXCEEDED');
                const newCount = scan_count + 1;
                await chrome.storage.local.set({ scan_count: newCount });
                return MAX_FREE_SCANS - newCount;
            })();
        } catch (err) {
            if (err.message === 'QUOTA_EXCEEDED') {
                sendResponse({ success: false, error: 'QUOTA_EXCEEDED', remainingScans: 0 });
                return;
            }
            throw err;
        }

        const source_url = 'PDF_Upload';
        const candidateName = fileName.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ') || 'PDF Candidate';

        let apiResult, creditsRemaining;

        if (isLoggedIn) {
            // ── Authenticated path ──────────────────────────────────────────────
            apiResult = await analyzeCVAuth({ cv_text: cvText, source_url, jobTitle, jobDescription, jobLanguage, candidateName });
            // New endpoint returns credits_remaining synchronously - no extra profile fetch needed
            creditsRemaining = apiResult.credits_remaining ?? null;
        } else {
            // ── Guest path ─────────────────────────────────────────────────────
            let { guest_token } = await chrome.storage.local.get('guest_token');
            if (!guest_token) {
                try { await initGuestSession(); } catch (initErr) {
                    sendResponse({ success: false, error: `Could not connect to Teamther.ai servers. (${initErr.message})` });
                    return;
                }
                const recheck = await chrome.storage.local.get('guest_token');
                guest_token = recheck.guest_token;
                if (!guest_token) {
                    sendResponse({ success: false, error: 'Could not obtain a guest token. Please try again in a moment.' });
                    return;
                }
            }
            apiResult = await analyzeCV({ cv_text: cvText, source_url, jobTitle, jobDescription });
            creditsRemaining = remainingScans;
        }

        sendResponse({
            success: true,
            data: {
                score: apiResult.score ?? 0,
                recommendation: apiResult.recommendation ?? 'N/A',
                strengths: apiResult.strengths ?? [],
                weaknesses: apiResult.weaknesses ?? [],
                reasoning: apiResult.reasoning ?? null,
                // Sub-scores — must be forwarded explicitly or sidepanel shows 0
                experience_score: apiResult.experience_score ?? null,
                skills_score:     apiResult.skills_score     ?? null,
                education_score:  apiResult.education_score  ?? null,
                language_score:   apiResult.language_score   ?? null,
                candidateName,
                source_url,
                remainingScans: creditsRemaining,
            }
        });

    } catch (err) {
        console.error('[Teamther.ai] handleScorePdf error:', err);

        // NOTE: We do NOT wipe storage here. The user may just need to re-authenticate.
        if (err.message === 'SESSION_EXPIRED' || err.status === 401) {
            sendResponse({ success: false, error: 'SESSION_EXPIRED' });
            return;
        }
        if (err.status === 403) {
            sendResponse({ success: false, error: 'CREDITS_EXHAUSTED' });
            return;
        }
        sendResponse({ success: false, error: err.message || 'Unexpected error.' });
    }
}

// ---------------------------------------------------------------------------
// 6. Message Router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action } = message;

    // ── Score a candidate from a LinkedIn/Indeed tab ─────────────────────────
    if (action === 'SCORE_CANDIDATE') {
        const { jobTitle, jobDescription, jobLanguage, tabId } = message;
        const targetTabId = tabId ?? sender.tab?.id;

        if (!targetTabId) {
            sendResponse({ success: false, error: 'Could not identify the active tab.' });
            return false;
        }

        handleScoreCandidate(targetTabId, jobTitle, jobDescription, jobLanguage, sendResponse);
        return true;
    }

    // ── Score a PDF — text already extracted by sidepanel.js ────────────────
    if (action === 'SCORE_PDF') {
        const { cvText, fileName, jobTitle, jobDescription, jobLanguage } = message;

        if (!cvText) {
            sendResponse({ success: false, error: 'No CV text provided.' });
            return false;
        }

        handleScorePdf(cvText, fileName || 'resume.pdf', jobTitle, jobDescription, jobLanguage, sendResponse);
        return true;
    }

    // ── Re-initialize guest session ──────────────────────────────────────────
    if (action === 'INIT_SESSION') {
        initGuestSession()
            .then(data => sendResponse({ success: true, data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    // ── Get current status ───────────────────────────────────────────────────
    if (action === 'GET_STATUS') {
        chrome.storage.local.get(['scan_count', 'guest_token', 'remaining_credits', 'isLoggedIn', 'user'])
            .then(({ scan_count = 0, guest_token = '', remaining_credits, isLoggedIn = false, user = null }) => {
                let creditsRemaining = remaining_credits ?? (MAX_FREE_SCANS - scan_count);
                let userPackage = null;

                if (isLoggedIn && user) {
                    const computed = extractRemainingCredits(user);
                    creditsRemaining = computed ?? creditsRemaining;
                    const pkg = user.package ?? user.subscription ?? user.plan ?? {};
                    userPackage = pkg.name ?? pkg.title ?? null;
                }

                sendResponse({
                    success: true,
                    data: {
                        scan_count,
                        remaining_credits: creditsRemaining,
                        hasToken: !!guest_token,
                        isLoggedIn,
                        userPackage,
                        user,
                    }
                });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    // ── Login ────────────────────────────────────────────────────────────────
    if (action === 'LOGIN') {
        const { email, password } = message;
        login(email, password)
            .then(async ({ user }) => {
                // Fetch full profile immediately after login to get package/credit data
                let profile = user;
                try { profile = await getUserProfile(); } catch (_) { /* use user from login */ }
                sendResponse({ success: true, data: profile });
            })
            .catch(err => {
                // Surface human-readable auth errors
                let msg = err.message || 'Login failed.';
                if (err.status === 401 || err.status === 400) msg = 'Invalid email or password.';
                sendResponse({ success: false, error: msg });
            });
        return true;
    }

    // ── Logout ───────────────────────────────────────────────────────────────
    if (action === 'LOGOUT') {
        logout()
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    // ── Fetch latest user profile ────────────────────────────────────────────
    if (action === 'GET_USER_PROFILE') {
        getUserProfile()
            .then(profile => sendResponse({ success: true, data: profile }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    return false;
});

// ---------------------------------------------------------------------------
// 7. Tab Cleanup
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tempCvStore[tabId]) {
        delete tempCvStore[tabId];
    }
});

// ---------------------------------------------------------------------------
// 8. Handle action click — open the side panel
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener(async (tab) => {
    try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (err) {
        console.warn('[Teamther.ai] Could not open side panel:', err.message);
    }
});
