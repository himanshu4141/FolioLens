const VARIANTS = {
  production: {
    appName: 'FolioLens',
    scheme: 'foliolens',
    iosBundleIdentifier: 'com.foliolens.app',
    androidPackage: 'com.foliolens.app',
  },
  development: {
    appName: 'FolioLens Dev',
    scheme: 'foliolens-dev',
    iosBundleIdentifier: 'com.foliolens.app.dev',
    androidPackage: 'com.foliolens.app.dev',
  },
  'preview-main': {
    appName: 'FolioLens Main',
    scheme: 'foliolens-main',
    iosBundleIdentifier: 'com.foliolens.app.mainpreview',
    androidPackage: 'com.foliolens.app.mainpreview',
  },
  'preview-pr': {
    appName: 'FolioLens PR',
    scheme: 'foliolens-pr',
    iosBundleIdentifier: 'com.foliolens.app.prpreview',
    androidPackage: 'com.foliolens.app.prpreview',
  },
};

function getVariant() {
  const raw = process.env.APP_VARIANT ?? 'production';
  return Object.prototype.hasOwnProperty.call(VARIANTS, raw) ? raw : 'production';
}

module.exports = ({ config }) => {
  const variant = getVariant();
  const variantConfig = VARIANTS[variant];

  return {
    ...config,
    name: variantConfig.appName,
    slug: 'foliolens',
    version: '1.0.0',
    scheme: variantConfig.scheme,
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: 'https://u.expo.dev/fa824fc9-9add-418b-8959-eeeeb693b7b5'
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: variantConfig.iosBundleIdentifier,
      icon: {
        light: './assets/images/icon.png',
        dark: './assets/images/icon-dark.png',
        tinted: './assets/images/icon-tinted.png',
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/adaptive-icon.png',
        monochromeImage: './assets/images/monochrome-icon.png',
        backgroundColor: '#ffffff',
      },
      package: variantConfig.androidPackage,
      softwareKeyboardLayoutMode: 'resize',
    },
    web: {
      bundler: 'metro',
      output: 'static',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        {
          image: './assets/images/splash-icon.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#ffffff',
          dark: {
            image: './assets/images/splash-icon-dark.png',
            backgroundColor: '#06101F',
          },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      appVariant: variant,
      appScheme: variantConfig.scheme,
      "eas": {
        "projectId": "fa824fc9-9add-418b-8959-eeeeb693b7b5"
      }
    },
    owner: 'himanshu4141',
  };
};
