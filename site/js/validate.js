// Input checks shared by the pages and the tests. The database re-checks
// everything; these only give students early, friendly errors.

export function normalizePhone(input) {
  let d = String(input ?? '').replace(/[\s\-().]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export function isValidEmail(input) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(input ?? '').trim());
}

export function isValidVpa(input) {
  return /^[a-zA-Z0-9._-]{2,99}@[a-zA-Z]{2,64}$/.test(String(input ?? '').trim());
}
