/**
 * Version marker. tsup injects the real package version at build time via
 * `define`; running from source (tsx / vitest) falls back to a dev marker.
 */
declare const __MEMENTO_VERSION__: string | undefined;

export const VERSION: string = typeof __MEMENTO_VERSION__ === "string" ? __MEMENTO_VERSION__ : "0.3.0-dev";
