(function () {
  const interceptedPaths = new Set([
    "/request-access",
    "/signin",
  ]);

  function getInterceptedLink(target) {
    if (!(target instanceof Element)) return null;
    const link = target.closest("a[href]");
    if (!link) return null;
    const href = link.getAttribute("href");
    return href && interceptedPaths.has(href) ? link : null;
  }

  function isModified(event) {
    return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }

  function navigate(link) {
    const href = link.getAttribute("href");
    if (!href || window.location.pathname === href) return;
    window.location.assign(href);
  }

  document.addEventListener("pointerup", (event) => {
    if (event.pointerType === "mouse" || isModified(event)) return;
    const link = getInterceptedLink(event.target);
    if (!link) return;
    event.preventDefault();
    navigate(link);
  }, true);

  document.addEventListener("click", (event) => {
    if (event.button !== 0 || isModified(event)) return;
    const link = getInterceptedLink(event.target);
    if (!link) return;
    event.preventDefault();
    navigate(link);
  }, true);
})();
