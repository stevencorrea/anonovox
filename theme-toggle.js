// Theme Toggle System
(function() {
  const THEME_KEY = 'anonovox-theme';
  const DARK_MODE = 'dark-mode';
  const LIGHT_MODE = 'light-mode';

  function getPreferredTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK_MODE : LIGHT_MODE;
  }

  function setTheme(theme) {
    const html = document.documentElement;
    html.classList.remove(DARK_MODE, LIGHT_MODE);
    html.classList.add(theme);
    localStorage.setItem(THEME_KEY, theme);
    updateToggleButton(theme);
  }

  function updateToggleButton(theme) {
    const sunBtn = document.getElementById('theme-toggle-sun');
    const moonBtn = document.getElementById('theme-toggle-moon');
    if (sunBtn && moonBtn) {
      if (theme === DARK_MODE) {
        sunBtn.classList.remove('active');
        moonBtn.classList.add('active');
      } else {
        sunBtn.classList.add('active');
        moonBtn.classList.remove('active');
      }
    }
  }

  function initThemeToggle() {
    const theme = getPreferredTheme();
    setTheme(theme);

    const sunBtn = document.getElementById('theme-toggle-sun');
    const moonBtn = document.getElementById('theme-toggle-moon');

    if (sunBtn) {
      sunBtn.addEventListener('click', () => setTheme(LIGHT_MODE));
    }
    if (moonBtn) {
      moonBtn.addEventListener('click', () => setTheme(DARK_MODE));
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(THEME_KEY)) {
        setTheme(e.matches ? DARK_MODE : LIGHT_MODE);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeToggle);
  } else {
    initThemeToggle();
  }
})();
