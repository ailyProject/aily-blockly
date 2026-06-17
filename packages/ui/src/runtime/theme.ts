export type ThemeMode = 'light' | 'dark'

const darkClassName = 'dark'
const themeStorageKey = 'theme-mode'

function syncTheme(mode: ThemeMode) {
	document.documentElement.classList.toggle(darkClassName, mode === 'dark')
	document.documentElement.setAttribute('data-theme', mode)
	document.documentElement.style.colorScheme = mode
	localStorage.setItem(themeStorageKey, mode)
}

export function getThemeMode(): ThemeMode {
	if (typeof document === 'undefined') {
		return 'light'
	}

	const storedMode = localStorage.getItem(themeStorageKey)
	if (storedMode === 'dark' || storedMode === 'light') {
		return storedMode
	}

	return document.documentElement.classList.contains(darkClassName) ? 'dark' : 'light'
}

export function applyThemeMode(mode: ThemeMode): ThemeMode {
	if (typeof document === 'undefined') {
		return mode
	}

	syncTheme(mode)
	return mode
}

export function toggleThemeMode(): ThemeMode {
	return applyThemeMode(getThemeMode() === 'dark' ? 'light' : 'dark')
}
