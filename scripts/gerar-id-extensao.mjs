/**
 * Gera um par de chaves e fixa o ID da extensão no manifest.json.
 *
 * Por que: a instalação por política do Chrome exige um ID ESTÁVEL. Colocando a
 * chave pública no campo "key" do manifest, o ID passa a ser sempre o mesmo em
 * qualquer máquina e em qualquer empacotamento.
 *
 * Rodar UMA vez:  node scripts/gerar-id-extensao.mjs
 * Guarde chave-privada.pem em local seguro (serve pra assinar o .crx depois).
 */
import {
  generateKeyPairSync,
  createHash,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'extension', 'manifest.json');
const keyPath = join(root, 'chave-privada.pem');

let privateKey;
let publicKey;

if (existsSync(keyPath)) {
  console.log('Já existe chave-privada.pem — reaproveitando (o ID não muda).');
  privateKey = createPrivateKey(readFileSync(keyPath));
  publicKey = createPublicKey(privateKey);
} else {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  console.log('Chave privada criada em chave-privada.pem (NÃO commitar).');
}

// DER da chave pública (SubjectPublicKeyInfo) — é o que o Chrome usa.
const spki = publicKey.export({ type: 'spki', format: 'der' });
const keyBase64 = spki.toString('base64');

// ID = SHA-256 do DER, 16 primeiros bytes, dígitos hex mapeados para a–p.
const hash = createHash('sha256').update(spki).digest('hex').slice(0, 32);
const extensionId = hash.replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.key = keyBase64;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('\n=========================================');
console.log('ID DA EXTENSÃO (use nos scripts de instalação):');
console.log(extensionId);
console.log('=========================================\n');
console.log('manifest.json atualizado com o campo "key" — o ID agora é fixo.');
