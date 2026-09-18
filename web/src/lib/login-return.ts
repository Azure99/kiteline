export function returnToService() {
  if (location.pathname !== "/login") return;
  const value = new URLSearchParams(location.search).get("returnTo");
  if (!value || !/^\/(proxy|absproxy)\//.test(value)) return;
  const target = new URL(value, location.origin);
  if (target.origin !== location.origin) return;
  if (!/^\/(proxy|absproxy)\/[^/]+\/\d{1,5}(?:\/|$)/.test(target.pathname)) return;
  if (location.hash) target.hash = location.hash;
  location.replace(target.href);
}
