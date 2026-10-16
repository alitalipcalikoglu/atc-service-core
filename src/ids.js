import { randomBytes } from 'node:crypto';

/**
 * The one id format every service generates for its resources: `<prefix>_<time><random>`, where
 * `prefix` is 2-4 lower-case letters naming the kind (`usr`, `fil`, `msg`), `time` is the creation
 * time in milliseconds in base 36 (sorts by creation within a kind) and `random` is 16 hex
 * characters (64 bits). Natural keys chosen by people (names, slugs, flag keys, e-mail addresses)
 * stay as they are; sequence numbers that order a log are exposed as `seq`, never as `id`.
 */
export class Ids {
  /** Matches any id of this format. */
  static ANY = /^[a-z]{2,4}_[0-9a-z]{6,12}[0-9a-f]{16}$/;

  /** @param {string} prefix @param {number} [now] */
  static create(prefix, now = Date.now()) {
    if (!/^[a-z]{2,4}$/.test(prefix)) throw new Error(`id prefix must be 2-4 lower-case letters, got "${prefix}"`);
    return `${prefix}_${now.toString(36)}${randomBytes(8).toString('hex')}`;
  }

  /** JSON Schema / RegExp source for one kind, e.g. for route params. @param {string} prefix */
  static pattern(prefix) {
    return `^${prefix}_[0-9a-z]{6,12}[0-9a-f]{16}$`;
  }

  /** @param {string} prefix @param {unknown} value */
  static is(prefix, value) {
    return typeof value === 'string' && new RegExp(Ids.pattern(prefix)).test(value);
  }
}
