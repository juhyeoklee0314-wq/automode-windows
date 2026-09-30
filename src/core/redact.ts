const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(\bAuthorization\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, "$1[REDACTED]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]"],
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_API_KEY]"],
  [/\b(access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie|authorization)(\s*[=:]\s*)([^\s,;]+)/gi, "$1$2[REDACTED]"],
  [/([?&](?:token|key|secret)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)[A-Za-z0-9_]*\b\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[REDACTED]"],
  [/(\b(?:password|passwd|client_secret|api[_-]?key)\b\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/("(?:password|access_token|refresh_token|authorization|cookie|apiKey|clientSecret)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2"],
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}
