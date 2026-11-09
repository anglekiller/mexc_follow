const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Desktop build only: Android-only modules are swapped for the versions in desktop/shims.
const SHIMS = new Set([
  'expo-haptics',
  'expo-local-authentication',
  'expo-notifications',
  'expo-secure-store',
  'react-native-android-widget',
  'react-native-webview',
]);

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && SHIMS.has(moduleName)) {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'desktop', 'shims', `${moduleName}.js`) };
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
