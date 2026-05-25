/* ═══════════════════════════════════════════════════════════════════
   CyberSense.Solutions — main.js v2.0
   Shared page logic. Auth is handled by auth.js (loaded first).
   This file handles: nav, animations, page-specific UI, filters.
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const NAV_GROUPS = {
    intel: [
      {
        title: 'Threat Intelligence',
        href: 'intelligence.html#threat-intelligence',
        body: 'Decrypting the active threat landscape. Access analyses of emerging vulnerability vectors, weaponized exploits, and tactical mitigation strategies designed to safeguard enterprise infrastructure and workforce assets.',
      },
      {
        title: 'Professional Growth',
        href: 'intelligence.html#professional-growth',
        body: 'Empowering a digitally disciplined workforce. Discover data-backed insights on evolving technical certifications, cyber career trajectories, and interdisciplinary team structures designed to bridge the skills gap between practitioners and leadership.',
      },
      {
        title: 'Innovation',
        href: 'intelligence.html#innovation',
        body: 'Anticipating the technological frontier. Explore balanced, forward-looking deconstructions of emerging breakthroughs, from autonomous agentic AI architectures to post-quantum cryptographic transitions, and their structural impacts on future enterprise strategy.',
      },
      {
        title: 'Training Resources',
        href: 'intelligence.html#training-resources',
        body: 'Actionable pathways for continuous learning. Access a highly curated library of high-ROI webinars, instructional videos, and verified open-access courses to build systemic organizational resilience and technical mastery.',
      },
    ],
    resources: [
      {
        title: 'Threat Intelligence',
        href: 'intelligence.html#threat-intelligence',
        body: 'Reference active and enduring threat analysis beyond the daily feed, organized for teams that need durable operational context.',
      },
      {
        title: 'Professional Growth',
        href: 'growth.html',
        body: 'Career pathways, seminars, webinars, courses, and workforce guidance for building a resilient professional bench.',
      },
      {
        title: 'Innovation',
        href: 'innovation.html',
        body: 'Emerging technology coverage with longer shelf life, from AI operations to post-quantum readiness and enterprise modernization.',
      },
      {
        title: 'Training Resources',
        href: 'training.html',
        body: 'Practical training modules, labs, videos, and learning references grounded in current CyberSense intelligence.',
      },
      {
        title: 'Glossary',
        href: 'glossary.html',
        body: 'A durable terminology library for acronyms, concepts, frameworks, and operational language used across CyberSense coverage.',
        pending: true,
      },
    ],
  };

  function navCard(item) {
    return `<a class="nav-mega-card${item.pending ? ' pending' : ''}" href="${item.href}">
      <h3>${item.title}</h3>
      <p>${item.body}</p>
    </a>`;
  }

  function navDropdown(label, key) {
    return `<li class="nav-menu-item" data-nav-group="${key}">
      <button class="nav-menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">
        ${label}<span class="nav-caret" aria-hidden="true"></span>
      </button>
      <div class="nav-mega" role="menu" aria-label="${label} menu">
        <div class="nav-mega-title">${label} &rarr;</div>
        <div class="nav-mega-grid">
          ${NAV_GROUPS[key].map(navCard).join('')}
        </div>
      </div>
    </li>`;
  }

  function renderPublicNav() {
    const navLinks = document.querySelector('.nav-links');
    const drawerList = document.querySelector('.nav-drawer ul');

    if (navLinks) {
      navLinks.innerHTML = [
        '<li><a href="index.html">Home</a></li>',
        '<li><a href="about.html">About</a></li>',
        '<li><a href="radar.html">Radar</a></li>',
        navDropdown('Intel', 'intel'),
        '<li><a href="newsletter.html">Newsletter</a></li>',
        navDropdown('Resources', 'resources'),
      ].join('');
    }

    if (drawerList) {
      drawerList.innerHTML = [
        '<li><a href="index.html">Home</a></li>',
        '<li><a href="about.html">About</a></li>',
        '<li><a href="radar.html">Radar</a></li>',
        '<li class="drawer-group">Intel</li>',
        ...NAV_GROUPS.intel.map(item => `<li class="drawer-sub"><a href="${item.href}">${item.title}</a></li>`),
        '<li><a href="newsletter.html">Newsletter</a></li>',
        '<li class="drawer-group">Resources</li>',
        ...NAV_GROUPS.resources.map(item => `<li class="drawer-sub"><a href="${item.href}">${item.title}</a></li>`),
      ].join('');
    }
  }

  /* ── Active nav link ────────────────────────────────────────────── */
  function setActiveNav() {
    const path = window.location.pathname.split('/').pop() || 'index.html';
    const currentHash = window.location.hash || '';
    document.querySelectorAll('.nav-links a, .nav-drawer ul li a').forEach(function (a) {
      const rawHref = a.getAttribute('href') || '';
      const parts = rawHref.split('#');
      const href = parts[0];
      const hash = parts[1] ? `#${parts[1]}` : '';
      if ((hash ? href === path && hash === currentHash : href === path) || (path === '' && href === 'index.html') ||
        (path === 'index.html' && href === 'index.html')) {
        a.classList.add('active');
      }
    });

    const activeGroups = {
      intel: ['intelligence.html'],
      resources: ['growth.html', 'innovation.html', 'training.html', 'glossary.html'],
    };
    Object.keys(activeGroups).forEach(function (group) {
      if (activeGroups[group].includes(path)) {
        document.querySelector(`[data-nav-group="${group}"] .nav-menu-trigger`)?.classList.add('active');
      }
    });
  }

  /* ── Mobile hamburger ───────────────────────────────────────────── */
  function initMobileNav() {
    const hamburger = document.getElementById('hamburger');
    const drawer = document.getElementById('nav-drawer');
    if (!hamburger || !drawer) return;
    drawer.style.display = 'block'; // override display:none so transition works

    hamburger.addEventListener('click', function () {
      const open = hamburger.classList.toggle('open');
      drawer.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });

    document.addEventListener('click', function (e) {
      if (!hamburger.contains(e.target) && !drawer.contains(e.target)) {
        hamburger.classList.remove('open');
        drawer.classList.remove('open');
        document.body.style.overflow = '';
      }
    });

    // Close drawer on link click
    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        hamburger.classList.remove('open');
        drawer.classList.remove('open');
        document.body.style.overflow = '';
      });
    });
  }

  /* ── Scroll-fade animations ─────────────────────────────────────── */
  function initFadeIn() {
    const els = document.querySelectorAll('.fade-in');
    if (!els.length) return;
    if (!window.IntersectionObserver) {
      els.forEach(function (el) { el.classList.add('visible'); });
      return;
    }
    const obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    els.forEach(function (el) { obs.observe(el); });
  }

  /* ── Contact form ───────────────────────────────────────────────── */
  function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

      // In production: POST to /api/contact or a form service
      setTimeout(function () {
        form.style.display = 'none';
        const success = document.getElementById('contact-success');
        if (success) success.style.display = 'block';
      }, 600);
    });
  }

  /* ── Glossary search ────────────────────────────────────────────── */
  function initGlossarySearch() {
    const input = document.getElementById('glossary-search');
    if (!input) return;
    input.addEventListener('input', function () {
      const q = this.value.toLowerCase().trim();
      document.querySelectorAll('.glossary-item').forEach(function (item) {
        item.style.display = (!q || item.textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
    });
  }

  /* ── Threat radar filters ───────────────────────────────────────── */
  function initRadarFilters() {
    const severityFilter = document.getElementById('severity-filter');
    const searchInput = document.getElementById('threat-search');
    const rows = document.querySelectorAll('.threat-row');
    if (!rows.length) return;

    function applyFilters() {
      const sev = severityFilter ? severityFilter.value.toLowerCase() : '';
      const q = searchInput ? searchInput.value.toLowerCase() : '';
      rows.forEach(function (row) {
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

  /* ── Newsletter "show more" ─────────────────────────────────────── */
  function initNewsletterToggle() {
    const btn = document.getElementById('newsletter-toggle');
    const body = document.getElementById('newsletter-preview-body');
    const fade = document.getElementById('newsletter-fade');
    if (!btn || !body) return;
    btn.addEventListener('click', function () {
      const expanded = body.classList.toggle('expanded');
      if (fade) fade.style.opacity = expanded ? '0' : '1';
      btn.textContent = expanded ? 'Show less ↑' : 'Show more ↓';
    });
  }

  /* ── Previous newsletter editions ───────────────────────────────── */
  function initEditions() {
    const rows = document.querySelectorAll('.edition-row');
    if (!rows.length) return;
    rows.forEach(function (row) {
      row.addEventListener('click', function () {
        rows.forEach(function (r) { r.classList.remove('active'); });
        row.classList.add('active');
        const editionId = row.dataset.edition;
        document.querySelectorAll('.edition-content').forEach(function (c) {
          c.style.display = 'none';
        });
        const target = document.getElementById('edition-' + editionId);
        if (target) target.style.display = 'block';
      });
    });
  }

  /* ── Dashboard login gate ───────────────────────────────────────── */
  // Auth.js handles the real login flow.
  // This is a fallback for when auth.js is not loaded (dev/preview only).
  function initDashboardGateFallback() {
    const gate = document.getElementById('login-gate');
    const dashboard = document.getElementById('dashboard-shell');
    const loginForm = document.getElementById('login-form');
    if (!gate || !dashboard || !loginForm) return;

    // If auth.js is loaded, it handles this — skip fallback
    if (window.CS && window.CS.Auth) return;

    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      gate.style.display = 'none';
      dashboard.style.display = 'grid';
    });
  }

  /* ── Training glossary search ───────────────────────────────────── */
  function initTrainingSearch() {
    const input = document.getElementById('training-search');
    if (!input) return;
    input.addEventListener('input', function () {
      const q = this.value.toLowerCase();
      document.querySelectorAll('.glossary-item').forEach(function (item) {
        item.style.display = (!q || item.textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
    });
  }

  /* ── Subscription CTA wiring (fallback if auth.js not loaded) ───── */
  function initSubscribeCTAFallback() {
    if (window.CS && window.CS.Auth) return; // auth.js handles this
    document.querySelectorAll('.gate-overlay .btn, [data-subscribe]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        // Redirect to newsletter page as fallback
        window.location.href = 'newsletter.html';
      });
    });
  }

  /* ── Smooth scroll for anchor links ─────────────────────────────── */
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        const target = document.querySelector(a.getAttribute('href'));
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  /* ── Sticky nav shadow on scroll ────────────────────────────────── */
  function initNavShadow() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    let ticking = false;
    window.addEventListener('scroll', function () {
      if (!ticking) {
        requestAnimationFrame(function () {
          nav.style.boxShadow = window.scrollY > 10
            ? '0 2px 20px rgba(0,0,0,0.25)'
            : '';
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }

  /* ── Innovation page category filter ────────────────────────────── */
  function initInnovationFilter() {
    const filterBtns = document.querySelectorAll('[data-category-filter]');
    if (!filterBtns.length) return;

    filterBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        filterBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        const cat = btn.dataset.categoryFilter;

        document.querySelectorAll('.category-section[data-category]').forEach(function (section) {
          if (cat === 'all' || section.dataset.category === cat) {
            section.style.display = '';
          } else {
            section.style.display = 'none';
          }
        });
      });
    });
  }

  /* ── Zero-Trust phase accordion ─────────────────────────────────── */
  function initZeroTrustAccordion() {
    document.querySelectorAll('.zt-phase-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const panel = document.getElementById(btn.dataset.target);
        if (!panel) return;
        const open = panel.classList.toggle('open');
        btn.setAttribute('aria-expanded', open);
        btn.querySelector('.zt-chevron')?.classList.toggle('rotated', open);
      });
    });
  }

  /* ── Enterprise dashboard sidebar nav ───────────────────────────── */
  function initEnterpriseDashboardNav() {
    const navItems = document.querySelectorAll('.enterprise-nav-item');
    if (!navItems.length) return;

    navItems.forEach(function (item) {
      item.addEventListener('click', function () {
        navItems.forEach(function (n) { n.classList.remove('active'); });
        item.classList.add('active');

        const panelId = item.dataset.panel;
        document.querySelectorAll('.enterprise-panel').forEach(function (p) {
          p.style.display = 'none';
        });
        const panel = document.getElementById('ep-' + panelId);
        if (panel) panel.style.display = 'block';
      });
    });
  }

  /* ── Copy to clipboard utility ──────────────────────────────────── */
  function initCopyButtons() {
    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const text = btn.dataset.copy;
        navigator.clipboard?.writeText(text).then(function () {
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = orig; }, 1500);
        });
      });
    });
  }

  /* ── Init all ───────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    renderPublicNav();
    setActiveNav();
    initMobileNav();
    initFadeIn();
    initContactForm();
    initGlossarySearch();
    initRadarFilters();
    initNewsletterToggle();
    initEditions();
    initDashboardGateFallback();
    initTrainingSearch();
    initSubscribeCTAFallback();
    initSmoothScroll();
    initNavShadow();
    initInnovationFilter();
    initZeroTrustAccordion();
    initEnterpriseDashboardNav();
    initCopyButtons();
  });

})();
