const form = document.getElementById("request-access-form") as HTMLFormElement;
const submitButton = document.getElementById("request-access-submit") as HTMLButtonElement;
const message = document.getElementById("request-access-message") as HTMLDivElement;

function setMessage(text: string, type: "success" | "error" | "") {
  message.textContent = text;
  message.className = type ? `message ${type}` : "message";
  message.style.display = text ? "block" : "none";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("", "");

  const formData = new FormData(form);
  const payload = {
    companyName: String(formData.get("companyName") ?? "").trim(),
    website: String(formData.get("website") ?? "").trim(),
    emailDomain: String(formData.get("emailDomain") ?? "").trim(),
    contactName: String(formData.get("contactName") ?? "").trim(),
    contactEmail: String(formData.get("contactEmail") ?? "").trim(),
  };

  submitButton.disabled = true;
  submitButton.textContent = "Sending…";

  try {
    const response = await fetch("/api/request-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string } | null;
      setMessage(data?.error ?? "We couldn't submit your request. Please try again.", "error");
      return;
    }

    form.reset();
    setMessage("Thanks. We'll reach out soon with next steps.", "success");
  } catch {
    setMessage("We couldn't reach the server. Please try again.", "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Request access";
  }
});
