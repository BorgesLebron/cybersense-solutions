/* ═══════════════════════════════════════════════
   CyberSense.Solutions — main.js
   Shared: Nav, Blur Gates, Mobile Menu, Utils
   ═══════════════════════════════════════════════ */

(function() {
  'use strict';

  /* ── Active nav link ── */
  function setActiveNav() {
    const path = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a, .nav-drawer ul li a').forEach(function(a) {
      const href = a.getAttribute('href');
      if (href === path || (path === '' && href === 'index.html') ||
          (path === 'index.html' && href === 'index.html')) {
        a.classList.add('active');
      }
    });
  }

  /* ── Mobile hamburger ── */
  function initMobileNav() {
    const hamburger = document.getElementById('hamburger');
    const drawer = document.getElementById('nav-drawer');
    if (!hamburger || !drawer) return;
    hamburger.addEventListener('click', function() {
      const open = hamburger.classList.toggle('open');
      drawer.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', open);
    });
    // Close on outside click
    document.addEventListener('click', function(e) {
      if (!hamburger.contains(e.target) && !drawer.contains(e.target)) {
        hamburger.classList.remove('open');
        drawer.classList.remove('open');
      }
    });
  }

  /* ── Scroll-fade animations ── */
  function initFadeIn() {
    const els = document.querySelectorAll('.fade-in');
    if (!els.length) return;
    const obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    els.forEach(function(el) { obs.observe(el); });
  }

  /* ── Contact form success state ── */
  function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      form.style.display = 'none';
      const success = document.getElementById('contact-success');
      if (success) success.style.display = 'block';
    });
  }

  /* ── Glossary search ── */
  function initGlossarySearch() {
    const input = document.getElementById('glossary-search');
    if (!input) return;
    input.addEventListener('input', function() {
      const q = this.value.toLowerCase().trim();
      document.querySelectorAll('.glossary-item').forEach(function(item) {
        const text = item.textContent.toLowerCase();
        item.style.display = (q === '' || text.includes(q)) ? '' : 'none';
      });
    });
  }

  /* ── Threat radar filters ── */
  function initRadarFilters() {
    const severityFilter = document.getElementById('severity-filter');
    const searchInput = document.getElementById('threat-search');
    const rows = document.querySelectorAll('.threat-row');
    if (!rows.length) return;

    function applyFilters() {
      const sev = severityFilter ? severityFilter.value.toLowerCase() : '';
      const q = searchInput ? searchInput.value.toLowerCase() : '';
      rows.forEach(function(row) {
        if (row.classList.contains('blurred-row')) return;
        const rowSev = (row.dataset.severity || '').toLowerCase();
        const rowText = row.textContent.toLowerCase();
        const sevMatch = !sev || rowSev === sev;
        const qMatch = !q || rowText.includes(q);
        row.style.display = (sevMatch && qMatch) ? '' : 'none';
      });
    }

    if (severityFilter) severityFilter.addEventListener('change', applyFilters);
    if (searchInput) searchInput.addEventListener('input', applyFilters);
  }

  /* ── Newsletter "show more" ── */
  function initNewsletterToggle() {
    const btn = document.getElementById('newsletter-toggle');
    const body = document.getElementById('newsletter-preview-body');
    const fade = document.getElementById('newsletter-fade');
    if (!btn || !body) return;
    btn.addEventListener('click', function() {
      const expanded = body.classList.toggle('expanded');
      if (fade) fade.style.opacity = expanded ? '0' : '1';
      btn.textContent = expanded ? 'Show less ↑' : 'Show more ↓';
    });
  }

  /* ── Previous editions (newsletter page) ── */
  function initEditions() {
    const rows = document.querySelectorAll('.edition-row');
    if (!rows.length) return;
    rows.forEach(function(row) {
      row.addEventListener('click', function() {
        rows.forEach(function(r) { r.classList.remove('active'); });
        row.classList.add('active');
        const editionId = row.dataset.edition;
        document.querySelectorAll('.edition-content').forEach(function(c) {
          c.style.display = 'none';
        });
        const target = document.getElementById('edition-' + editionId);
        if (target) target.style.display = 'block';
      });
    });
  }

  /* ── Dashboard login gate ── */
  function initDashboardGate() {
    const gate = document.getElementById('login-gate');
    const dashboard = document.getElementById('dashboard-shell');
    const loginForm = document.getElementById('login-form');
    if (!gate || !dashboard || !loginForm) return;
    loginForm.addEventListener('submit', function(e) {
      e.preventDefault();
      gate.style.display = 'none';
      dashboard.style.display = 'grid';
    });
  }

  /* ── Training glossary search (same as general) ── */
  function initTrainingSearch() {
    const input = document.getElementById('training-search');
    if (!input) return;
    input.addEventListener('input', function() {
      const q = this.value.toLowerCase();
      document.querySelectorAll('.glossary-item').forEach(function(item) {
        item.style.display = (!q || item.textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
    });
  }

  /* ── Init all ── */
  document.addEventListener('DOMContentLoaded', function() {
    setActiveNav();
    initMobileNav();
    initFadeIn();
    initContactForm();
    initGlossarySearch();
    initRadarFilters();
    initNewsletterToggle();
    initEditions();
    initDashboardGate();
    initTrainingSearch();
  });

})();
