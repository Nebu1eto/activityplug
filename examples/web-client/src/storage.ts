export function removeStorageKeyPrefix(storage: Storage, prefix: string): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix) === true) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
