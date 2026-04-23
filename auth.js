/* ═══════════════════════════════════════════════════════════════════
   CyberSense.Solutions — auth.js
   Authentication & Access Control Client
   Manages: JWT tokens, session state, tier gating, UI transitions
   ═══════════════════════════════════════════════════════════════════ */

(function (CS) {
  'use strict';

  const API = window.CS_API_BASE || 'https://api.cybersense.solutions';

  /* ─────────────────────────────────────────────────────────────────
     TOKEN STORE
     Access token: memory only (never localStorage — XSS risk)
     Refresh token: httpOnly cookie (set by server)
     User state: sessionStorage (survives tab refresh, not cross-tab)
  ───────────────────────────────────────────────────────────────── */
  let _accessToken = null;
  let _refreshPromise = null;

  const TIER_RANK = { free: 0, freemium: 1, monthly: 2, enterprise: 3 };

  function getUser() {
    try {
      const raw = sessionStorage.getItem('cs_user');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function setUser(user) {
    if (user) {
      sessionStorage.setItem('cs_user', JSON.stringify(user));
    } else {
      sessionStorage.removeItem('cs_user');
    }
  }

  function setToken(token) { _accessToken = token; }
  function getToken()      { return _accessToken; }
  function clearToken()    { _accessToken = null; }

  function isLoggedIn()    { return !!_accessToken && !!getUser(); }
  function getTierOverride() { return sessionStorage.getItem('cs_tier_override') || null; }
  function getTier()       { return getTierOverride() || getUser()?.tier || 'free'; }
  function hasMinTier(t)   { return TIER_RANK[getTier()] >= TIER_RANK[t]; }

  /* ─────────────────────────────────────────────────────────────────
     API FETCH WRAPPER
     Auto-attaches Bearer token, refreshes on 401, returns parsed body
  ───────────────────────────────────────────────────────────────── */
  async function apiFetch(path, options = {}) {
    const doFetch = async (token) => {
      const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const res = await fetch(API + path, { ...options, headers, credentials: 'include' });
      return res;
    };

    let res = await doFetch(_accessToken);

    if (res.status === 401 && path !== '/api/auth/refresh') {
      const refreshed = await silentRefresh();
      if (refreshed) {
        res = await doFetch(_accessToken);
      } else {
        handleSessionExpired();
        throw Object.assign(new Error('Session expired'), { code: 'SESSION_EXPIRED' });
      }
    }

    const data = res.headers.get('content-type')?.includes('application/json')
      ? await res.json()
      : await res.text();

    if (!res.ok) {
      const err = typeof data === 'object' ? data : { error: { message: data } };
      throw Object.assign(new Error(err.error?.message || 'Request failed'), {
        code: err.error?.code,
        status: res.status,
        field: err.error?.field,
      });
    }

    return data;
  }

  /* ─────────────────────────────────────────────────────────────────
     SILENT TOKEN REFRESH
     Called automatically on 401. Deduplicates concurrent refresh calls.
  ───────────────────────────────────────────────────────────────── */
  async function silentRefresh() {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = (async () => {
      try {
        const res = await fetch(API + '/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) return false;
        const data = await res.json();
        setToken(data.access_token);
        return true;
      } catch (e) {
        return false;
      } finally {
        _refreshPromise = null;
      }
    })();
    return _refreshPromise;
  }

  /* ─────────────────────────────────────────────────────────────────
     AUTH ACTIONS
  ───────────────────────────────────────────────────────────────── */
  async function register({ email, password, full_name }) {
    return apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, full_name }),
    });
  }

  async function login({ email, password }) {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(data.access_token);
    setUser(data.user);
    return data.user;
  }

  async function logout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (e) { /* best effort */ }
    clearToken();
    setUser(null);
    onLogout();
  }

  async function forgotPassword(email) {
    return apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async function resetPassword({ token, password }) {
    return apiFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  async function verifyEmail(token) {
    const data = await apiFetch('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    if (data.access_token) {
      setToken(data.access_token);
      // Refresh user profile after verification
      const profile = await apiFetch('/api/users/me');
      setUser(profile);
    }
    return data;
  }

  /* ─────────────────────────────────────────────────────────────────
     SESSION INIT
     On every page load: attempt silent refresh to restore session.
     If successful, update UI. If not, render as guest.
  ───────────────────────────────────────────────────────────────── */
  async function initSession() {
    // Check for email verification token in URL
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('token');
    const resetToken  = params.get('reset');

    if (verifyToken && window.location.pathname.includes('verify')) {
      await handleEmailVerification(verifyToken);
      return;
    }

    if (resetToken && window.location.pathname.includes('reset')) {
      renderResetForm(resetToken);
      return;
    }

    // Render cached profile immediately to eliminate the sign-in flash
    const cached = getUser();
    if (cached) updateNavForUser(cached);

    const refreshed = await silentRefresh();
    if (refreshed) {
      try {
        const profile = await apiFetch('/api/users/me');
        setUser(profile);
        onLogin(profile);
      } catch (e) {
        clearToken();
        setUser(null);
        onGuest();
      }
    } else {
      setUser(null);
      onGuest();
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     UI STATE CALLBACKS
     These update the DOM based on auth state.
  ───────────────────────────────────────────────────────────────── */
  function onLogin(user) {
    updateNavForUser(user);
    applyTierGates(user.tier);
    applyPageGates(user);
    document.dispatchEvent(new CustomEvent('cs:login', { detail: user }));
  }

  function onGuest() {
    updateNavForGuest();
    applyTierGates('free');
    document.dispatchEvent(new CustomEvent('cs:guest'));
  }

  function onLogout() {
    updateNavForGuest();
    applyTierGates('free');
    document.dispatchEvent(new CustomEvent('cs:logout'));
    // Redirect if on a protected page
    const protectedPages = ['dashboard.html', 'cybersense_admin_dashboard.html'];
    const currentPage = window.location.pathname.split('/').pop();
    if (protectedPages.includes(currentPage)) {
      window.location.href = 'index.html';
    } else {
      window.location.reload();
    }
  }

  function handleSessionExpired() {
    clearToken();
    setUser(null);
    showToast('Your session has expired. Please sign in again.', 'warning');
    onGuest();
  }

  /* ─────────────────────────────────────────────────────────────────
     NAV UI
  ───────────────────────────────────────────────────────────────── */
  function updateNavForUser(user) {
    // Swap Login button → user menu
    const loginBtn = document.querySelector('.nav-login');
    if (!loginBtn) return;

    const tierLabel = { free: 'Free', freemium: 'Subscriber', monthly: 'Pro', enterprise: 'Enterprise' };

    loginBtn.outerHTML = `
      <div class="nav-user-menu" id="nav-user-menu">
        <button class="nav-user-btn" id="nav-user-btn" aria-expanded="false" aria-haspopup="true">
          <span class="nav-user-avatar">${getInitials(user.full_name)}</span>
          <span class="nav-user-name">${user.full_name.split(' ')[0]}</span>
          <span class="nav-tier-badge nav-tier-${user.tier}">${tierLabel[user.tier]}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="opacity:.5"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <div class="nav-dropdown" id="nav-dropdown" role="menu">
          <div class="nav-dropdown-header">
            <div style="font-size:13px;font-weight:600;color:#1e293b;">${user.full_name}</div>
            <div style="font-size:12px;color:var(--cs-gray-400);">${user.email}</div>
          </div>
          <a href="account.html" class="nav-dropdown-item" role="menuitem">My Account</a>
          ${user.org_id ? '<a href="enterprise-dashboard.html" class="nav-dropdown-item" role="menuitem">Team Dashboard</a>' : ''}
          ${isAdminUser(user) ? '<a href="dashboard.html" class="nav-dropdown-item" role="menuitem">Admin Dashboard</a>' : ''}
          ${isAdminUser(user) ? `
          <div class="nav-dropdown-divider"></div>
          <div style="padding:6px 16px 2px;font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--cs-gray-400);">Test Tier</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;padding:4px 12px 10px;" id="tier-test-panel">
            ${['free','freemium','monthly','enterprise'].map(t => {
              const active = getTierOverride() === t;
              const labels = {free:'Free',freemium:'Freemium',monthly:'Monthly',enterprise:'Enterprise'};
              return `<button class="tier-test-btn" data-tier="${t}" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid ${active?'var(--cs-cyan)':'#e2e8f0'};background:${active?'var(--cs-cyan)':'#f8fafc'};color:${active?'#fff':'#475569'};cursor:pointer;font-weight:${active?700:400};">${labels[t]}</button>`;
            }).join('')}
          </div>` : ''}
          <div class="nav-dropdown-divider"></div>
          <button class="nav-dropdown-item nav-dropdown-signout" id="nav-signout" role="menuitem">Sign Out</button>
        </div>
      </div>`;

    // Wire dropdown toggle
    const userBtn = document.getElementById('nav-user-btn');
    const dropdown = document.getElementById('nav-dropdown');
    if (userBtn && dropdown) {
      userBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = dropdown.classList.toggle('open');
        userBtn.setAttribute('aria-expanded', open);
      });
      document.addEventListener('click', () => {
        dropdown.classList.remove('open');
        userBtn.setAttribute('aria-expanded', false);
      });
    }

    const signoutBtn = document.getElementById('nav-signout');
    if (signoutBtn) signoutBtn.addEventListener('click', logout);

    document.querySelectorAll('.tier-test-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = btn.dataset.tier;
        if (getTierOverride() === t) {
          sessionStorage.removeItem('cs_tier_override');
        } else {
          sessionStorage.setItem('cs_tier_override', t);
        }
        applyTierGates(getTier());
        updateNavForUser(getUser());
      });
    });
  }

  function updateNavForGuest() {
    const menu = document.getElementById('nav-user-menu');
    if (menu) {
      menu.outerHTML = `<button class="nav-login" onclick="CS.Auth.showLoginModal()">Login</button>`;
    }
  }

  function isAdminUser(user) {
    return !!(user?.admin_role?.role);
  }

  function getInitials(name) {
    return (name || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  }

  /* ─────────────────────────────────────────────────────────────────
     TIER GATE ENGINE
     Reads data-min-tier attributes and applies blur/lock accordingly.
     Server is the real gate — this is UX reinforcement only.
  ───────────────────────────────────────────────────────────────── */
  function applyTierGates(tier) {
    // Elements with data-min-tier="monthly" etc.
    document.querySelectorAll('[data-min-tier]').forEach(el => {
      const required = el.dataset.minTier;
      if (TIER_RANK[tier] >= TIER_RANK[required]) {
        el.classList.remove('tier-locked');
        el.removeAttribute('aria-hidden');
        const overlay = el.parentElement?.querySelector('.gate-overlay');
        if (overlay) overlay.style.display = 'none';
      } else {
        el.classList.add('tier-locked');
      }
    });

    // Radar rows beyond position 7
    const radarRows = document.querySelectorAll('.blurred-row');
    if (radarRows.length && hasMinTier('monthly')) {
      radarRows.forEach(row => {
        row.classList.remove('blurred-row');
        const parent = row.closest('.gate-wrapper');
        if (parent) {
          const overlay = parent.querySelector('.gate-overlay');
          if (overlay) overlay.style.display = 'none';
          const blurred = parent.querySelector('.blurred');
          if (blurred) blurred.classList.remove('blurred');
        }
      });
    }

    // Article content
    document.querySelectorAll('.article-card.blurred').forEach(card => {
      const required = card.dataset.minTier || 'monthly';
      if (TIER_RANK[tier] >= TIER_RANK[required]) {
        card.classList.remove('blurred');
        card.removeAttribute('aria-hidden');
        const wrapper = card.parentElement;
        if (wrapper?.classList.contains('gate-wrapper')) {
          const overlay = wrapper.querySelector('.gate-overlay');
          if (overlay) overlay.style.display = 'none';
        }
      }
    });

    // Locked training buttons
    if (hasMinTier('monthly')) {
      document.querySelectorAll('.btn-locked').forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('btn-locked');
        btn.classList.add('btn-outline');
        btn.textContent = btn.textContent.replace('🔒 ', '');
      });
    }

    // Freemium banner
    const freeBanner = document.querySelector('.freemium-banner');
    if (freeBanner) {
      freeBanner.style.display = (tier === 'free') ? 'flex' : 'none';
    }
  }

  function applyPageGates(user) {
    // Dashboard page — require admin role
    const dashShell = document.getElementById('dashboard-shell');
    const loginGate = document.getElementById('login-gate');
    if (dashShell && loginGate) {
      if (isAdminUser(user)) {
        loginGate.style.display = 'none';
        dashShell.style.display = 'grid';
        loadDashboardData();
      }
      // If not admin, keep login gate visible
    }

    // Account page
    const accountPanel = document.getElementById('account-panel');
    if (accountPanel) {
      renderAccountPanel(user);
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     LOGIN MODAL
  ───────────────────────────────────────────────────────────────── */
  function showLoginModal(options = {}) {
    const existing = document.getElementById('cs-auth-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'cs-auth-modal';
    modal.className = 'cs-modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', options.title || 'Sign in to CyberSense');
    modal.innerHTML = buildAuthModal(options);
    document.body.appendChild(modal);

    // Focus trap
    const firstInput = modal.querySelector('input');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // Close on Escape
    const escHandler = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    // Wire forms
    wireAuthModal(modal, options);
  }

  function closeModal() {
    const modal = document.getElementById('cs-auth-modal');
    if (modal) { modal.classList.add('closing'); setTimeout(() => modal.remove(), 200); }
  }

  function buildAuthModal(options) {
    const message = options.message
      ? `<div class="auth-modal-message">${options.message}</div>`
      : '';
    const tab = options.tab || 'login';

    return `
    <div class="cs-modal-card">
      <button class="cs-modal-close" id="cs-modal-close" aria-label="Close">&times;</button>
      <div class="cs-modal-logo">CyberSense<span>.Solutions</span></div>
      ${message}

      <div class="auth-tabs" role="tablist">
        <button class="auth-tab ${tab === 'login' ? 'active' : ''}" data-tab="login" role="tab" aria-selected="${tab === 'login'}">Sign In</button>
        <button class="auth-tab ${tab === 'register' ? 'active' : ''}" data-tab="register" role="tab" aria-selected="${tab === 'register'}">Create Account</button>
      </div>

      <!-- LOGIN FORM -->
      <div class="auth-panel" id="auth-panel-login" style="display:${tab === 'login' ? 'block' : 'none'}">
        <form id="cs-login-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="modal-email">Email</label>
            <input class="form-input" type="email" id="modal-email" name="email" placeholder="you@organization.com" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="modal-password">Password</label>
            <input class="form-input" type="password" id="modal-password" name="password" placeholder="••••••••••" autocomplete="current-password" required>
          </div>
          <div class="auth-error" id="login-error" role="alert" aria-live="polite"></div>
          <button type="submit" class="btn btn-primary auth-submit-btn" id="login-submit-btn">Sign In</button>
          <button type="button" class="auth-forgot-link" id="auth-forgot-link">Forgot password?</button>
        </form>
      </div>

      <!-- REGISTER FORM -->
      <div class="auth-panel" id="auth-panel-register" style="display:${tab === 'register' ? 'block' : 'none'}">
        <form id="cs-register-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="reg-name">Full Name</label>
            <input class="form-input" type="text" id="reg-name" name="full_name" placeholder="Jane Smith" autocomplete="name" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-email">Email</label>
            <input class="form-input" type="email" id="reg-email" name="email" placeholder="you@organization.com" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-password">Password</label>
            <input class="form-input" type="password" id="reg-password" name="password" placeholder="12+ characters" autocomplete="new-password" required minlength="12">
            <div class="password-strength" id="password-strength"></div>
          </div>
          <div class="auth-error" id="register-error" role="alert" aria-live="polite"></div>
          <button type="submit" class="btn btn-primary auth-submit-btn" id="register-submit-btn">Create Account</button>
          <p class="auth-terms">By creating an account you agree to our <a href="privacy.html">Privacy Policy</a> and <a href="terms.html">Terms of Service</a>.</p>
        </form>
      </div>

      <!-- FORGOT PASSWORD FORM -->
      <div class="auth-panel" id="auth-panel-forgot" style="display:none">
        <p style="font-size:14px;color:var(--cs-gray-600);margin-bottom:20px;">Enter your email address and we'll send you a reset link.</p>
        <form id="cs-forgot-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="forgot-email">Email</label>
            <input class="form-input" type="email" id="forgot-email" placeholder="you@organization.com" required>
          </div>
          <div class="auth-error" id="forgot-error" role="alert" aria-live="polite"></div>
          <div class="auth-success" id="forgot-success" role="status"></div>
          <button type="submit" class="btn btn-primary auth-submit-btn">Send Reset Link</button>
          <button type="button" class="auth-forgot-link" id="back-to-login">Back to Sign In</button>
        </form>
      </div>
    </div>`;
  }

  function wireAuthModal(modal, options) {
    // Close button
    modal.querySelector('#cs-modal-close').addEventListener('click', closeModal);

    // Tab switching
    modal.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.auth-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', false); });
        modal.querySelectorAll('.auth-panel').forEach(p => p.style.display = 'none');
        tab.classList.add('active');
        tab.setAttribute('aria-selected', true);
        modal.querySelector('#auth-panel-' + tab.dataset.tab).style.display = 'block';
      });
    });

    // Forgot password link
    const forgotLink = modal.querySelector('#auth-forgot-link');
    if (forgotLink) forgotLink.addEventListener('click', () => {
      modal.querySelectorAll('.auth-panel').forEach(p => p.style.display = 'none');
      modal.querySelector('#auth-panel-forgot').style.display = 'block';
    });

    const backToLogin = modal.querySelector('#back-to-login');
    if (backToLogin) backToLogin.addEventListener('click', () => {
      modal.querySelectorAll('.auth-panel').forEach(p => p.style.display = 'none');
      modal.querySelector('#auth-panel-login').style.display = 'block';
    });

    // Password strength meter
    const pwInput = modal.querySelector('#reg-password');
    const pwStrength = modal.querySelector('#password-strength');
    if (pwInput && pwStrength) {
      pwInput.addEventListener('input', () => {
        const score = scorePassword(pwInput.value);
        pwStrength.innerHTML = `<div class="pw-bar"><div class="pw-fill pw-fill-${score.level}" style="width:${score.pct}%"></div></div><span class="pw-label pw-label-${score.level}">${score.label}</span>`;
      });
    }

    // LOGIN FORM
    const loginForm = modal.querySelector('#cs-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = modal.querySelector('#login-submit-btn');
        const errorEl = modal.querySelector('#login-error');
        clearError(errorEl);
        setLoading(btn, true, 'Signing in…');
        try {
          const user = await login({
            email: modal.querySelector('#modal-email').value.trim(),
            password: modal.querySelector('#modal-password').value,
          });
          closeModal();
          onLogin(user);
          showToast('Welcome back, ' + user.full_name.split(' ')[0] + '!', 'success');
          if (options.onSuccess) options.onSuccess(user);
          else if (options.redirect) window.location.href = options.redirect;
        } catch (err) {
          showError(errorEl, friendlyError(err));
        } finally {
          setLoading(btn, false, 'Sign In');
        }
      });
    }

    // REGISTER FORM
    const registerForm = modal.querySelector('#cs-register-form');
    if (registerForm) {
      registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = modal.querySelector('#register-submit-btn');
        const errorEl = modal.querySelector('#register-error');
        clearError(errorEl);

        const password = modal.querySelector('#reg-password').value;
        if (password.length < 12) {
          showError(errorEl, 'Password must be at least 12 characters.'); return;
        }

        setLoading(btn, true, 'Creating account…');
        try {
          await register({
            full_name: modal.querySelector('#reg-name').value.trim(),
            email: modal.querySelector('#reg-email').value.trim(),
            password,
          });
          // Show verification message
          modal.querySelector('#auth-panel-register').innerHTML = `
            <div class="auth-verify-message">
              <div class="auth-verify-icon">✓</div>
              <h3>Check your email</h3>
              <p>We've sent a verification link to <strong>${modal.querySelector('#reg-email').value}</strong>. Click the link to activate your free account.</p>
            </div>`;
        } catch (err) {
          showError(errorEl, friendlyError(err));
        } finally {
          setLoading(btn, false, 'Create Account');
        }
      });
    }

    // FORGOT PASSWORD FORM
    const forgotForm = modal.querySelector('#cs-forgot-form');
    if (forgotForm) {
      forgotForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = modal.querySelector('#forgot-error');
        const successEl = modal.querySelector('#forgot-success');
        clearError(errorEl);
        try {
          await forgotPassword(modal.querySelector('#forgot-email').value.trim());
          successEl.textContent = 'If an account exists for this email, a reset link is on its way.';
          successEl.style.display = 'block';
        } catch (err) {
          showError(errorEl, friendlyError(err));
        }
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     EMAIL VERIFICATION HANDLER
  ───────────────────────────────────────────────────────────────── */
  async function handleEmailVerification(token) {
    try {
      const data = await verifyEmail(token);
      showToast('Email verified! Welcome to CyberSense.', 'success');
      // Clean URL
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.toString());
      if (data.access_token) onLogin(getUser());
    } catch (err) {
      showToast('Verification link is invalid or has expired. Please request a new one.', 'error');
    }
  }

  function renderResetForm(token) {
    // Find reset container or inject into body
    let container = document.getElementById('reset-password-container');
    if (!container) {
      container = document.createElement('section');
      container.id = 'reset-password-container';
      container.className = 'section';
      container.style.cssText = 'min-height:60vh;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(container);
    }
    container.innerHTML = `
      <div style="max-width:440px;width:100%;">
        <h2 style="font-size:24px;font-weight:700;color:var(--cs-navy);margin-bottom:8px;">Set a new password</h2>
        <p style="color:var(--cs-gray-600);margin-bottom:24px;">Choose a strong password of at least 12 characters.</p>
        <form id="reset-password-form">
          <div class="form-group">
            <label class="form-label">New Password</label>
            <input class="form-input" type="password" id="new-password" placeholder="12+ characters" minlength="12" required>
          </div>
          <div class="auth-error" id="reset-error" role="alert"></div>
          <div class="auth-success" id="reset-success" role="status"></div>
          <button type="submit" class="btn btn-primary">Update Password</button>
        </form>
      </div>`;

    document.getElementById('reset-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('reset-error');
      const successEl = document.getElementById('reset-success');
      clearError(errorEl);
      try {
        await resetPassword({ token, password: document.getElementById('new-password').value });
        successEl.textContent = 'Password updated. You can now sign in.';
        successEl.style.display = 'block';
        setTimeout(() => showLoginModal(), 1500);
      } catch (err) {
        showError(errorEl, friendlyError(err));
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     DASHBOARD PAGE — LIVE DATA LOADER
     Replaces the static placeholder content with real API data.
  ───────────────────────────────────────────────────────────────── */
  async function loadDashboardData() {
    try {
      const [snapshot, feed, pipelineStatus, agentHealth] = await Promise.allSettled([
        apiFetch('/api/ops/dashboard'),
        apiFetch('/api/ops/activity-feed?limit=8'),
        apiFetch('/api/ops/pipeline-status'),
        apiFetch('/api/admin/agents'),
      ]);

      if (snapshot.status === 'fulfilled') renderCommandCenterMetrics(snapshot.value);
      if (feed.status === 'fulfilled') renderActivityFeed(feed.value.data);
      if (pipelineStatus.status === 'fulfilled') renderPipelineStatus(pipelineStatus.value.data);
      if (agentHealth.status === 'fulfilled') renderAgentHealth(agentHealth.value.data);
    } catch (e) {
      console.warn('[CS Auth] Dashboard data load failed:', e.message);
    }
  }

  function renderCommandCenterMetrics(data) {
    const live = data.live || {};
    const snap = data.snapshot || {};

    const metrics = {
      'metric-subscribers':  formatNum(live.total_subscribers),
      'metric-paid':         formatNum(live.paid_accounts),
      'metric-enterprise':   formatNum(live.enterprise_accounts),
      'metric-mrr':          formatCents(live.mrr_cents),
      'metric-risks':        live.open_risk_count ?? snap.open_risk_count ?? '—',
    };

    Object.entries(metrics).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    });
  }

  function renderActivityFeed(events) {
    const container = document.getElementById('activity-feed');
    if (!container || !events?.length) return;

    const colorMap = { published: 'green', draft: 'amber', approved: 'cyan', failed: 'red' };
    container.innerHTML = events.map(ev => {
      const color = colorMap[ev.to_status] || 'cyan';
      return `
        <div class="activity-item">
          <div class="activity-icon activity-icon-${color}">
            <span style="font-size:11px;font-weight:700;color:var(--cs-${color === 'cyan' ? 'cyan' : color === 'green' ? 'green' : color === 'amber' ? 'amber' : 'red'});">${ev.agent_name?.[0] || '?'}</span>
          </div>
          <div class="activity-text">
            <p>${ev.agent_name} → <strong>${ev.to_status}</strong>${ev.content_title ? ' · ' + ev.content_title.slice(0, 60) : ''}</p>
            <span>${timeAgo(ev.created_at)}</span>
          </div>
        </div>`;
    }).join('');
  }

  function renderPipelineStatus(statuses) {
    const container = document.getElementById('pipeline-status-bars');
    if (!container || !statuses?.length) return;

    const byType = statuses.reduce((acc, r) => {
      if (!acc[r.content_type]) acc[r.content_type] = {};
      acc[r.content_type][r.pipeline_status] = +r.count;
      return acc;
    }, {});

    const pipelines = [
      { key: 'article',  label: 'Intel pipeline',     color: '#378ADD' },
      { key: 'briefing', label: 'Awareness pipeline',  color: '#1D9E75' },
      { key: 'training', label: 'Training pipeline',   color: '#BA7517' },
    ];

    container.innerHTML = pipelines.map(p => {
      const stages = byType[p.key] || {};
      const total = Object.values(stages).reduce((s, n) => s + n, 0);
      const complete = stages.published || 0;
      const pct = total > 0 ? Math.round(complete / total * 100) : 0;
      return `
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
            <span style="color:#475569;font-weight:500;">${p.label}</span>
            <span style="color:#1e293b;font-weight:500;">${pct}%</span>
          </div>
          <div style="height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${p.color};border-radius:3px;transition:width .4s;"></div>
          </div>
        </div>`;
    }).join('');
  }

  function renderAgentHealth(agents) {
    const container = document.getElementById('agent-health-summary');
    if (!container || !agents?.length) return;

    const active = agents.filter(a => (a.active_queue || 0) >= 0).length;
    const blocked = agents.filter(a => (a.failed_today || 0) > 0).length;
    const avgLatency = agents.reduce((s, a) => s + (a.avg_latency_sec || 0), 0) / (agents.length || 1);

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px;">
        <div style="text-align:center;padding:8px;background:#f8fafc;border-radius:6px;">
          <div style="font-size:18px;font-weight:600;color:#1e293b;">${active}/${agents.length}</div>
          <div style="color:#94a3b8;">Active</div>
        </div>
        <div style="text-align:center;padding:8px;background:#f8fafc;border-radius:6px;">
          <div style="font-size:18px;font-weight:600;color:${blocked > 0 ? '#ef4444' : '#1e293b'};">${blocked}</div>
          <div style="color:#94a3b8;">With errors</div>
        </div>
        <div style="text-align:center;padding:8px;background:#f8fafc;border-radius:6px;">
          <div style="font-size:18px;font-weight:600;color:#1e293b;">${Math.round(avgLatency)}s</div>
          <div style="color:#94a3b8;">Avg latency</div>
        </div>
      </div>`;
  }

  /* ─────────────────────────────────────────────────────────────────
     ACCOUNT PAGE
  ───────────────────────────────────────────────────────────────── */
  function renderAccountPanel(user) {
    const panel = document.getElementById('account-panel');
    if (!panel) return;

    const tierLabel = { free: 'Free', freemium: 'Subscriber (Free)', monthly: 'Monthly Pro', enterprise: 'Enterprise' };
    const tierColor = { free: '#94a3b8', freemium: '#378ADD', monthly: '#1D9E75', enterprise: '#7F77DD' };

    panel.innerHTML = `
      <div class="account-section">
        <h2 style="font-size:22px;font-weight:700;color:var(--cs-navy);margin-bottom:24px;">My Account</h2>
        <div class="account-grid">
          <div class="account-card">
            <div class="account-avatar">${getInitials(user.full_name)}</div>
            <div style="font-size:20px;font-weight:700;color:var(--cs-navy);">${user.full_name}</div>
            <div style="font-size:14px;color:var(--cs-gray-400);">${user.email}</div>
            <div class="account-tier-badge" style="background:${tierColor[user.tier]}20;color:${tierColor[user.tier]};border:1px solid ${tierColor[user.tier]}40;">${tierLabel[user.tier]}</div>
          </div>
          <div class="account-card">
            <h3 class="account-card-title">Subscription</h3>
            ${user.subscription ? `
              <div style="font-size:15px;font-weight:600;color:var(--cs-navy);margin-bottom:8px;">${tierLabel[user.subscription.tier]}</div>
              <div style="font-size:13px;color:var(--cs-gray-600);">Renews ${formatDate(user.subscription.current_period_end)}</div>
              <button class="btn btn-outline btn-sm" style="margin-top:16px;" onclick="CS.Auth.manageBilling()">Manage Billing</button>
            ` : `
              <p style="font-size:14px;color:var(--cs-gray-600);margin-bottom:16px;">You're on the Free tier. Upgrade for full platform access.</p>
              <a href="zerotrust.html" class="btn btn-primary btn-sm">See Plans</a>
            `}
          </div>
          <div class="account-card">
            <h3 class="account-card-title">Preferences</h3>
            <label class="account-toggle">
              <input type="checkbox" id="pref-email-sub" ${user.email_subscribed ? 'checked' : ''}>
              <span>Daily briefing emails</span>
            </label>
            <button class="btn btn-outline btn-sm" style="margin-top:16px;" id="save-preferences">Save</button>
            <div class="auth-success" id="prefs-saved" style="display:none;margin-top:8px;font-size:13px;">Preferences saved.</div>
          </div>
        </div>
        <button class="btn btn-sm" style="border:1.5px solid #ef4444;color:#ef4444;background:transparent;margin-top:32px;" id="delete-account-btn">Delete Account</button>
      </div>`;

    document.getElementById('save-preferences')?.addEventListener('click', async () => {
      try {
        await apiFetch('/api/users/me', {
          method: 'PATCH',
          body: JSON.stringify({ email_subscribed: document.getElementById('pref-email-sub').checked }),
        });
        document.getElementById('prefs-saved').style.display = 'block';
        setTimeout(() => document.getElementById('prefs-saved').style.display = 'none', 3000);
      } catch (e) { showToast('Failed to save preferences.', 'error'); }
    });

    document.getElementById('delete-account-btn')?.addEventListener('click', () => {
      if (confirm('Are you sure you want to permanently delete your account? This cannot be undone.')) {
        apiFetch('/api/users/me', { method: 'DELETE' }).then(() => {
          clearToken(); setUser(null);
          window.location.href = 'index.html';
        }).catch(e => showToast('Failed to delete account: ' + e.message, 'error'));
      }
    });
  }

  async function manageBilling() {
    try {
      const data = await apiFetch('/api/revenue/portal', { method: 'POST' });
      window.location.href = data.portal_url;
    } catch (e) { showToast('Unable to open billing portal. Please try again.', 'error'); }
  }

  async function startSubscription(tier) {
    try {
      const data = await apiFetch('/api/revenue/subscribe', {
        method: 'POST',
        body: JSON.stringify({ tier }),
      });
      window.location.href = data.checkout_url;
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || !isLoggedIn()) {
        showLoginModal({ message: 'Sign in or create an account to subscribe.', tab: 'register', onSuccess: () => startSubscription(tier) });
      } else {
        showToast('Unable to start checkout: ' + e.message, 'error');
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     TOAST NOTIFICATIONS
  ───────────────────────────────────────────────────────────────── */
  function showToast(message, type = 'info') {
    let container = document.getElementById('cs-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'cs-toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `cs-toast cs-toast-${type}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `<span>${message}</span><button class="cs-toast-close" aria-label="Dismiss">&times;</button>`;
    container.appendChild(toast);

    toast.querySelector('.cs-toast-close').addEventListener('click', () => dismissToast(toast));
    setTimeout(() => dismissToast(toast), 5000);
  }

  function dismissToast(toast) {
    toast.classList.add('cs-toast-exit');
    setTimeout(() => toast.remove(), 300);
  }

  /* ─────────────────────────────────────────────────────────────────
     SUBSCRIBE CTA WIRING
     Attaches checkout flow to any element with data-subscribe="tier"
  ───────────────────────────────────────────────────────────────── */
  function wireSubscribeCTAs() {
    document.querySelectorAll('[data-subscribe]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const tier = el.dataset.subscribe;
        if (!isLoggedIn()) {
          showLoginModal({
            tab: 'register',
            message: 'Create a free account to get started.',
            onSuccess: () => startSubscription(tier),
          });
        } else {
          startSubscription(tier);
        }
      });
    });

    // Wire existing gate overlay CTAs
    document.querySelectorAll('.gate-overlay .btn').forEach(btn => {
      if (btn.href?.includes('newsletter.html') || btn.textContent.includes('Subscribe')) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          showLoginModal({ tab: 'register', message: 'Subscribe free to access this content.' });
        });
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     DASHBOARD ADMIN AUTH (dashboard.html)
     Replaces the static JS-only gate with real server auth.
  ───────────────────────────────────────────────────────────────── */
  function initAdminDashboardPage() {
    const loginForm = document.getElementById('login-form');
    if (!loginForm) return;

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = loginForm.querySelector('button[type="submit"]');
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;

      let errorEl = document.getElementById('admin-login-error');
      if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.id = 'admin-login-error';
        errorEl.className = 'auth-error';
        errorEl.style.cssText = 'margin-top:12px;text-align:center;';
        loginForm.appendChild(errorEl);
      }
      clearError(errorEl);
      setLoading(btn, true, 'Authenticating…');

      try {
        const user = await login({ email, password });

        if (!isAdminUser(user)) {
          await logout();
          showError(errorEl, 'Access denied. Administrator credentials required.');
          return;
        }

        // Update nav logout button
        document.getElementById('nav-logout').style.display = 'block';

        // Reveal dashboard
        document.getElementById('login-gate').style.display = 'none';
        document.getElementById('dashboard-shell').style.display = 'grid';
        loadDashboardData();
      } catch (err) {
        showError(errorEl, friendlyError(err));
      } finally {
        setLoading(btn, false, 'Sign In');
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     UTILITY FUNCTIONS
  ───────────────────────────────────────────────────────────────── */
  function scorePassword(pw) {
    if (!pw) return { level: 'empty', pct: 0, label: '' };
    let score = 0;
    if (pw.length >= 12) score++;
    if (pw.length >= 16) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    const levels = [
      { level: 'weak',   pct: 20,  label: 'Weak' },
      { level: 'weak',   pct: 40,  label: 'Weak' },
      { level: 'fair',   pct: 60,  label: 'Fair' },
      { level: 'good',   pct: 80,  label: 'Good' },
      { level: 'strong', pct: 100, label: 'Strong' },
    ];
    return levels[Math.min(score, 4)];
  }

  function friendlyError(err) {
    const messages = {
      INVALID_CREDENTIALS: 'Incorrect email or password.',
      EMAIL_EXISTS:        'An account with this email already exists.',
      EMAIL_NOT_VERIFIED:  'Please verify your email before signing in. Check your inbox.',
      WEAK_PASSWORD:       'Password must be at least 12 characters.',
      RATE_LIMITED:        'Too many attempts. Please wait a moment and try again.',
      USER_NOT_FOUND:      'Account not found.',
    };
    return messages[err.code] || err.message || 'Something went wrong. Please try again.';
  }

  function setLoading(btn, loading, label) {
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = label;
    if (loading) btn.style.opacity = '0.7';
    else btn.style.opacity = '1';
  }

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  }

  function clearError(el) {
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
  }

  function formatNum(n) { return n != null ? Number(n).toLocaleString() : '—'; }
  function formatCents(c) { return c != null ? '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—'; }
  function formatDate(ts) { return ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - new Date(ts)) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  /* ─────────────────────────────────────────────────────────────────
     BOOTSTRAP
  ───────────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', async () => {
    await initSession();
    wireSubscribeCTAs();
    initAdminDashboardPage();
  });

  /* ── Public API ── */
  CS.Auth = {
    showLoginModal,
    closeModal,
    logout,
    login,
    register,
    startSubscription,
    manageBilling,
    isLoggedIn,
    getTier,
    hasMinTier,
    getUser,
    apiFetch,
    showToast,
  };

}(window.CS = window.CS || {}));
