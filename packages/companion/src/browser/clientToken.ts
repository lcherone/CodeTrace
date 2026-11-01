/** Accept common clipboard wrappers without altering the credential itself. */
export function pastedClientToken(value: string): string {
  let token = value.replace(/^[\s\u200b\u200e\u200f\u2060]+|[\s\u200b\u200e\u200f\u2060]+$/gu, "");
  token = token.replace(/^Bearer\s+/i, "");
  const wrappers: Record<string, string> = { '"': '"', "'": "'", "`": "`", "“": "”", "‘": "’" };
  if (token.length > 1 && wrappers[token[0]!] === token.at(-1)) token = token.slice(1, -1).trim();
  if (!token) throw new Error("Paste the local Trace client token, or open Trace from the VS Code status item.");
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error("This does not look like a Trace client token. Copy the complete token again; do not include the instructions or an abbreviated token containing ….");
  return token;
}
