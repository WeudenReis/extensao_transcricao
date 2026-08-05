import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Cifra segredos (refresh token do Google) com AES-256-GCM.
 *
 * Formato armazenado:
 *   - "gcm:"   + base64(iv[12] | authTag[16] | ciphertext)  — quando há chave
 *   - "plain:" + base64(texto)                              — fallback dev sem chave
 *
 * A chave de 32 bytes é derivada de TOKEN_ENCRYPTION_KEY via SHA-256, então
 * qualquer string longa serve como chave.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plaintext: string, encryptionKey: string | undefined): string {
  if (!encryptionKey) {
    return `plain:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export function decryptSecret(stored: string, encryptionKey: string | undefined): string {
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice('plain:'.length), 'base64').toString('utf8');
  }
  if (stored.startsWith('gcm:')) {
    if (!encryptionKey) {
      throw new Error(
        'Token armazenado cifrado mas TOKEN_ENCRYPTION_KEY não está definida — restaure a chave ou refaça o OAuth.'
      );
    }
    const raw = Buffer.from(stored.slice('gcm:'.length), 'base64');
    if (raw.length < IV_LENGTH + TAG_LENGTH) {
      throw new Error('Token cifrado corrompido (payload curto demais).');
    }
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(encryptionKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  throw new Error('Formato de token armazenado desconhecido.');
}
