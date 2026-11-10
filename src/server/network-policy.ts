import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export class HttpUrlPolicyError extends Error {}

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(network, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string, family: number): boolean {
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export async function resolveHttpUrl(url: URL, trustedOrigins: readonly string[] = []) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpUrlPolicyError('Use an HTTP or HTTPS URL without embedded login details.')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const trusted = trustedOrigins.includes(url.origin)
  if (!trusted && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) throw new HttpUrlPolicyError('Paper cannot fetch private network addresses')
  const family = isIP(hostname)
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || (!trusted && addresses.some(item => !isPublicAddress(item.address, item.family)))) throw new HttpUrlPolicyError('Paper cannot fetch private network addresses')
  return addresses
}
