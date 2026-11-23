export const signOutKey = 'paper-owner-signed-out'

function signOutFlag() {
  try { return localStorage.getItem(signOutKey) }
  catch { return null }
}

export function signOutPending() { return signOutFlag() === 'pending' }

export function ownerSignedOut() {
  const flag = signOutFlag()
  return flag === 'true' || flag === 'pending'
}
