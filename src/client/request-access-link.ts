const REQUEST_ACCESS_PATH = "/request-access";

function isPlainPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

for (const link of document.querySelectorAll<HTMLAnchorElement>(`a[href="${REQUEST_ACCESS_PATH}"]`)) {
  link.addEventListener("click", (event) => {
    if (!isPlainPrimaryClick(event)) return;

    event.preventDefault();

    if (window.location.pathname !== REQUEST_ACCESS_PATH) {
      window.location.assign(REQUEST_ACCESS_PATH);
    }
  });
}
