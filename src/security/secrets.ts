// Redact obvious secrets before logging or persisting diagnostics.
const TOKEN_RE = /(Bearer\s+[A-Za-z0-9\-._~+/=]{8,}|rba_[A-Za-z0-9]+|rbr_[A-Za-z0-9]+|sk-[A-Za-z0-9\-_]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9\-_]{10,})/g;

export function redactText(input: string): string {
  return input.replace(TOKEN_RE, "[REDACTED]");
}

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/passphrase|secret|token|authorization/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}
