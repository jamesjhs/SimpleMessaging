export function getPasswordPolicyError(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';

  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  if (categories < 3) {
    return 'Password must include at least three of: lowercase, uppercase, number, symbol';
  }

  return null;
}
