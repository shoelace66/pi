export type ThemeMode = "dark" | "light";

export interface ThemeState {
	mode: ThemeMode;
}

const STORAGE_KEY = "pi-desktop-theme";

export function loadThemeState(): ThemeState {
	try {
		const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ThemeState> | null;
		if (value?.mode === "light" || value?.mode === "dark") return { mode: value.mode };
	} catch {
		/* Use the default theme. */
	}
	return { mode: "dark" };
}

export function saveThemeState(state: ThemeState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		/* Storage is optional. */
	}
}

export function applyTheme(state: ThemeState): void {
	document.documentElement.dataset.theme = state.mode;
	document.documentElement.classList.toggle("light", state.mode === "light");
	document.documentElement.classList.toggle("dark", state.mode === "dark");
}
