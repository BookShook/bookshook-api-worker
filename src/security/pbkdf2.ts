// PBKDF2 password verification using WebCrypto.
// We store salt+hash in env so no password is stored in DB.

const te = new TextEncoder();

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyPbkdf2Password(password: string, saltB64: string, hashB64: string, iterations = 200_000) {
  const salt = b64ToBytes(saltB64);
  const expected = b64ToBytes(hashB64);

  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    expected.length * 8
  );
  const derived = new Uint8Array(bits);

  // constant-time compare
  let ok = 1;
  for (let i = 0; i < expected.length; i++) ok &= (expected[i] === derived[i]) ? 1 : 0;
  return !!ok;
}
