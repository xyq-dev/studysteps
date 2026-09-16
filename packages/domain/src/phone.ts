const LOCAL_MOBILE = /^(?:\+86)?1[3-9][0-9]{9}$/;

export function normalizeMainlandMobile(raw: string): string | null {
  const compact = raw.replace(/[ -]/g, '');
  if (!LOCAL_MOBILE.test(compact)) {
    return null;
  }
  const local = compact.startsWith('+86') ? compact.slice(3) : compact;
  if (!/^1[3-9][0-9]{9}$/.test(local)) {
    return null;
  }
  return `+86${local}`;
}
