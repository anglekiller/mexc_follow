// Backed by Electron safeStorage (Windows DPAPI): see desktop/main.js.
export const getItemAsync = (key) => window.desktopStore.get(key);
export const setItemAsync = (key, value) => window.desktopStore.set(key, value);
export const deleteItemAsync = (key) => window.desktopStore.remove(key);
