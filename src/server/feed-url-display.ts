function sensitiveParameter(key: string): boolean {
  return /token|secret|password|passwd|auth|signature|credential|api.?key/i.test(key)
    || /(?:access|pass|private|signing)[-_.]?key|(?:^|[-_])(?:sig|hash|key|hmac)(?:$|[-_])/i.test(key)
    || /^(?:x-amz-|x-goog-)|^(?:awsaccesskeyid|googleaccessid|policy|jwt|hdnea|hdnts)$/i.test(key)
}

// Display only the origin and path when a URL contains credentials. Other
// query fields on the same signed URL can be part of the credential too.
export function displayFeedUrl(value: string, hideQuery = false): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (hideQuery || url.username || url.password || [...url.searchParams.keys()].some(sensitiveParameter)) {
      return url.origin + url.pathname
    }
    return value.split('#', 1)[0]
  } catch { return '' }
}

// Providers and older subscriptions can use the feed address as their title.
export function displayFeedTitle(value: string): string {
  return /^https?:\/\/\S+$/i.test(value) ? displayFeedUrl(value) : value
}
