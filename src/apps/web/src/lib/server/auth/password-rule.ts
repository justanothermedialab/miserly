/**
 * password-rule.ts: the one rule for a password being set or changed (setup, add member, reset,
 * change password; H1 RD). Length over composition,
 * as NIST SP 800-63B advises: at least 10 characters, not the username, and not one of the most
 * common passwords. No "a capital and a digit" rules. The list is a file inside the app
 * (`common-passwords.txt`, its source and licence in `common-passwords.NOTICE.txt`); nothing is
 * looked up anywhere. Existing passwords are not checked: the rule applies when one is set.
 */
import list from './common-passwords.txt?raw';
import { MIN_PASSWORD_LENGTH } from '../config';
import { TEXT_LIMITS } from '../../text-limits';

const COMMON = new Set(list.split('\n').map((l) => l.trim()).filter((l) => l !== ''));

/** Who the password is for, which only changes the wording ("your" or "their" username). */
export type PasswordFor = 'self' | 'member';

/** The problem with `password` for `username`, in the person's words, or null when it is fine. */
export function passwordProblem(password: string, username: string, whose: PasswordFor = 'self'): string | null {
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  // A longer one could be set and then never used (sign-in refuses a body over 64 KB).
  if (length > TEXT_LIMITS.password) return `Use ${TEXT_LIMITS.password.toLocaleString('en-IN')} characters or fewer.`;
  const p = password.trim().toLowerCase();
  const u = username.trim().toLowerCase();
  // The username itself, or the username repeated ("alicealice"), is no password.
  if (u !== '' && (p === u || p.replaceAll(u, '') === '')) {
    return whose === 'self' ? "The password can't be your username." : "The password can't be their username.";
  }
  if (COMMON.has(p)) return 'That password is one of the most common. Choose another.';
  return null;
}
