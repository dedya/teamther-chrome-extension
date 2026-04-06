// =============================================================================
// Teamther.ai — API Layer (api.js)
// Imported as an ES module by background.js
//
// Exports:
//   generateFingerprint()   → string  (SHA-256, cached in storage)
//   initGuestSession()      → { guest_token, remaining_credits }
//   analyzeCV(payload)      → API result object
// =============================================================================

'use strict';

const BASE_URL = 'https://app.teamther.ai/api/v1';
const EXTENSION_ID = chrome.runtime.id;

// ---------------------------------------------------------------------------
// Fingerprint — SHA-256 of stable browser signals, cached in storage
// ---------------------------------------------------------------------------

/**
 * Builds a stable fingerprint string from browser environment signals.
 * The result is SHA-256 hashed and cached in chrome.storage.local so it
 * never changes between sessions for the same browser/extension combination.
 *
 * @returns {Promise<string>} hex fingerprint
 */
export async function generateFingerprint() {
    // Return cached fingerprint if it already exists
    const stored = await chrome.storage.local.get('fingerprint');
    if (stored.fingerprint) return stored.fingerprint;

    // Build a raw signal string from stable browser characteristics.
    // `screen` is unavailable in MV3 service workers — use a safe fallback.
    const screenInfo = typeof screen !== 'undefined'
        ? `${screen.width}x${screen.height}x${screen.colorDepth}`
        : 'sw-context';

    const rawSignal = [
        EXTENSION_ID,
        navigator.userAgent,
        navigator.language,
        screenInfo,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    ].join('||');

    // SHA-256 via Web Crypto API (available in MV3 service workers)
    const msgBuffer = new TextEncoder().encode(rawSignal);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const fingerprint = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    await chrome.storage.local.set({ fingerprint });
    return fingerprint;
}

// ---------------------------------------------------------------------------
// Internal fetch helper with error normalisation
// ---------------------------------------------------------------------------

/**
 * Wraps fetch with consistent error handling.
 * Throws a descriptive Error (with `.status` if available) on non-2xx responses.
 */
async function apiFetch(path, options = {}) {
    const url = `${BASE_URL}${path}`;

    let response;
    try {
        response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {}),
            },
        });
    } catch (networkErr) {
        throw new Error(`Network error — could not reach Teamther.ai servers. (${networkErr.message})`);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        // Log the server's response body so we can diagnose auth rejections
        console.warn(`[Teamther.ai] API ${response.status} on ${path}:`, errText || response.statusText);
        const err = new Error(
            `API error ${response.status} on ${path}: ${errText || response.statusText}`
        );
        err.status = response.status;
        throw err;
    }

    try {
        return await response.json();
    } catch {
        throw new Error(`API returned non-JSON response from ${path}`);
    }
}

// ---------------------------------------------------------------------------
// Auth — Guest Session Initialisation
// ---------------------------------------------------------------------------

/**
 * POST /auth/guest/init/
 * Exchanges fingerprint + extension_id for a short-lived guest_token.
 * Persists token, remaining_credits, and fingerprint into chrome.storage.local.
 *
 * @returns {Promise<{ guest_token: string, remaining_credits: number }>}
 */
export async function initGuestSession() {
    // ── Profile isolation check ───────────────────────────────────────────────
    // Read everything we need up front, then generate the current fingerprint.
    // If the stored fingerprint belongs to a DIFFERENT Chrome profile, wipe the
    // stale guest data so this profile always starts fresh.
    const stored = await chrome.storage.local.get([
        'guest_token',
        'guest_fingerprint',
        'remaining_credits',
        'credits_exhausted',
    ]);
    const currentFingerprint = await generateFingerprint();

    if (stored.guest_fingerprint && stored.guest_fingerprint !== currentFingerprint) {
        await chrome.storage.local.remove([
            'guest_token',
            'guest_fingerprint',
            'remaining_credits',
            'credits_exhausted',
        ]);
        console.warn('[Teamther.ai] Different profile detected — guest session cleared');
    }

    // Use the live fingerprint for the API call
    const fingerprint = currentFingerprint;

    const data = await apiFetch('/auth/guest/init/', {
        method: 'POST',
        body: JSON.stringify({
            fingerprint,
            extension_id: EXTENSION_ID,
        }),
    });

    // API response shape: { success, message, data: { guest_token, remaining_credits, ... } }
    // The actual payload is nested inside data.data
    const payload = data.data ?? data;

    const guest_token = payload.guest_token ?? payload.token ?? '';
    let remaining_credits = payload.remaining_credits ?? payload.credits ?? 5;

    // ── Credits-exhausted flag ────────────────────────────────────────────────
    // Once a profile hits 0 credits, lock it permanently so refreshing the
    // fingerprint or re-initialising never restores free credits.
    if (remaining_credits === 0) {
        await chrome.storage.local.set({ credits_exhausted: true });
    }

    const { credits_exhausted } = await chrome.storage.local.get('credits_exhausted');
    if (credits_exhausted) {
        // Profile already exhausted — always return 0 regardless of backend
        return { guest_token, remaining_credits: 0 };
    }

    // CRITICAL: Only update remaining_credits if the user is NOT logged in.
    // If a logged-in (Pro) user's service worker restarts, initGuestSession may fire.
    // Writing remaining_credits = 5 here would make the UI show "5/5 Free Scans" incorrectly.
    const { isLoggedIn } = await chrome.storage.local.get('isLoggedIn');
    if (isLoggedIn) {
        // Only persist the guest token (needed for fallback), never touch credit counts
        await chrome.storage.local.set({ guest_token, guest_fingerprint: fingerprint });
    } else {
        await chrome.storage.local.set({ guest_token, remaining_credits, guest_fingerprint: fingerprint });
    }

    return { guest_token, remaining_credits };
}

// ---------------------------------------------------------------------------
// CV Analysis
// ---------------------------------------------------------------------------

/**
 * POST /ext/guest/analyze-cv/
 *
 * @param {object} opts
 * @param {string} opts.cv_text       — full extracted profile text
 * @param {string} opts.source_url    — URL of the scraped profile
 * @param {string} opts.jobTitle      — job title saved by recruiter
 * @param {string} opts.jobDescription — job description saved by recruiter
 *
 * @returns {Promise<{
 *   score: number,
 *   recommendation: 'Hire'|'Interview'|'Reject',
 *   strengths: string[],
 *   weaknesses: string[]
 * }>}
 */
export async function analyzeCV({ cv_text, source_url }) {
    // Retrieve session and job data fresh from storage — never use cached/passed-in values
    // so that any recruiter changes to job fields are always picked up.
    const stored = await chrome.storage.local.get([
        'guest_token',
        'fingerprint',
        'jobTitle',
        'jobDescription',
        'jobLanguage',
    ]);

    const guest_token  = stored.guest_token;
    const fingerprint  = stored.fingerprint || await generateFingerprint();

    // Always read job fields fresh — no caching for guest users
    const jobTitle       = stored.jobTitle       ?? '';
    const jobDescription = stored.jobDescription ?? '';
    // jobLanguage intentionally unused for guest endpoint but read for completeness

    if (!guest_token) {
        throw new Error('Session expired — could not get a guest token. Please refresh the extension and try again.');
    }

    const rawData = await apiFetch('/ext/guest/analyze-cv/', {
        method: 'POST',
        headers: {
            'X-Guest-Token': guest_token,
        },
        body: JSON.stringify({
            cv_text,
            job_data: {
                title: jobTitle,
                description: jobDescription,
            },
            source_url,
            fingerprint,
            extension_id: EXTENSION_ID,
        }),
    });

    // API response shape: { success, data: { score, recommendation, strengths, weaknesses, reasoning } }
    return rawData.data ?? rawData;
}

// ---------------------------------------------------------------------------
// Auth — JWT Login
// ---------------------------------------------------------------------------

/**
 * POST /auth/login/
 * Exchanges email + password for JWT access/refresh tokens.
 * Persists tokens, user object, and isLoggedIn flag to chrome.storage.local.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ user: object, access: string, refresh: string }>}
 */
export async function login(email, password) {
    const data = await apiFetch('/auth/login/', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
    });

    // API response shape: { access, refresh, user } or { data: { access, refresh, user } }
    const payload = data.data ?? data;

    // Log the full raw payload so you can check the field names in DevTools
    console.warn('[Teamther.ai] login() RAW PAYLOAD:', JSON.stringify(payload));

    // THE API NESTS TOKENS UNDER payload.tokens — extract from there first
    const tokensObj = payload.tokens ?? {};

    // Extract token — try every possible field the API might use
    const access =
        tokensObj.access         ??
        tokensObj.access_token   ??
        payload.access           ??
        payload.access_token     ??
        payload.token            ??
        payload.jwt              ??
        payload.key              ??
        // some APIs nest it one level deeper
        payload.data?.access     ??
        payload.data?.token      ??
        payload.data?.access_token ?? '';

    const refresh =
        tokensObj.refresh         ??
        tokensObj.refresh_token   ??
        payload.refresh         ??
        payload.refresh_token   ??
        payload.data?.refresh   ??
        payload.data?.refresh_token ?? '';

    const user =
        payload.user            ??
        payload.profile         ??
        payload.account         ??
        payload.data?.user      ??
        {};

    if (!access) {
        console.warn('[Teamther.ai] login(): could not find access token. Full payload logged above.');
    }

    await chrome.storage.local.set({
        isLoggedIn: true,
        // Store token under ALL common key names to maximise compatibility
        access:        access,
        access_token:  access,
        token:         access,
        refresh:       refresh,
        refresh_token: refresh,
        user,
        _loginPayload: payload,
    });

    console.warn('[Teamther.ai] login(): tokens stored. access present:', !!access, '| refresh present:', !!refresh);

    console.debug('[Teamther.ai] login(): stored tokens. access present:', !!access, '| raw payload keys:', Object.keys(payload).join(', '));

    return { access, refresh, user };
}

// ---------------------------------------------------------------------------
// Auth — Token Refresh (internal helper)
// ---------------------------------------------------------------------------

/**
 * Attempts to exchange the stored refresh token for a new access token.
 * Returns the new access token string on success, or null on ANY failure.
 * Never throws — failure is communicated via null return value.
 *
 * Supported endpoints (tried in order):
 *   POST /auth/token/refresh/
 *   POST /auth/refresh/
 */
async function tryRefreshAccessToken() {
    const stored = await chrome.storage.local.get(['refresh', 'refresh_token']);
    const refresh = stored.refresh || stored.refresh_token || '';
    if (!refresh) {
        console.warn('[Teamther.ai] tryRefreshAccessToken: no refresh token in storage.');
        return null;
    }

    // Try the two most common Django JWT refresh endpoint URLs
    const REFRESH_ENDPOINTS = ['/auth/token/refresh/', '/auth/refresh/'];

    for (const ep of REFRESH_ENDPOINTS) {
        try {
            console.debug(`[Teamther.ai] tryRefreshAccessToken: trying ${ep}`);
            const data = await apiFetch(ep, {
                method: 'POST',
                body: JSON.stringify({ refresh }),
            });
            const payload = data.data ?? data;
            const newAccess = payload.access ?? payload.access_token ?? payload.token ?? '';
            if (newAccess) {
                console.debug('[Teamther.ai] tryRefreshAccessToken: success via', ep);
                await chrome.storage.local.set({ access: newAccess });
                return newAccess;
            }
        } catch (err) {
            console.debug(`[Teamther.ai] tryRefreshAccessToken: ${ep} failed:`, err.message);
            // Continue to next endpoint
        }
    }

    console.warn('[Teamther.ai] tryRefreshAccessToken: all endpoints failed — returning null.');
    return null;
}

// ---------------------------------------------------------------------------
// Auth — Authenticated Fetch Helper
// ---------------------------------------------------------------------------

/**
 * Makes an authenticated API request with the stored Bearer token.
 *
 * Flow:
 *  1. Read stored access token (tries every known key name)
 *  2. If no token found, try a silent refresh first
 *  3. Make the request
 *  4. If 401, try a silent refresh and retry ONCE
 *  5. If still 401 (or refresh returned null), throw SESSION_EXPIRED
 *
 * IMPORTANT: This function NEVER touches chrome.storage.local isLoggedIn.
 * Only the background.js scan handlers decide when to actually log the user out.
 *
 * @param {string} endpoint
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function fetchWithAuth(endpoint, options = {}) {
    const allStorage = await chrome.storage.local.get(null);
    const loginPayload = allStorage._loginPayload ?? {};

    // Dump ALL stored key names to diagnose token field mismatches
    const storedKeys = Object.keys(allStorage);
    console.debug('[Teamther.ai] fetchWithAuth', endpoint, '| stored keys:', storedKeys.join(', '));

    // Auth keys actually present (non-empty)
    const authKeys = ['access','access_token','token','refresh','refresh_token','isLoggedIn'];
    const presentKeys = authKeys.filter(k => !!allStorage[k]);
    console.debug('[Teamther.ai] fetchWithAuth | non-empty auth keys:', presentKeys.join(', ') || 'NONE');

    let bearerToken =
        allStorage.access         ||
        allStorage.access_token   ||
        allStorage.token          ||
        loginPayload.access       ||
        loginPayload.access_token ||
        loginPayload.token        ||
        loginPayload.key          ||
        loginPayload.jwt          ||
        '';

    // If no token at all, attempt a silent refresh before failing
    if (!bearerToken) {
        console.warn('[Teamther.ai] fetchWithAuth: no token in storage, trying silent refresh...');
        const refreshed = await tryRefreshAccessToken();
        if (!refreshed) {
            const err = new Error('SESSION_EXPIRED');
            err.status = 401;
            throw err;
        }
        bearerToken = refreshed;
    }

    console.debug('[Teamther.ai] fetchWithAuth: using token (first 20 chars):', bearerToken.substring(0, 20) + '...');

    // ── First attempt with Bearer prefix ─────────────────────────────────────
    let firstErr;
    try {
        return await apiFetch(endpoint, {
            ...options,
            headers: {
                Authorization: `Bearer ${bearerToken}`,
                ...(options.headers || {}),
            },
        });
    } catch (err) {
        if (err.status !== 401) throw err;
        firstErr = err;
        console.debug('[Teamther.ai] fetchWithAuth: Bearer prefix got 401, trying "Token" prefix (DRF default)...');
    }

    // ── Second attempt with "Token" prefix (Django DRF TokenAuth) ─────────────
    try {
        return await apiFetch(endpoint, {
            ...options,
            headers: {
                Authorization: `Token ${bearerToken}`,
                ...(options.headers || {}),
            },
        });
    } catch (err) {
        if (err.status !== 401) throw err;
        console.debug('[Teamther.ai] fetchWithAuth: "Token" prefix also got 401, trying token refresh...');
    }

    // ── Silent token refresh + retry ─────────────────────────────────────────
    const newToken = await tryRefreshAccessToken();

    if (!newToken) {
        const err = new Error('SESSION_EXPIRED');
        err.status = 401;
        throw err;
    }

    // Retry with fresh token (Bearer)
    try {
        return await apiFetch(endpoint, {
            ...options,
            headers: {
                Authorization: `Bearer ${newToken}`,
                ...(options.headers || {}),
            },
        });
    } catch (retryErr) {
        if (retryErr.status === 401) {
            const err = new Error('SESSION_EXPIRED');
            err.status = 401;
            throw err;
        }
        throw retryErr;
    }
}



// ---------------------------------------------------------------------------
// Auth — User Profile
// ---------------------------------------------------------------------------

/**
 * GET /me/
 * Returns the current user's profile including package name and credits used.
 *
 * Expected response shape:
 * {
 *   id, email,
 *   package: { name, credits_ai_cv_analysis },
 *   credits_used: number
 * }
 *
 * @returns {Promise<object>} user profile object
 */
export async function getUserProfile() {
    const rawData = await fetchWithAuth('/me/');
    const profile = rawData.data ?? rawData;

    // Log so you can see the exact field names returned by the API
    console.debug('[Teamther.ai] getUserProfile() raw profile:', JSON.stringify(profile));

    // Cache the updated user object so banner data survives service worker restarts
    await chrome.storage.local.set({ user: profile });

    return profile;
}

// ---------------------------------------------------------------------------
// Auth — Logout
// ---------------------------------------------------------------------------

/**
 * Clears all auth-related keys from chrome.storage.local and
 * resets isLoggedIn to false.
 */
export async function logout() {
    await chrome.storage.local.remove(['isLoggedIn', 'access', 'refresh', 'user', '_loginPayload']);
    await chrome.storage.local.set({ isLoggedIn: false });
}

// ---------------------------------------------------------------------------
// CV Analysis — Authenticated Path (Async Job-Based Flow)
// ---------------------------------------------------------------------------

/** Reads the stored Bearer token from all possible storage keys. */
async function getStoredBearerToken() {
    const stored = await chrome.storage.local.get(['access', 'access_token', 'token', '_loginPayload']);
    const lp = stored._loginPayload ?? {};
    return stored.access || stored.access_token || stored.token ||
           lp.tokens?.access || lp.access || lp.access_token || lp.token || '';
}

/**
 * Generates a stable, hash-based cache key from all three job fields combined.
 * Ensures any change to title, description, or language produces a new key.
 */
async function getJobCacheKey(jobTitle, jobDescription, jobLanguage) {
    const raw = `${(jobTitle || '').trim()}||${(jobDescription || '').trim()}||${(jobLanguage || '').trim()}`;
    const msgBuffer = new TextEncoder().encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return 'extjob_' + hash.substring(0, 32);
}

/**
 * Finds or creates a dedicated job for this job title.
 * Caches the job ID in chrome.storage.local so we don't create duplicates.
 * Returns the numeric job ID.
 */
async function getOrCreateExtensionJob(jobTitle, jobDescription, jobLanguage) {
    // Hash-based cache key derived from all three fields — any change triggers a new job
    const safeKey = await getJobCacheKey(jobTitle, jobDescription, jobLanguage);
    const cached = await chrome.storage.local.get(safeKey);
    if (cached[safeKey]) return cached[safeKey];



    // Build language-aware weight config
    const langName = (jobLanguage || '').trim();
    const hasLanguage = langName.length > 0;

    const languageConfig = hasLanguage
        ? {
            // Core weights must sum to 100 (backend validates only these three)
            experience_weight: 40,
            skills_weight:     40,
            education_weight:  20,
            // language_weight is a separate field, not included in the 100% validation
            language_weight:   10,
            languages_enabled: true,
            languages: [{ name: langName, level: 'professional' }],
          }
        : {
            experience_weight: 40,
            skills_weight:     40,
            education_weight:  20,
            language_weight:   0,
            languages_enabled: false,
            languages: [],
          };

    // Create a new job for this job title/description
    const created = await fetchWithAuth('/jobs/create/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: `[Ext] ${jobTitle}`,
            description: jobDescription || jobTitle,
            // skills is required (cannot be empty) — send at least one entry
            skills: [{ name: jobTitle, priority: 1 }],
            ...languageConfig,
        }),
    });

    const jobId = created.data?.id ?? created.id;
    if (!jobId) throw new Error('Could not create a screening job. Check your account permissions.');

    // Clear stale extjob_ cache entries so old unused jobs don't accumulate
    const allStorage = await chrome.storage.local.get(null);
    const oldJobKeys = Object.keys(allStorage).filter(k => k.startsWith('extjob_') && k !== safeKey);
    if (oldJobKeys.length > 0) {
        await chrome.storage.local.remove(oldJobKeys);
        console.warn('[Teamther.ai] Cleared old job cache keys:', oldJobKeys);
    }

    await chrome.storage.local.set({ [safeKey]: jobId });
    console.warn('[Teamther.ai] Created extension job ID:', jobId, 'for title:', jobTitle, '| language:', langName || '(none)');
    return jobId;
}

/**
 * Authenticated CV analysis — synchronous JSON endpoint.
 *
 * POST /ext/user/analyze-cv/
 *
 * Sends cv_text as a JSON body (no FormData, no file upload) and receives
 * the complete analysis result synchronously in a single round-trip.
 *
 * @param {object} opts
 * @param {string} opts.cv_text          — full extracted profile/CV text
 * @param {string} opts.source_url       — URL of the scraped profile (or 'PDF_Upload')
 * @param {string} opts.jobTitle         — job title saved by recruiter
 * @param {string} opts.jobDescription   — job description saved by recruiter
 * @param {string} [opts.candidateName]  — candidate name extracted by scraper
 *
 * @returns {Promise<{
 *   score: number,
 *   recommendation: string,
 *   strengths: string[],
 *   weaknesses: string[],
 *   reasoning: string|null,
 *   experience_score: number|null,
 *   skills_score: number|null,
 *   education_score: number|null,
 *   language_score: number|null,
 *   credits_remaining: number|null,
 *   cv_upload_id: number|null,
 * }>}
 */
export async function analyzeCVAuth({ cv_text, source_url, jobTitle, jobDescription, jobLanguage, candidateName }) {
    // Step 1 — Resolve the job ID dynamically (cache → API list → create new).
    const jobId = await getOrCreateExtensionJob(jobTitle, jobDescription, jobLanguage);
    console.warn('[Teamther.ai] analyzeCVAuth: resolved job ID', jobId);

    // Step 2 — POST cv_text as JSON to the synchronous analyze endpoint.
    let rawResult;
    try {
        rawResult = await fetchWithAuth('/ext/user/analyze-cv/', {
            method: 'POST',
            body: JSON.stringify({
                cv_text,
                job_id:         jobId,
                source_url:     source_url ?? '',
                candidate_name: candidateName ?? '',
                extension_id:   EXTENSION_ID,
            }),
        });
    } catch (apiErr) {
        // fetchWithAuth throws on non-2xx with err.status set.
        // Re-map 403 to CREDITS_EXHAUSTED so background.js shows the upgrade prompt.
        if (apiErr.status === 403) {
            const e = new Error('CREDITS_EXHAUSTED');
            e.status = 403;
            throw e;
        }
        throw apiErr;
    }

    // ── Parse result ──────────────────────────────────────────────────────────
    // fetchWithAuth already parsed JSON and threw on HTTP errors.
    // rawResult is: { success, data: { analysis, credits_remaining, cv_upload_id }, ... }
    const result = rawResult;

    // Guard: HTTP 200 but success: false in body
    if (result.success !== true) {
        const errMsg = result.error?.message ?? result.message ?? 'Analysis returned a failure response.';
        const err = new Error(errMsg);
        err.status = result.error?.code ?? 400;
        throw err;
    }

    const data      = result.data         ?? {};
    const analysis  = data.analysis       ?? {};

    console.warn('[Teamther.ai] analyzeCVAuth: success. score:', analysis.score, '| credits_remaining:', data.credits_remaining);

    return {
        score:             analysis.score              ?? analysis.overall_score  ?? 0,
        recommendation:    analysis.recommendation     ?? analysis.result         ?? 'N/A',
        strengths:         analysis.strengths          ?? [],
        weaknesses:        analysis.weaknesses         ?? [],
        reasoning:         analysis.reasoning          ?? analysis.analysis       ?? null,
        // Sub-scores (populated if backend returns them)
        experience_score:  analysis.experience_score   ?? analysis.exp_score      ?? null,
        skills_score:      analysis.skills_score       ?? analysis.comp_score     ?? null,
        education_score:   analysis.education_score    ?? analysis.edu_score      ?? null,
        language_score:    analysis.language_score     ?? analysis.lan_score      ?? null,
        // New fields from the synchronous endpoint
        credits_remaining: data.credits_remaining      ?? null,
        cv_upload_id:      data.cv_upload_id           ?? null,
    };
}
