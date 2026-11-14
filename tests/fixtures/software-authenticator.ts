import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

// Minimal ES256 software authenticator. The production WebAuthn verifier checks
// the CBOR attestation, RP hash, client data, UV flags, counter and real signature.
export function softwareAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }), id = randomBytes(32)
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest()
  const client = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  const authenticator = (rpID: string, flags: number, counter: number) => {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter)
    return Buffer.concat([hash(rpID), Buffer.from([flags]), count])
  }
  return {
    register(challenge: string, origin = 'http://localhost', rpID = 'localhost', flags = 0x45) {
      const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]))
      const size = Buffer.alloc(2); size.writeUInt16BE(id.length)
      const authData = Buffer.concat([authenticator(rpID, flags, 0), Buffer.alloc(16), size, id, cose])
      const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, never>>([['fmt', 'none'], ['authData', authData], ['attStmt', new Map()]]))
      return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: client('webauthn.create', challenge, origin).toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal'] } }
    },
    authenticate(challenge: string, counter = 1, origin = 'http://localhost', rpID = 'localhost', flags = 0x05) {
      const clientData = client('webauthn.get', challenge, origin), authData = authenticator(rpID, flags, counter)
      return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sign('sha256', Buffer.concat([authData, hash(clientData)]), privateKey).toString('base64url') } }
    },
  }
}
