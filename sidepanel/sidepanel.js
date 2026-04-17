// =============================================================================
// Teamther.ai — Side Panel Controller (sidepanel.js)
//
// Responsibilities:
//   1. i18n (EN / FR) with chrome.storage persistence
//   2. Load saved job context from chrome.storage on open
//   3. Save job context on "Save Job" click
//   4. Update the scan quota badge
//   5. Handle "Score Profile on Screen" — send SCORE_CANDIDATE to background,
//      render animated results on success, show descriptive errors on fail
//   6. Handle "Upload PDF Resume" — use pdf.js to extract text client-side,
//      send SCORE_PDF to background, render results the same way
//   7. "Score Another Profile" reset
// =============================================================================

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. i18n Dictionary
// ─────────────────────────────────────────────────────────────────────────────

const TRANSLATIONS = {
    en: {
        loginBtn: 'Login',
        logoutBtn: 'Logout',
        registerNow: 'Register Now',
        scansLeft: ' / 5 Free Scans Left',
        upgrade: 'Upgrade',
        activeJobTitle: 'Active Job Context',
        saved: 'Saved ✓',
        jobTitleLabel: 'Job Title',
        jobTitlePlaceholder: 'e.g. Senior Frontend Engineer',
        jobDescLabel: 'Job Description',
        jobDescPlaceholder: 'Paste the job description here…',
        saveJob: 'Save Job',
        scoreBtn: 'Score Profile on Screen',
        scoreBtnLoading: 'Analyzing…',
        uploadPdf: 'Upload PDF Resume',
        pdfExtracting: 'Extracting PDF…',
        pdfAnalyzing: 'Analyzing PDF…',
        scoreLabel: '/ 100',
        recommendation: 'Recommendation',
        viewProfile: 'View Profile →',
        strengths: 'Strengths',
        weaknesses: 'Weaknesses',
        scoreAnother: '↩ Score Another Profile',
        footerPowered: 'Powered by',
        overallVerdict: 'Overall Verdict',
        errNoJob: '⚠ Please enter a Job Title and Job Description before scoring.',
        errNoTab: '⚠ No LinkedIn or Indeed tab found. Open a profile in another tab first.',
        errNotProfile: '⚠ Please navigate to a candidate profile page first (e.g. linkedin.com/in/username), not a feed or post page.',
        errQuota: '✨ You\'ve used all your free scans. Upgrade to Teamther.ai Pro to continue scoring unlimited profiles.',
        errGeneric: '⚠ Something went wrong. Please try again.',
        errPdfEmpty: '⚠ Could not extract text from this PDF. Please try a text-based PDF.',
        creditsUsed: 'Free credits used',
        recHire: '✅ Hire',
        recInterview: '🟡 Interview',
        recReject: '❌ Reject',
    },
    fr: {
        loginBtn: 'Connexion',
        logoutBtn: 'Déconnexion',
        registerNow: 'S\'inscrire',
        scansLeft: ' / 5 Analyses Gratuites',
        upgrade: 'Passer Pro',
        activeJobTitle: 'Contexte du Poste',
        saved: 'Sauvegardé ✓',
        jobTitleLabel: 'Titre du Poste',
        jobTitlePlaceholder: 'ex. Ingénieur Frontend Senior',
        jobDescLabel: 'Description du Poste',
        jobDescPlaceholder: 'Collez la description du poste ici…',
        saveJob: 'Sauvegarder',
        scoreBtn: '⚡ Analyser ce Profil',
        scoreBtnLoading: 'Analyse en cours…',
        uploadPdf: 'Importer un CV PDF',
        pdfExtracting: 'Extraction PDF…',
        pdfAnalyzing: 'Analyse en cours…',
        scoreLabel: '/ 100',
        recommendation: 'Recommandation',
        viewProfile: 'Voir le Profil →',
        strengths: 'Points Forts',
        weaknesses: 'Points Faibles',
        scoreAnother: '↩ Analyser un Autre Profil',
        footerPowered: 'Propulsé par',
        overallVerdict: 'Verdict Global',
        errNoJob: '⚠ Veuillez entrer un titre et une description de poste.',
        errNoTab: '⚠ Aucun onglet LinkedIn ou Indeed trouvé. Ouvrez d\'abord un profil.',
        errNotProfile: '⚠ Veuillez ouvrir une page de profil candidat (ex. linkedin.com/in/nom), pas un fil d\'actualité.',
        errQuota: '✨ Vous avez utilisé toutes vos analyses gratuites. Passez à Teamther.ai Pro pour continuer sans limite.',
        errGeneric: '⚠ Une erreur est survenue. Veuillez réessayer.',
        errPdfEmpty: '⚠ Impossible d\'extraire le texte de ce PDF. Utilisez un PDF avec du texte sélectionnable.',
        creditsUsed: 'Crédits gratuits épuisés',
        recHire: '✅ Embaucher',
        recInterview: '🟡 Entretien',
        recReject: '❌ Rejeter',
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. State
// ─────────────────────────────────────────────────────────────────────────────

let currentLang = 'en';
let isLoggedIn = false;   // mirrors chrome.storage.local 'isLoggedIn'

// ─────────────────────────────────────────────────────────────────────────────
// 3. DOM References
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
    langEN: $('langEN'),
    langFR: $('langFR'),
    langToggle: $('langToggle'),
    // Auth header buttons
    loginBtn: $('loginBtn'),
    logoutBtn: $('logoutBtn'),
    // Banner
    guestBanner: $('guestBanner'),
    bannerIcon: $('bannerIcon'),
    guestScanText: $('guestScanText'),
    scanCountDisplay: $('scanCountDisplay'),
    scanBarFill: $('scanBarFill'),
    bannerPackage: $('bannerPackage'),
    upgradeBtn: $('upgradeBtn'),
    // Job context
    jobHistoryTrigger: $('jobHistoryTrigger'),
    jobHistoryDropdown: $('jobHistoryDropdown'),
    jobTitleInput: $('jobTitleInput'),
    jobDescInput: $('jobDescInput'),
    jobLanguageInput: $('jobLanguageInput'),
    saveJobBtn: $('saveJobBtn'),
    savedBadge: $('savedBadge'),
    scoreBtn: $('scoreBtn'),
    scoreBtnLabel: $('scoreBtnLabel'),
    scoreBtnIcon: $('scoreBtnIcon'),
    // PDF upload
    pdfUploadLabel: $('pdfUploadLabel'),
    pdfFileInput: $('pdfFileInput'),
    pdfBtnLabel: $('pdfBtnLabel'),
    pdfBtnIcon: $('pdfBtnIcon'),
    // Error & Results
    errorMsg: $('errorMsg'),
    resultsContainer: $('resultsContainer'),
    candidateName: $('candidateName'),
    scoreNumber: $('scoreNumber'),
    ringFill: $('ringFill'),
    recBadge: $('recBadge'),
    sourceLink: $('sourceLink'),
    strengthsList: $('strengthsList'),
    weaknessesList: $('weaknessesList'),
    reasoningCard: $('reasoningCard'),
    reasoningText: $('reasoningText'),
    resetBtn: $('resetBtn'),
    // Login View
    loginView: $('loginView'),
    loginEmail: $('loginEmail'),
    loginPassword: $('loginPassword'),
    loginError: $('loginError'),
    signInBtn: $('signInBtn'),
    signInBtnIcon: $('signInBtnIcon'),
    signInBtnLabel: $('signInBtnLabel'),
    backBtn: $('backBtn'),
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. pdf.js Worker Configuration
// ─────────────────────────────────────────────────────────────────────────────

// Must be set before any pdfjsLib calls.
// Points to the locally bundled worker (MV3 CSP blocks remote scripts).
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL('lib/pdf.worker.min.js');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. i18n Helpers
// ─────────────────────────────────────────────────────────────────────────────

function applyTranslations() {
    const T = TRANSLATIONS[currentLang];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (T[key] !== undefined) el.textContent = T[key];
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        if (T[key] !== undefined) el.placeholder = T[key];
    });

    els.langEN.classList.toggle('active', currentLang === 'en');
    els.langFR.classList.toggle('active', currentLang === 'fr');
}

function t(key) {
    return TRANSLATIONS[currentLang][key] ?? key;
}

function toggleLanguage() {
    currentLang = currentLang === 'en' ? 'fr' : 'en';
    chrome.storage.local.set({ lang: currentLang });
    applyTranslations();
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Scan Badge & Progress Bar
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SCANS = 5;

/**
 * Updates the guest scan badge and progress bar.
 * When logged in, the progress bar reflects used/total credits instead.
 *
 * @param {number} remaining  — remaining scans (guest) or credits (auth)
 * @param {number} [total=5]  — total credits (auth only; defaults to MAX_SCANS)
 */
function updateScanBadge(remaining, total = MAX_SCANS) {
    const count = Math.max(0, remaining ?? 0);
    els.scanCountDisplay.textContent = count;

    const usedFraction = (total - count) / total;
    const fillPct = Math.max(0, 100 - usedFraction * 100);
    els.scanBarFill.style.width = `${fillPct}%`;

    els.guestBanner.classList.remove('warn', 'danger');
    if (count === 0) els.guestBanner.classList.add('danger');
    else if (count <= 2) els.guestBanner.classList.add('warn');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6b. Auth Banner Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Updates the guest banner to show the user's package name and remaining credits.
 * Called on login and after every authenticated score.
 *
 * @param {object} profile — user profile object from GET_USER_PROFILE / LOGIN
 */
function updateBannerForAuth(profile) {
    if (!profile) return;

    // Log the raw profile so field names are visible in DevTools → Extensions → Service Worker
    console.debug('[Teamther.ai] updateBannerForAuth profile:', JSON.stringify(profile));

    const pkg = profile.package ?? profile.subscription ?? profile.plan ?? {};

    // Try every field name the API might use for the credit limit.
    // effective_total_ai_limit is checked FIRST — it is the computed total including
    // base package credits + purchased top-ups and is the most accurate source.
    // custom_total_ai_limit is the user-level override (e.g. 500).
    // total_transaction_ai is the package-level base (e.g. 250).
    // NOTE: default is null (not 0) so we can distinguish "field not found" from "genuinely zero"
    const totalCredits =
        profile.effective_total_ai_limit ??
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

    // Try every field name the API might use for credits consumed.
    // total_ai_usage = lifetime usage; current_month_ai_usage = this month only.
    const used =
        profile.total_ai_usage         ??
        profile.credits_used           ??
        profile.used_credits           ??
        profile.ai_credits_used        ??
        profile.cv_analysis_used       ??
        profile.scans_used             ??
        0;

    // If we couldn't determine totals, try a direct "remaining" field
    const directRemaining =
        profile.remaining_credits    ??
        profile.credits_remaining    ??
        profile.available_credits    ??
        null;

    // Compute remaining: prefer a direct field, then total-used, then null
    const remaining = directRemaining !== null
        ? Math.max(0, directRemaining)
        : totalCredits !== null
            ? Math.max(0, totalCredits - used)
            : null;

    const packageName = pkg.name ?? pkg.title ?? pkg.plan_name ?? 'Pro Package';

    // Show package badge, hide guest scan text
    els.guestScanText.hidden = true;
    els.bannerPackage.hidden = false;

    // Only show "Unlimited" when we genuinely have NO credit data at all.
    // If totalCredits or directRemaining exist, always show the real number.
    const creditLabel = (totalCredits === null && directRemaining === null)
        ? `${packageName} — Unlimited`
        : `${packageName} — ${remaining ?? 0} credits left`;

    els.bannerPackage.textContent = creditLabel;

    // Drive the progress bar with credit usage
    // Use totalCredits if known, otherwise fall back to remaining as 100% fill
    const barTotal = totalCredits ?? remaining ?? 1;
    updateScanBadge(remaining ?? 0, Math.max(barTotal, 1));

    // Hide the Upgrade CTA for paid users
    els.upgradeBtn.hidden = true;
    els.bannerIcon.textContent = '✨';
}


// ─────────────────────────────────────────────────────────────────────────────
// 7. Job Context — Save & Load
// ─────────────────────────────────────────────────────────────────────────────

async function loadJobContext() {
    const stored = await chrome.storage.local.get(['jobTitle', 'jobDescription', 'jobLanguage']);
    if (stored.jobTitle) els.jobTitleInput.value = stored.jobTitle;
    if (stored.jobDescription) els.jobDescInput.value = stored.jobDescription;
    if (stored.jobLanguage) els.jobLanguageInput.value = stored.jobLanguage;
}

// ──────────────────────────────────────────────────────────────────────────────-
// 7b. Active Jobs — Inline History Trigger (Auth users only)
// ──────────────────────────────────────────────────────────────────────────────-

/**
 * Loads active jobs from the API and builds the custom inline history dropdown.
 * - Shows the "Saved Jobs" trigger button in the Job Title label row.
 * - Clicking the trigger opens/closes a floating list below the Job Title input.
 * - Selecting a job auto-fills jobTitleInput, jobDescInput, jobLanguageInput.
 * - The manual fields always remain visible (they are the fallback / editable state).
 *
 * Called by applyAuthUI() — NEVER called for guest users.
 */
async function loadActiveJobsDropdown() {
    let jobs = [];
    try {
        const resp = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_JOBS' });
        console.warn('[Teamther.ai] GET_ACTIVE_JOBS response:', JSON.stringify(resp)?.substring(0, 800));
        if (resp?.success && Array.isArray(resp.data)) {
            jobs = resp.data;
            console.warn('[Teamther.ai] loadActiveJobsDropdown: received', jobs.length, 'job(s)');
        } else {
            console.warn('[Teamther.ai] loadActiveJobsDropdown: unexpected resp. success:', resp?.success, '| data type:', Array.isArray(resp?.data) ? 'array' : typeof resp?.data);
        }
    } catch (err) {
        console.warn('[Teamther.ai] loadActiveJobsDropdown: message failed:', err.message);
    }

    const trigger  = els.jobHistoryTrigger;
    const dropdown = els.jobHistoryDropdown;

    // ── Build the list ────────────────────────────────────────────────────────
    dropdown.innerHTML = '';

    if (jobs.length === 0) {
        // No jobs — show an empty-state row but still show the trigger
        const empty = document.createElement('div');
        empty.className = 'sp-jobs-item sp-jobs-item--empty';
        empty.textContent = 'No active jobs found';
        dropdown.appendChild(empty);
    } else {
        jobs.forEach(job => {
            const item = document.createElement('div');
            item.className = 'sp-jobs-item';
            item.setAttribute('role', 'option');
            item.setAttribute('tabindex', '0');
            item.innerHTML = `
                <span class="sp-jobs-item-icon">💼</span>
                <span class="sp-jobs-item-title">${job.title ?? 'Untitled Job'}</span>
            `;

            const selectJob = () => {
                // Fill the manual input fields
                els.jobTitleInput.value    = job.title       ?? '';
                els.jobDescInput.value     = job.description ?? '';
                els.jobLanguageInput.value = (job.languages && job.languages[0]?.name) ?? '';
                // Persist
                saveJobContext();
                // Close the dropdown
                closeJobsDropdown();
            };

            item.addEventListener('click', selectJob);
            item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectJob(); } });
            dropdown.appendChild(item);
        });
    }

    // ── Show trigger button ───────────────────────────────────────────────────
    trigger.hidden = false;

    // ── Wire toggle (idempotent — clone to clear old listeners) ──────────────
    const freshTrigger = trigger.cloneNode(true);
    trigger.parentNode.replaceChild(freshTrigger, trigger);
    els.jobHistoryTrigger = freshTrigger;

    freshTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !dropdown.hidden;
        if (isOpen) {
            closeJobsDropdown();
        } else {
            openJobsDropdown();
        }
    });
}

function openJobsDropdown() {
    const trigger  = els.jobHistoryTrigger;
    const dropdown = els.jobHistoryDropdown;
    dropdown.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
}

function closeJobsDropdown() {
    const trigger  = els.jobHistoryTrigger;
    const dropdown = els.jobHistoryDropdown;
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
}

function saveJobContext() {
    const title = els.jobTitleInput.value.trim();
    const desc = els.jobDescInput.value.trim();
    const lang = els.jobLanguageInput.value.trim();

    if (!title && !desc) return;

    chrome.storage.local.set({ jobTitle: title, jobDescription: desc, jobLanguage: lang });

    els.savedBadge.hidden = false;
    setTimeout(() => { els.savedBadge.hidden = true; }, 2500);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Results Rendering
// ─────────────────────────────────────────────────────────────────────────────

const CIRCUMFERENCE = 2 * Math.PI * 50;

function animateRing(score) {
    const clampedScore = Math.max(0, Math.min(100, score));
    const offset = CIRCUMFERENCE - (clampedScore / 100) * CIRCUMFERENCE;

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            els.ringFill.style.strokeDashoffset = offset;
        });
    });

    els.ringFill.classList.remove(
        'score-excellent', 'score-fort', 'score-acceptable',
        'score-faible', 'score-inapte'
    );
    if (clampedScore >= 91)      els.ringFill.classList.add('score-excellent');
    else if (clampedScore >= 76) els.ringFill.classList.add('score-fort');
    else if (clampedScore >= 61) els.ringFill.classList.add('score-acceptable');
    else if (clampedScore >= 38) els.ringFill.classList.add('score-faible');
    else                         els.ringFill.classList.add('score-inapte');
}

function animateScore(targetScore) {
    const duration = 1000;
    const start = performance.now();
    const to = Math.max(0, Math.min(100, targetScore));

    function step(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        els.scoreNumber.textContent = Math.round(to * eased);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

/**
 * Returns tier CSS class + French label for a given numeric score.
 * Tiers match the dashboard: Excellent / Fort / Acceptable / Faible / Inapte
 */
function getTierInfo(score) {
    if (score >= 91) return { cls: 'tier-excellent', label: 'Excellent' };
    if (score >= 76) return { cls: 'tier-fort',       label: 'Fort' };
    if (score >= 61) return { cls: 'tier-acceptable', label: 'Acceptable' };
    if (score >= 38) return { cls: 'tier-faible',     label: 'Faible' };
    return              { cls: 'tier-inapte',     label: 'Inapte' };
}

function getRecInfo(rec) {
    const r = (rec || '').toLowerCase();
    if (r === 'hire') return { cls: 'hire', label: t('recHire') };
    if (r === 'interview') return { cls: 'interview', label: t('recInterview') };
    return { cls: 'reject', label: t('recReject') };
}

function populateList(ulEl, items) {
    ulEl.innerHTML = '';
    (items || []).forEach(item => {
        const li = document.createElement('li');
        li.textContent = item;
        ulEl.appendChild(li);
    });
}

/**
 * Animate a single sub-score bar and update its numeric display.
 * @param {string} barId      — id of the .sp-subscore-bar element
 * @param {string} valId      — id of the value <span>
 * @param {number} score      — 0-100
 * @param {HTMLElement} card  — the subscores card element (shown if hidden)
 */
function renderSubscore(barId, valId, score, card) {
    const bar = document.getElementById(barId);
    const val = document.getElementById(valId);
    if (!bar || !val) return;

    const pct = Math.max(0, Math.min(100, Math.round(score || 0)));
    val.textContent = pct;

    // Animate after next paint so the CSS transition fires
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            bar.style.width = `${pct}%`;
        });
    });

    if (card) card.hidden = false;
}

/**
 * Render all sub-scores from the API response.
 * Expected keys (tries multiple field name variants):
 *   experience_score / exp_score / experience
 *   skills_score / competences_score / comp_score / skills
 *   education_score / edu_score / education
 *   languages_score / lan_score / language_score / languages
 */
function renderSubscores(data) {
    const card = document.getElementById('subscoresCard');
    if (!card) return;

    // Try every known field name variant from the API
    const sub = data.sub_scores ?? data.subscores ?? data.scores ?? data ?? {};

    // Log the raw sub object so we can see exactly what the API returns
    console.debug('[Teamther.ai] renderSubscores sub:', JSON.stringify(sub));

    const expVal  = sub.experience_score  ?? sub.exp_score         ?? sub.experience   ?? 0;
    const compVal = sub.skills_score      ?? sub.competences_score  ?? sub.comp_score   ?? sub.skills       ?? 0;
    const eduVal  = sub.education_score   ?? sub.edu_score          ?? sub.education    ?? 0;
    const lanVal  = sub.languages_score   ?? sub.lan_score          ?? sub.language_score ?? sub.languages  ?? 0;

    // Always show the column — bars animate from 0 if no data returned
    card.hidden = false;

    renderSubscore('barExp',  'valExp',  expVal,  null);
    renderSubscore('barComp', 'valComp', compVal, null);
    renderSubscore('barEdu',  'valEdu',  eduVal,  null);
    renderSubscore('barLan',  'valLan',  lanVal,  null);
}

/**
 * Render the full results card from a SCORE_CANDIDATE or SCORE_PDF response.
 * @param {object} data
 */
function renderResults(data) {
    const { score, recommendation, strengths, weaknesses, reasoning, candidateName, source_url } = data;

    els.candidateName.textContent = candidateName || '';

    // API may return score as a float string like "85.00"
    const numericScore = Math.round(parseFloat(score) || 0);
    animateRing(numericScore);
    animateScore(numericScore);

    // Use tier-based badge (French label matching dashboard)
    const { cls, label } = getTierInfo(numericScore);
    els.recBadge.textContent = label;
    els.recBadge.className = `sp-rec-badge ${cls}`;

    // Source link — for PDF uploads source_url is "PDF_Upload", hide the link
    if (source_url && source_url !== 'PDF_Upload') {
        els.sourceLink.href = source_url;
        els.sourceLink.hidden = false;
    } else {
        els.sourceLink.hidden = true;
    }

    // Sub-scores
    renderSubscores(data);

    populateList(els.strengthsList, strengths);
    populateList(els.weaknessesList, weaknesses);

    const overallText = reasoning?.overall || reasoning?.summary || '';
    if (overallText) {
        els.reasoningText.textContent = overallText;
        els.reasoningCard.hidden = false;
    } else {
        els.reasoningCard.hidden = true;
    }

    els.resultsContainer.hidden = false;
    els.scoreBtn.hidden = true;
    // Also hide the PDF button area after a result is shown
    document.querySelector('.sp-or-divider').hidden = true;
    els.pdfUploadLabel.hidden = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Error Display
// ─────────────────────────────────────────────────────────────────────────────

function showError(msg) {
    els.errorMsg.textContent = msg;
    els.errorMsg.hidden = false;
}

function clearError() {
    els.errorMsg.hidden = true;
    els.errorMsg.textContent = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Loading State helpers
// ─────────────────────────────────────────────────────────────────────────────

function tiny(id) { return document.getElementById(id); }

function setLoading(isLoading) {
    els.scoreBtn.disabled = isLoading;
    els.pdfUploadLabel.classList.toggle('disabled', isLoading);
    els.scoreBtnLabel.textContent = isLoading ? t('scoreBtnLoading') : t('scoreBtn');
    tiny('scoreBtnIcon').textContent = isLoading ? '🔄' : '⚡';
    tiny('scoreBtnIcon').classList.toggle('spinning', isLoading);
}

function setPdfLoading(isExtracting) {
    els.pdfBtnLabel.textContent = isExtracting ? t('pdfExtracting') : t('uploadPdf');
    els.pdfBtnIcon.textContent = isExtracting ? '⏳' : '📄';
    els.pdfUploadLabel.classList.toggle('loading', isExtracting);
    // Disable score button too so user can't double-submit
    els.scoreBtn.disabled = isExtracting;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Tab Finder (for Screen Scoring)
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_PATTERNS = [
    'linkedin.com/in/',
    'linkedin.com/talent/profile/',
    'indeed.com/r/',
    'indeed.com/resume/',
    'indeed.com/profile/',
];
const SITE_PATTERNS = ['linkedin.com', 'indeed.com'];

const isProfile = url => PROFILE_PATTERNS.some(p => url.includes(p));
const isSite = url => SITE_PATTERNS.some(p => url.includes(p));

async function findBestTab() {
    const allTabs = await chrome.tabs.query({ windowType: 'normal' });

    const activeProfile = allTabs.find(t => t.active && isProfile(t.url || ''));
    if (activeProfile) return { tab: activeProfile, isProfilePage: true };

    const anyProfile = allTabs.find(t => isProfile(t.url || ''));
    if (anyProfile) return { tab: anyProfile, isProfilePage: true };

    const activeSite = allTabs.find(t => t.active && isSite(t.url || ''));
    if (activeSite) return { tab: activeSite, isProfilePage: false };

    const anySite = allTabs.find(t => isSite(t.url || ''));
    if (anySite) return { tab: anySite, isProfilePage: false };

    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Session-Expired Recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when the background reports SESSION_EXPIRED.
 * Resets local auth state and opens the Login View so the user can re-authenticate.
 */
function handleSessionExpired() {
    isLoggedIn = false;
    applyGuestUI();
    // Small delay so the error message is visible before the overlay opens
    setTimeout(() => {
        showLoginView();
    }, 800);
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Score Profile on Screen
// ─────────────────────────────────────────────────────────────────────────────

async function handleScoreClick() {
    clearError();

    const jobTitle = els.jobTitleInput.value.trim();
    const jobDescription = els.jobDescInput.value.trim();
    const jobLanguage = els.jobLanguageInput.value.trim();

    if (!jobTitle || !jobDescription) {
        showError(t('errNoJob'));
        return;
    }

    chrome.storage.local.set({ jobTitle, jobDescription, jobLanguage });

    const found = await findBestTab();

    if (!found) {
        showError(t('errNoTab'));
        return;
    }

    if (!found.isProfilePage) {
        showError(t('errNotProfile'));
        return;
    }

    const activeTab = found.tab;
    setLoading(true);

    try {
        console.log('[Debug] Sending jobLanguage:', jobLanguage);
        const response = await chrome.runtime.sendMessage({
            action: 'SCORE_CANDIDATE',
            tabId: activeTab.id,
            jobTitle,
            jobDescription,
            jobLanguage,
        });

        if (!response?.success) {
            if (response?.error === 'QUOTA_EXCEEDED' || response?.remainingScans === 0) {
                // Guest quota hit
                showError(t('errQuota'));
            } else if (response?.error === 'CREDITS_EXHAUSTED') {
                // Paid credits used up — stay logged in, show upgrade prompt
                showError('✨ You\'ve used all your plan credits. Visit Teamther.ai to upgrade your package.');
            } else if (response?.error === 'SESSION_EXPIRED') {
                // Session expired — show message, do NOT auto-logout (may just be a token issue)
                showError('⚠ Authentication error. Please log out and log back in.');
            } else {
                showError(response?.error || t('errGeneric'));
            }
            return;
        }

        // Update banner — auth path returns creditsRemaining via GET_USER_PROFILE refresh
        if (isLoggedIn) {
            const profileResp = await chrome.runtime.sendMessage({ action: 'GET_USER_PROFILE' });
            if (profileResp?.success) updateBannerForAuth(profileResp.data);
        } else {
            updateScanBadge(response.data.remainingScans);
        }

        renderResults(response.data);

    } catch (err) {
        showError(err?.message || t('errGeneric'));
    } finally {
        setLoading(false);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. PDF Upload & Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract all text from a PDF File object using pdf.js.
 * Iterates every page, concatenates their text items.
 *
 * @param {File} file
 * @returns {Promise<string>} extracted text
 */
async function extractTextFromPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const pageTexts = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        // Join items on each page; items are word/glyph spans
        const pageText = content.items
            .map(item => item.str)
            .join(' ');
        pageTexts.push(pageText);
    }

    return pageTexts
        .join('\n\n')
        .replace(/[ \t]+/g, ' ')        // collapse horizontal whitespace
        .replace(/\n{3,}/g, '\n\n')     // collapse excessive blank lines
        .trim();
}

async function handlePdfUpload(event) {
    const file = event.target.files[0];
    // Reset the input so the same file can be re-uploaded if needed
    els.pdfFileInput.value = '';

    if (!file) return;

    // ── 5 MB file size limit ─────────────────────────────────────────────────
    const MAX_PDF_BYTES = 5 * 1024 * 1024; // 5 MB
    if (file.size > MAX_PDF_BYTES) {
        els.pdfFileInput.value = '';
        showError('File size exceeds 5MB limit. Please upload a smaller file.');
        return;
    }

    clearError();

    const jobTitle = els.jobTitleInput.value.trim();
    const jobDescription = els.jobDescInput.value.trim();
    const jobLanguage = els.jobLanguageInput.value.trim();

    if (!jobTitle || !jobDescription) {
        showError(t('errNoJob'));
        return;
    }

    chrome.storage.local.set({ jobTitle, jobDescription, jobLanguage });

    // ── Phase 1: Extract text from PDF ───────────────────────────────────────
    setPdfLoading(true);

    let cvText;
    try {
        cvText = await extractTextFromPdf(file);
    } catch (err) {
        showError(`⚠ PDF extraction failed: ${err.message || 'Unknown error.'}`);
        setPdfLoading(false);
        return;
    }

    if (!cvText || cvText.length < 50) {
        showError(t('errPdfEmpty'));
        setPdfLoading(false);
        return;
    }

    // ── Phase 2: Send to background for AI analysis ───────────────────────────
    els.pdfBtnLabel.textContent = t('pdfAnalyzing');
    els.pdfBtnIcon.textContent = '🤖';

    try {
        console.log('[Debug] Sending jobLanguage:', jobLanguage);
        const response = await chrome.runtime.sendMessage({
            action: 'SCORE_PDF',
            cvText,
            fileName: file.name,
            jobTitle,
            jobDescription,
            jobLanguage,
        });

        if (!response?.success) {
            if (response?.error === 'QUOTA_EXCEEDED' || response?.remainingScans === 0) {
                showError(t('errQuota'));
            } else if (response?.error === 'SESSION_EXPIRED' || response?.error?.includes('log in again')) {
                showError('⚠ Authentication error. Please log out and log back in.');
            } else {
                showError(response?.error || t('errGeneric'));
            }
            return;
        }


        // Update banner — same logic as SCORE_CANDIDATE
        if (isLoggedIn) {
            const profileResp = await chrome.runtime.sendMessage({ action: 'GET_USER_PROFILE' });
            if (profileResp?.success) updateBannerForAuth(profileResp.data);
        } else {
            updateScanBadge(response.data.remainingScans);
        }

        renderResults(response.data);

    } catch (err) {
        showError(err?.message || t('errGeneric'));
    } finally {
        setPdfLoading(false);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Reset
// ─────────────────────────────────────────────────────────────────────────────

function resetView() {
    els.resultsContainer.hidden = true;
    els.scoreBtn.hidden = false;
    document.querySelector('.sp-or-divider').hidden = false;
    els.pdfUploadLabel.hidden = false;

    els.ringFill.style.strokeDashoffset = CIRCUMFERENCE;
    els.ringFill.classList.remove(
        'score-excellent', 'score-fort', 'score-acceptable',
        'score-faible', 'score-inapte'
    );
    els.scoreNumber.textContent = '0';
    els.recBadge.textContent = '—';
    els.recBadge.className = 'sp-rec-badge';
    els.candidateName.textContent = '';
    els.strengthsList.innerHTML = '';
    els.weaknessesList.innerHTML = '';

    // Reset sub-scores
    ['barExp','barComp','barEdu','barLan'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.width = '0';
    });
    ['valExp','valComp','valEdu','valLan'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '0';
    });
    const subCard = document.getElementById('subscoresCard');
    if (subCard) subCard.hidden = false; // Keep visible — always part of two-column layout


    els.reasoningCard.hidden = true;
    els.reasoningText.textContent = '';

    clearError();
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. Login View
// ─────────────────────────────────────────────────────────────────────────────

function showLoginView() {
    els.loginView.hidden = false;
    // Clear previous state
    els.loginEmail.value = '';
    els.loginPassword.value = '';
    els.loginError.hidden = true;
    els.loginError.textContent = '';
    els.signInBtnLabel.textContent = 'Sign In';
    els.signInBtnIcon.textContent = '🔐';
    els.signInBtn.disabled = false;
    // Auto-focus email for UX
    setTimeout(() => els.loginEmail.focus(), 60);
}

function hideLoginView() {
    els.loginView.hidden = true;
}

async function handleLogin() {
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value;

    if (!email || !password) {
        els.loginError.textContent = '⚠ Please enter your email and password.';
        els.loginError.hidden = false;
        return;
    }

    // Loading state on button
    els.signInBtn.disabled = true;
    els.signInBtnLabel.textContent = 'Signing in…';
    els.signInBtnIcon.textContent = '⏳';
    els.loginError.hidden = true;

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'LOGIN',
            email,
            password,
        });

        if (!response?.success) {
            els.loginError.textContent = `⚠ ${response?.error || 'Login failed. Please try again.'}`;
            els.loginError.hidden = false;
            return;
        }

        // Success — apply auth UI
        isLoggedIn = true;
        hideLoginView();
        applyAuthUI(response.data);

    } catch (err) {
        els.loginError.textContent = `⚠ ${err?.message || 'Login failed. Please try again.'}`;
        els.loginError.hidden = false;
    } finally {
        els.signInBtn.disabled = false;
        els.signInBtnLabel.textContent = 'Sign In';
        els.signInBtnIcon.textContent = '🔐';
    }
}

async function handleLogout() {
    try {
        await chrome.runtime.sendMessage({ action: 'LOGOUT' });
    } catch (_) { /* best-effort */ }

    isLoggedIn = false;
    applyGuestUI();

    // Refresh guest scan count
    try {
        const statusResp = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
        if (statusResp?.success) updateScanBadge(statusResp.data.remaining_credits);
    } catch (_) {
        updateScanBadge(5);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. Auth UI State Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Switch the panel into authenticated (paid user) state.
 * @param {object} profile — user profile from /me/ endpoint
 */
function applyAuthUI(profile) {
    els.loginBtn.hidden = true;
    els.logoutBtn.hidden = false;
    updateBannerForAuth(profile);
    // Load active jobs dropdown for authenticated users
    loadActiveJobsDropdown();
}

/**
 * Switch the panel back to guest state.
 */
function applyGuestUI() {
    els.loginBtn.hidden = false;
    els.logoutBtn.hidden = true;

    // Hide the inline jobs trigger and close any open dropdown
    if (els.jobHistoryTrigger) els.jobHistoryTrigger.hidden = true;
    if (els.jobHistoryDropdown) els.jobHistoryDropdown.hidden = true;

    // Reset banner to guest scan display
    els.guestScanText.hidden = false;
    els.bannerPackage.hidden = true;
    els.upgradeBtn.hidden = false;
    els.bannerIcon.textContent = '⚡';
    els.guestBanner.classList.remove('warn', 'danger');
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. Initialisation
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
    const stored = await chrome.storage.local.get(['lang', 'scan_count']);
    if (stored.lang) currentLang = stored.lang;
    applyTranslations();

    await loadJobContext();

    try {
        const statusResp = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
        if (statusResp?.success) {
            if (statusResp.data.isLoggedIn) {
                // Authenticated user
                isLoggedIn = true;

                // Try to fetch a fresh profile for up-to-date credit counts.
                // On ANY failure (network, 401, etc.) we ALWAYS fall back to cached user data.
                // We do NOT log the user out here — that only happens when an actual scan fails.
                let profile = statusResp.data.user; // safe default
                try {
                    const profileResp = await chrome.runtime.sendMessage({ action: 'GET_USER_PROFILE' });
                    if (profileResp?.success && profileResp.data) {
                        profile = profileResp.data;
                    } else {
                        console.warn('[Teamther.ai] init: GET_USER_PROFILE returned failure, using cached user. Error:', profileResp?.error);
                    }
                } catch (profileErr) {
                    console.warn('[Teamther.ai] init: GET_USER_PROFILE threw, using cached user:', profileErr?.message);
                }

                applyAuthUI(profile);
            } else {
                // Guest — check if this profile has permanently exhausted its free credits
                const { credits_exhausted } = await chrome.storage.local.get('credits_exhausted');
                if (credits_exhausted) {
                    // Locked at 0 — show "Free credits used" instead of scan count
                    els.scanCountDisplay.textContent = '0';
                    els.scanBarFill.style.width = '0%';
                    els.guestBanner.classList.remove('warn');
                    els.guestBanner.classList.add('danger');
                    // Replace the scan count text with the exhausted message
                    const scanTextEl = document.getElementById('guestScanText');
                    if (scanTextEl) scanTextEl.innerHTML = `<span style="font-size:0.85em;opacity:0.9">${t('creditsUsed')}</span>`;
                } else {
                    updateScanBadge(statusResp.data.remaining_credits);
                }
                if (!statusResp.data.hasToken) {
                    chrome.runtime.sendMessage({ action: 'INIT_SESSION' });
                }
            }
        }
    } catch (_) {
        // Couldn't reach background at all — read scan_count directly from storage
        const storedForScan = await chrome.storage.local.get('scan_count');
        updateScanBadge(MAX_SCANS - (storedForScan.scan_count ?? 0));
    }

    // ── Event Listeners ────────────────────────────────────────────
    els.langToggle.addEventListener('click', toggleLanguage);
    els.saveJobBtn.addEventListener('click', saveJobContext);
    els.scoreBtn.addEventListener('click', handleScoreClick);
    els.pdfFileInput.addEventListener('change', handlePdfUpload);
    els.resetBtn.addEventListener('click', resetView);

    // Auth
    els.loginBtn.addEventListener('click', showLoginView);
    els.logoutBtn.addEventListener('click', handleLogout);
    els.signInBtn.addEventListener('click', handleLogin);
    els.backBtn.addEventListener('click', hideLoginView);

    // Allow pressing Enter in password field to submit
    els.loginPassword.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLogin();
    });

    els.jobTitleInput.addEventListener('blur', () => {
        if (els.jobTitleInput.value.trim() || els.jobDescInput.value.trim()) {
            saveJobContext();
        }
    });
    // Close the jobs history dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const trigger  = els.jobHistoryTrigger;
        const dropdown = els.jobHistoryDropdown;
        if (!trigger || !dropdown) return;
        if (dropdown.hidden) return;
        // Close if the click is outside both the trigger and the dropdown panel
        if (!trigger.contains(e.target) && !dropdown.contains(e.target)) {
            closeJobsDropdown();
        }
    });
}

document.addEventListener('DOMContentLoaded', init);

// =============================================================================
// UPLOAD_CV — Renderer-side file upload (FormData works in renderer, not in SW)
// =============================================================================
//
// The MV3 service worker cannot reliably upload files via FormData.
// Background.js delegates the upload here via chrome.runtime.sendMessage
// with action: 'UPLOAD_CV', and we respond with { success, cvId } or { success: false, error }.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== 'UPLOAD_CV') return false;

    const { jobId, cvText, token, baseUrl } = message;

    (async () => {
        try {
            // ── Build a minimal valid PDF containing the CV text ──────────────────
            // The server only accepts PDF / doc / docx (not .txt).
            // We embed the raw text inside a PDF Type1 text stream so any PDF
            // reader or extraction library (pdfplumber, PyPDF2, etc.) can read it.
            const sanitized = (cvText || '')
                .replace(/\r\n/g, '\n')
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x80-\xff]/g, ' '); // ASCII-safe only

            // Split into ~90-char chunks; escape PDF string delimiters
            const chunks = [];
            for (let i = 0; i < sanitized.length; i += 90) {
                chunks.push(sanitized.substring(i, i + 90).replace(/[()\\]/g, '\\$&'));
            }

            const streamBody = 'BT\n/F1 10 Tf\n50 750 Td\n12 TL\n' +
                chunks.map(c => `(${c}) Tj T*`).join('\n') +
                '\nET';
            // Use byte length (TextEncoder) for the PDF /Length object
            const streamLen = new TextEncoder().encode(streamBody).length;

            const pdf = [
                '%PDF-1.4',
                '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
                '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
                '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
                  '/Contents 4 0 R/Resources<</Font<</F1<</Type/Font' +
                  '/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj',
                `4 0 obj<</Length ${streamLen}>>`,
                'stream',
                streamBody,
                'endstream',
                'endobj',
                'xref',
                '0 5',
                '0000000000 65535 f ',
                'trailer<</Size 5/Root 1 0 R>>',
                'startxref',
                '0',
                '%%EOF',
            ].join('\n');

            const filename = `candidate_${Date.now()}.pdf`;
            const file = new File([pdf], filename, { type: 'application/pdf' });

            const uploadUrl = `${baseUrl}/jobs/${jobId}/cvs/upload/`;
            console.warn('[Teamther.ai] UPLOAD_CV (renderer): uploading PDF to', uploadUrl,
                         '| size:', file.size, 'bytes');

            // Try common FormData field names in order until the server accepts one.
            // We cache the working field name in storage so future uploads skip the retry loop.
            const FIELD_NAMES = ['cv_files', 'file', 'files', 'cv_file', 'cv'];
            let response, respText;
            let uploaded = false;

            // Check if we already discovered the correct field name from a previous upload
            const cachedStorage = await chrome.storage.local.get('cv_upload_field');
            const cachedField = cachedStorage.cv_upload_field;
            const fieldsToTry = cachedField
                ? [cachedField, ...FIELD_NAMES.filter(f => f !== cachedField)]  // put cached first
                : FIELD_NAMES;

            for (const fieldName of fieldsToTry) {
                const formData = new FormData();
                formData.append(fieldName, file, filename);

                console.warn('[Teamther.ai] UPLOAD_CV: trying field name:', fieldName);
                response = await fetch(uploadUrl, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                    body: formData,
                });

                respText = await response.text();

                // A 400 "No files provided" means wrong field name — try next
                if (!response.ok) {
                    const isFieldNameError = respText.includes('No files provided') ||
                                            respText.includes('no file') ||
                                            respText.includes('required');
                    if (response.status === 400 && isFieldNameError) {
                        console.warn(`[Teamther.ai] UPLOAD_CV: field "${fieldName}" rejected (${response.status}), trying next…`);
                        // If the cached field stopped working, clear the cache
                        if (fieldName === cachedField) {
                            chrome.storage.local.remove('cv_upload_field');
                        }
                        continue;
                    }
                    // Any other error — stop and report immediately
                    sendResponse({ success: false, error: `Upload failed (${response.status}): ${respText}` });
                    return;
                }

                // Server accepted — cache this field name for future uploads
                console.warn('[Teamther.ai] UPLOAD_CV: accepted with field name:', fieldName);
                chrome.storage.local.set({ cv_upload_field: fieldName });
                uploaded = true;
                break;
            }

            if (!uploaded) {
                sendResponse({ success: false, error: `Upload failed (${response?.status ?? 0}): ${respText ?? 'All field name variants rejected by server.'}` });
                return;
            }

            let data;
            try { data = JSON.parse(respText); } catch {
                sendResponse({ success: false, error: 'Upload returned non-JSON: ' + respText });
                return;
            }

            // Response shape: { data: { uploaded: [{ id }], count } }
            //   OR: { data: [{ id }] }  OR: [{ id }]  OR: { id }
            const payload  = data.data ?? data;
            const arr      = payload.uploaded ?? payload.data ?? (Array.isArray(payload) ? payload : null);
            const first    = arr ? arr[0] : payload;
            const cvId     = first?.id;
            if (!cvId) {
                sendResponse({ success: false, error: 'Upload returned no ID: ' + respText });
                return;
            }

            console.warn('[Teamther.ai] UPLOAD_CV (renderer): success, cvId:', cvId);
            sendResponse({ success: true, cvId });
        } catch (err) {
            sendResponse({ success: false, error: err.message });
        }
    })();

    return true; // keep message channel open for async response
});
