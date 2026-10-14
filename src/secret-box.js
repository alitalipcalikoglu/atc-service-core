import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing of small secrets at rest (a webhook signing secret, a TOTP seed, …). A leaked
 * database file then reveals nothing without the key.
 *
 * Two formats, both produced by the same class:
 * - `v1.<iv>.<ciphertext>.<tag>` — single-key, no key id recorded. What every caller got before
 *   Stage 4.1 (webhook-out still does, and still must: it never passes `keyId`).
 * - `v2.<keyId>.<iv>.<ciphertext>.<tag>` — for a caller managing more than one key at once (a
 *   current key plus a previous one, for rotation) and needing to know *which* key a given sealed
 *   value needs, without guessing. `keyId` is `SecretBox.keyId(key)` — a fingerprint, not secret
 *   material itself, safe to store alongside the ciphertext.
 *
 * Which format `seal()` produces depends only on whether the instance was constructed with a
 * `keyId`; `open()` reads whichever format is actually there. This class does **not** manage more
 * than one key — one instance, one key, matching this package's "generic primitive, not a
 * framework" rule (service-core README). A caller that needs a keyring (try the current key, fall
 * back to a previous one, re-seal under a new one) builds that on top, itself — see console's
 * `TotpKeyring` for a worked example, not something this class knows about.
 */
export class SecretBox {
  static VERSION = 'v1';
  static VERSION_KEYED = 'v2';

  /**
   * @param {Buffer} key 32 bytes.
   * @param {object} [o]
   * @param {string} [o.keyId] When given, `seal()` produces the keyed (`v2.`) format and `open()`
   *   refuses (rather than attempting decryption) a `v2.`-format value whose embedded key id names
   *   a different key — fail-closed, since decrypting under the wrong key for a *different* key id
   *   is never correct even if it happened to be tried and failed loudly. Omit for the plain `v1.`
   *   format (single implicit key, no id check possible or needed).
   */
  constructor(key, { keyId } = {}) {
    if (key.length !== 32) throw new Error('SecretBox needs a 32-byte key');
    this.#key = key;
    this.keyId = keyId ?? null;
  }

  /** @type {Buffer} */
  #key;

  /** @param {string} text */
  seal(text) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag().toString('base64url');
    const parts = this.keyId
      ? [SecretBox.VERSION_KEYED, this.keyId, iv.toString('base64url'), ct.toString('base64url'), tag]
      : [SecretBox.VERSION, iv.toString('base64url'), ct.toString('base64url'), tag];
    return parts.join('.');
  }

  /** @param {string} sealed */
  open(sealed) {
    const parts = sealed.split('.');
    if (parts[0] === SecretBox.VERSION_KEYED) {
      const [, keyId, iv, ct, tag] = parts;
      if (!keyId || !iv || !ct || !tag) throw new Error('sealed secret has an unknown format');
      if (this.keyId && keyId !== this.keyId) throw new Error(`sealed secret was sealed under key "${keyId}", this box is key "${this.keyId}"`);
      return SecretBox.#decrypt(this.#key, iv, ct, tag);
    }
    if (parts[0] === SecretBox.VERSION) {
      const [, iv, ct, tag] = parts;
      if (!iv || !ct || !tag) throw new Error('sealed secret has an unknown format');
      return SecretBox.#decrypt(this.#key, iv, ct, tag);
    }
    throw new Error('sealed secret has an unknown format');
  }

  /** @param {Buffer} key @param {string} ivB64 @param {string} ctB64 @param {string} tagB64 */
  static #decrypt(key, ivB64, ctB64, tagB64) {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  /**
   * True when `text` is already in this class's sealed format (`v1.` or `v2.`), so callers can tell
   * a sealed value apart from legacy plaintext without trying to open it.
   * @param {string} text
   */
  static isSealed(text) {
    return /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)
      || /^v2\.[0-9a-f]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text);
  }

  /**
   * The key id embedded in a `v2.`-format sealed value, or `null` for `v1.` (no id recorded) or a
   * value that isn't sealed at all. Lets a caller managing several keys pick the right one before
   * ever attempting to decrypt — see `open()`'s own id check, which this makes possible to do
   * *before* calling `open()` too, when the caller wants to choose the instance itself.
   * @param {string} sealed
   */
  static peekKeyId(sealed) {
    const parts = sealed.split('.');
    return parts[0] === SecretBox.VERSION_KEYED ? (parts[1] || null) : null;
  }

  /**
   * A short, deterministic, non-secret fingerprint of a key, for tagging sealed values with which
   * key produced them (`v2.` format) without storing or deriving anything sensitive — same idea as
   * `AnchorSigner.keyId` in `atc-audit`, applied to a symmetric key's raw bytes instead of a public key.
   * @param {Buffer} key
   */
  static keyId(key) {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }
}
