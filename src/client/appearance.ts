export function isDarkTheme(theme: string, systemDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark)
}

export function toggledTheme(theme: string, systemDark: boolean): 'light' | 'dark' {
  return isDarkTheme(theme, systemDark) ? 'light' : 'dark'
}
