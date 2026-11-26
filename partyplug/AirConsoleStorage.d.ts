// Type declarations for AirConsoleStorage (partyplug). Keep in sync with the JS.

export = AirConsoleStorage;

declare namespace AirConsoleStorage {
  interface StorageShim {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
    key(i: number): string | null;
    readonly length: number;
    requestLoad(): void;
    onLoad(cb: () => void): void;
  }

  function install(
    airconsole: any,
    opts?: { allowlist?: string[] }
  ): StorageShim;
}
