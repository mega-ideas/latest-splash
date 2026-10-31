export function plainText(value: unknown, _max = 64, fallback = ''): string {
  const text = String(value ?? '');
  return text === '' ? fallback : text;
}
