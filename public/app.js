const startButton = document.querySelector("#start-demo");
const status = document.querySelector("#session-status");
const slot = document.querySelector("#widget-slot");

startButton?.addEventListener("click", async () => {
  startButton.disabled = true;
  status.textContent = "Connecting you to a short-lived, private Orderly session…";

  try {
    const response = await fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "same-origin"
    });
    const result = await response.json();
    if (!response.ok || typeof result.signedUrl !== "string") {
      throw new Error(result.code || "VOICE_SESSION_FAILED");
    }

    const widget = document.createElement("elevenlabs-convai");
    widget.setAttribute("signed-url", result.signedUrl);
    widget.setAttribute("variant", "expanded");
    widget.setAttribute("avatar-orb-color-1", "#b7ff3c");
    widget.setAttribute("avatar-orb-color-2", "#384251");
    slot.replaceChildren(widget);
    slot.hidden = false;
    status.textContent = "Orderly is ready. Start speaking when you’re comfortable.";
    startButton.hidden = true;
  } catch {
    status.textContent = "Orderly could not start the secure voice session. Please try again in a moment.";
    startButton.disabled = false;
  }
});
