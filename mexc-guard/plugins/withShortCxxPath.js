// Windows MAX_PATH workaround: CMake object paths for autolinked codegen libs
// (e.g. react-native-safe-area-context) reach ~300 chars, which the ninja 1.10
// bundled with the Android SDK cannot create. Two fixes, both no-ops elsewhere:
//  1. stage CMake builds at the drive root (shorter prefix);
//  2. use ninja >= 1.12 (long-path aware) if found at NINJA_EXE or
//     %LOCALAPPDATA%\Android\ninja-1.12.1\ninja.exe.
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = 'buildStagingDirectory';

const SNIPPET = `android {
    externalNativeBuild {
        cmake {
            ${MARKER} = new File(rootDir.toPath().root.toFile(), ".cxx-mexcguard")
        }
    }
    defaultConfig {
        def ninja = System.getenv("NINJA_EXE") ?: "\${System.getenv("LOCALAPPDATA")}/Android/ninja-1.12.1/ninja.exe"
        if (new File(ninja).exists()) {
            externalNativeBuild {
                cmake {
                    arguments "-DCMAKE_MAKE_PROGRAM=\${ninja.replace('\\\\', '/')}"
                }
            }
        }
    }
`;

module.exports = function withShortCxxPath(config) {
  return withAppBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes(MARKER)) {
      c.modResults.contents = c.modResults.contents.replace(/^android\s*\{/m, SNIPPET);
    }
    return c;
  });
};
