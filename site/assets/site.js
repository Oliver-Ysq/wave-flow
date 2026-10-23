(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const trapFocus = (event, container) => {
    const focusable = $$(
      'a[href], button:not([disabled]), input, summary, [tabindex]:not([tabindex="-1"])',
      container,
    ).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const setupDrawer = () => {
    const drawer = $('[data-drawer]');
    const trigger = $('[data-open-drawer]');
    if (!drawer || !trigger) return;

    const scrim = $('[data-drawer-scrim]');
    let lastFocus = null;

    const setOpen = (open) => {
      drawer.classList.toggle('is-open', open);
      drawer.setAttribute('aria-hidden', String(!open));
      trigger.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('drawer-open', open);
      document.body.classList.toggle('drawer-visible', open);
      if (scrim) scrim.hidden = !open;
      if (open) {
        lastFocus = document.activeElement;
        $('[data-drawer-close]', drawer)?.focus();
      } else if (lastFocus) {
        lastFocus.focus();
      }
    };

    trigger.addEventListener('click', () => setOpen(true));
    $$('[data-drawer-close]').forEach((element) => {
      element.addEventListener('click', () => setOpen(false));
    });
    scrim?.addEventListener('click', () => setOpen(false));
    $$('a', drawer).forEach((link) => {
      link.addEventListener('click', () => setOpen(false));
    });

    document.addEventListener('keydown', (event) => {
      if (!drawer.classList.contains('is-open')) return;
      if (event.key === 'Escape') setOpen(false);
      if (event.key === 'Tab') trapFocus(event, drawer);
    });
  };

  const setupDocsSidebar = () => {
    const sidebar = $('[data-docs-sidebar]');
    const trigger = $('[data-docs-toggle]');
    if (!sidebar || !trigger) return;

    const scrim = $('[data-docs-scrim]');
    const closeButtons = $$('[data-docs-close]');
    const mobile = window.matchMedia('(max-width: 1100px)');
    let lastFocus = null;

    const setMobileOpen = (open) => {
      sidebar.classList.toggle('is-open', open);
      document.body.classList.toggle('drawer-open', open);
      document.body.classList.toggle('drawer-visible', open);
      trigger.setAttribute('aria-expanded', String(open));
      if (scrim) scrim.hidden = !open;
      if (open) {
        lastFocus = document.activeElement;
        $('[data-docs-close]', sidebar)?.focus();
      } else if (lastFocus) {
        lastFocus.focus();
      }
    };

    const syncDesktopState = () => {
      trigger.setAttribute(
        'aria-expanded',
        mobile.matches ? String(sidebar.classList.contains('is-open')) : String(!document.body.classList.contains('docs-collapsed')),
      );
    };

    trigger.addEventListener('click', () => {
      if (mobile.matches) {
        setMobileOpen(!sidebar.classList.contains('is-open'));
      } else {
        document.body.classList.toggle('docs-collapsed');
        syncDesktopState();
      }
    });

    closeButtons.forEach((element) => {
      element.addEventListener('click', () => setMobileOpen(false));
    });
    scrim?.addEventListener('click', () => setMobileOpen(false));

    sidebar.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener('click', () => {
        if (mobile.matches) setMobileOpen(false);
      });
    });

    document.addEventListener('keydown', (event) => {
      if (!mobile.matches || !sidebar.classList.contains('is-open')) return;
      if (event.key === 'Escape') setMobileOpen(false);
      if (event.key === 'Tab') trapFocus(event, sidebar);
    });

    mobile.addEventListener('change', () => {
      if (!mobile.matches) {
        sidebar.classList.remove('is-open');
        document.body.classList.remove('drawer-open', 'drawer-visible');
        if (scrim) scrim.hidden = true;
        syncDesktopState();
      } else {
        document.body.classList.remove('docs-collapsed');
      }
    });

    syncDesktopState();
  };

  const setupScrollSpy = () => {
    const headings = $$('.prose section[id]');
    const links = $$('.docs-nav a[href^="#"], .docs-toc a[href^="#"]');
    if (!headings.length || !links.length) return;

    let ticking = false;
    const update = () => {
      ticking = false;
      let current = headings[0].id;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= 150) current = heading.id;
      }
      links.forEach((link) => {
        link.classList.toggle('is-active', link.getAttribute('href') === `#${current}`);
      });
    };

    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  };

  const setupCopyButtons = () => {
    $$('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        const code = button.closest('.code')?.querySelector('code');
        if (!code) return;
        const ok = await copyText(code.innerText);
        const original = button.textContent;
        button.textContent = ok ? '已复制' : '复制失败';
        window.setTimeout(() => {
          button.textContent = original;
        }, 1600);
      });
    });
  };

  const setupAnchorCentering = () => {
    if (document.body.classList.contains('docs-page')) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const show = (target, behavior) => {
      window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY, behavior });
    };

    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link) return;
      const url = new URL(link.href, window.location.href);
      if (url.pathname !== window.location.pathname || url.search !== window.location.search) return;
      if (!url.hash || url.hash.length < 2) return;
      const target = document.querySelector(url.hash);
      if (!target) return;
      event.preventDefault();
      window.history.pushState(null, '', url.hash);
      show(target, reduced ? 'auto' : 'smooth');
    });

    if (window.location.hash) {
      const target = document.querySelector(window.location.hash);
      if (target) {
        window.requestAnimationFrame(() => show(target, 'auto'));
      }
    }
  };

  const setupCmdCopy = () => {
    $$('[data-cmd]').forEach((button) => {
      button.addEventListener('click', async () => {
        const text = button.querySelector('[data-cmd-text]')?.textContent;
        if (!text) return;
        const ok = await copyText(text.trim());
        if (!ok) return;
        button.classList.add('is-copied');
        window.setTimeout(() => button.classList.remove('is-copied'), 1600);
      });
    });
  };

  setupDrawer();
  setupDocsSidebar();
  setupScrollSpy();
  setupCopyButtons();
  setupAnchorCentering();
  setupCmdCopy();
})();
