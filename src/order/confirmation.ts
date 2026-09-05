export function normalizeSpokenInput(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function isClearSpokenYes(text: string): boolean {
  const normalized = normalizeSpokenInput(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:“”\"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\b(?:no|not|don't|do not|wait|hold|change|modify|but|instead|cancel|stop|maybe|guess|unsure)\b/i.test(normalized)) {
    return false;
  }
  return new Set([
    "yes",
    "yes please",
    "yes go ahead",
    "yes please go ahead",
    "yes place it",
    "yes place the order",
    "yes confirm it",
    "yes confirm the order",
    "yes that's correct",
    "yes that is correct",
    "yeah",
    "yeah please",
    "yeah go ahead",
    "yep",
    "yep please",
    "yup",
    "sure",
    "sure please",
    "sure go ahead",
    "ok",
    "okay",
    "ok go ahead",
    "okay go ahead",
    "ok place the order",
    "okay place the order",
    "go ahead",
    "please go ahead",
    "place it",
    "place the order",
    "please place it",
    "please place the order",
    "confirm",
    "confirm it",
    "confirm the order",
    "correct",
    "that's correct",
    "that is correct",
    "sounds good",
    "do it",
    "please do",
    "please do it"
  ]).has(normalized);
}
