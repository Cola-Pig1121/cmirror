import { describe, expect, it } from 'vitest'
import { validateTargetUrl, parseLegacyIpv4, parseIpv6Groups, isBlockedIpv4, isBlockedIpv6 } from '../src/lib/ssrf'

describe('parseLegacyIpv4', () => {
  it('parses dotted decimal', () => {
    expect(parseLegacyIpv4('1.2.3.4')).toBe(0x01020304)
  })
  it('parses integer form', () => {
    expect(parseLegacyIpv4('2130706433')).toBe(0x7f000001)
    expect(parseLegacyIpv4('0x7f000001')).toBe(0x7f000001)
  })
  it('parses octal parts', () => {
    expect(parseLegacyIpv4('0177.0.0.1')).toBe(0x7f000001)
  })
  it('parses partial forms', () => {
    expect(parseLegacyIpv4('127.1')).toBe(0x7f000001)
  })
  it('rejects non-IPv4', () => {
    expect(parseLegacyIpv4('example.com')).toBeNull()
    expect(parseLegacyIpv4('1.2.3.999')).toBeNull()
    expect(parseLegacyIpv4('1.2.3.4.5')).toBeNull()
    expect(parseLegacyIpv4('')).toBeNull()
  })
})

describe('parseIpv6Groups', () => {
  it('parses full and compressed forms', () => {
    expect(parseIpv6Groups('[::1]')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6Groups('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6Groups('[::ffff:127.0.0.1]')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001])
    expect(parseIpv6Groups('2001:db8::8a2e:370:7334')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0x8a2e, 0x0370, 0x7334])
  })
  it('rejects invalid', () => {
    expect(parseIpv6Groups('')).toBeNull()
    expect(parseIpv6Groups('[::1::2]')).toBeNull()
    expect(parseIpv6Groups('[12345::]')).toBeNull()
  })
})

describe('isBlockedIpv4', () => {
  const blocked = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']
  const allowed = ['8.8.8.8', '1.1.1.1', '142.250.0.1', '172.32.0.1', '100.128.0.1', '192.169.0.1']
  for (const ip of blocked) it('blocks ' + ip, () => expect(isBlockedIpv4(ipv4(ip))).toBe(true))
  for (const ip of allowed) it('allows ' + ip, () => expect(isBlockedIpv4(ipv4(ip))).toBe(false))
})

function ipv4(s: string): number {
  const [a, b, c, d] = s.split('.').map(Number)
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

describe('isBlockedIpv6', () => {
  it('blocks loopback/unspecified/ULA/link-local/multicast/mapped-private/6to4-private', () => {
    expect(isBlockedIpv6(parseIpv6Groups('::1')!)).toBe(true)
    expect(isBlockedIpv6(parseIpv6Groups('::')!)).toBe(true)
    expect(isBlockedIpv6(parseIpv6Groups('fd12::1')!)).toBe(true)
    expect(isBlockedIpv6(parseIpv6Groups('fe80::1')!)).toBe(true)
    expect(isBlockedIpv6(parseIpv6Groups('ff02::1')!)).toBe(true)
    expect(isBlockedIpv6(parseIpv6Groups('[::ffff:10.0.0.1]')!)).toBe(true)
    expect(isBlockedIpv6(parseIpv6Groups('2002:7f00:1::')!)).toBe(true)
  })
  it('allows public', () => {
    expect(isBlockedIpv6(parseIpv6Groups('2606:4700::1')!)).toBe(false)
  })
})

describe('validateTargetUrl', () => {
  it('allows plain public https', () => {
    const r = validateTargetUrl('https://github.com/u/r')
    expect(r.ok).toBe(true)
  })
  it('rejects non-http protocols', () => {
    expect(validateTargetUrl('ftp://8.8.8.8/x').ok).toBe(false)
    expect(validateTargetUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateTargetUrl('javascript:alert(1)').ok).toBe(false)
  })
  it('rejects invalid urls', () => {
    expect(validateTargetUrl('not a url').ok).toBe(false)
    expect(validateTargetUrl('https://').ok).toBe(false)
  })
  it('rejects credentials', () => {
    expect(validateTargetUrl('https://user:pass@8.8.8.8/').ok).toBe(false)
  })
  it.each([
    'http://127.0.0.1/admin',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://10.0.0.1/',
    'http://172.16.0.9/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.1.2/',
    'http://[::1]/',
    'http://[fd12::1]/',
    'http://[fe80::1%25eth0]/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:8080/',
    'http://foo.local/',
    'http://api.internal/',
    'http://metadata.google.internal/',
  ])('blocks %s', (u) => {
    const r = validateTargetUrl(u)
    expect(r.ok).toBe(false)
  })
  it('port rules', () => {
    expect(validateTargetUrl('https://8.8.8.8:443/x').ok).toBe(true)
    expect(validateTargetUrl('https://8.8.8.8/x').ok).toBe(true)
    expect(validateTargetUrl('http://8.8.8.8:80/').ok).toBe(true)
    expect(validateTargetUrl('http://8.8.8.8:6379/').ok).toBe(false)
    expect(validateTargetUrl('http://8.8.8.8:8080/').ok).toBe(false)
    expect(validateTargetUrl('http://8.8.8.8:8080/', { allowedPorts: [8080] }).ok).toBe(true)
    expect(validateTargetUrl('http://8.8.8.8:12345/', { allowedPorts: 'all' }).ok).toBe(true)
  })
  it('allowPrivate override for internal scenarios', () => {
    expect(validateTargetUrl('http://127.0.0.1/', { allowPrivate: true }).ok).toBe(true)
  })
  it('trailing dot host', () => {
    expect(validateTargetUrl('https://127.0.0.1./x').ok).toBe(false)
  })
})
