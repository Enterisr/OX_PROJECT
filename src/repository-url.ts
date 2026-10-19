export function normalizeRepositoryUrl(value: string): string | undefined {
  if (!/^https:\/\/github\.com\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    const path = url.pathname.match(/^\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)\/?$/);
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !path) return undefined;
    const repo = path[2].replace(/\.git$/, '');
    if (!repo || repo === '.' || repo === '..') return undefined;
    return `https://github.com/${path[1]}/${repo}`;
  } catch {
    return undefined;
  }
}
