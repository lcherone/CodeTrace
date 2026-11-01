export function isAllowedGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLocaleLowerCase() === "github.com"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname.startsWith("/");
  } catch {
    return false;
  }
}
