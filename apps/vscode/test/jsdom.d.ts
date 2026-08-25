declare module "jsdom" {
	type DomWindow = Window & typeof globalThis;

	export class JSDOM {
		readonly window: DomWindow;
		constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string });
	}
}
