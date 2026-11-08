# Build from source

Use Node.js 22 or later on macOS. Git is needed for repository imports.

```sh
npm ci --ignore-scripts
npm test
npm_config_ignore_scripts=true npm run package:mac
```

The app is written to `release/mac-arm64/Skills Manager.app` on an Apple Silicon Mac. Dependency lifecycle scripts remain disabled. Packaging downloads the Electron runtime; it does not need an Apple signing identity.

To run the development server, use `npm run dev` after the Electron runtime is available in `node_modules/electron/dist`.

The app uses Electron, React, TypeScript, Radix UI, and Motion. UI component provenance and license notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
