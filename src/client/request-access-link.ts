const INTERCEPTED_PATHS = new Set([
  "/request-access",
  "/signin",
]);

function isPlainPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
  const href = link.getAttribute("href");
  if (!href || !INTERCEPTED_PATHS.has(href)) continue;

  link.addEventListener("click", (event) => {
    if (!isPlainPrimaryClick(event)) return;

    event.preventDefault();

    if (window.location.pathname !== href) {
      window.location.assign(href);
    }
  });
}
