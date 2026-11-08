# Skills Manager

A local Mac app for managing personal coding-agent skills. Bring existing skills into one collection, keep their original destinations, and manage them one at a time or in bulk.

![Skills Manager collection and details](docs/screenshots/collection.png)

## Download

[Download v0.1.0 for Apple Silicon](https://github.com/seb-lewis/skills-manager/releases/tag/v0.1.0)

This is an early macOS preview. Intel Macs, Windows, and Linux builds are not included. The app is ad-hoc signed, without an Apple Developer ID or notarization.

1. Download and unzip `Skills-Manager-0.1.0-mac-arm64.zip`.
2. Move **Skills Manager.app** to **Applications**.
3. Open the app.

macOS can block an app that is not notarized. See [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). Do not disable Gatekeeper.

## What it does

- Find existing skills in Claude Code, Codex, Shared Agents, Pi, and OpenCode folders.
- Review duplicates and name conflicts before setup.
- Keep each skill's original destinations. Extra destinations are an explicit choice.
- Import local folders, Git repositories, skills.sh links, and supported copied `skills add` commands.
- Search, enable, disable, edit destinations, and delete skills individually or in bulk.
- Undo setup and save independent copies before removing the manager.

The interface uses [Fluid Functionalism](https://www.fluidfunctionalism.com/) components with a dark theme, keyboard controls, and reduced-motion support.

## Get started

Choose **Review existing skills**. Setup shows new skills, duplicates, and conflicts before it changes files. Use **File changes** to inspect the planned paths.

![Setup review with official tabs and accordions](docs/screenshots/setup.png)

For new skills, choose **Import**, select a folder or enter a supported source, then choose the skills and destinations.

![Local import review](docs/screenshots/import.png)

## How files are managed

The app stores complete skill folders in `~/.skills-manager/skills/`. Setup copies and checks each skill before replacing its original entry with a file-system link. It keeps supporting files and safe relative links.

Disabling removes the managed links and keeps the stored files. Deleting removes the stored skill after checking its related links. Neither action controls copies outside the manager's ownership.

Destinations are link locations. Some agents also read shared folders, so a destination choice does not provide isolation between agents.

## Undo and uninstall

Open **Settings → Undo setup**. Review the locations and saved-copy folder, then choose **Restore skills**. Undo restores recorded setup locations and exports the collection. Disabled skills can become available again at their original locations. Link aliases become independent folders.

After Undo completes and you have checked the saved files, move the app to the Trash. You can then remove the empty `.skills-manager` folder. Removing only the app leaves its managed files and links in place.

## Build from source

Use Node.js 22 or later on macOS. Git is needed for repository imports.

```sh
npm ci --ignore-scripts
npm test
npm_config_ignore_scripts=true npm run package:mac
```

The app is written to `release/mac-arm64/Skills Manager.app` on an Apple Silicon Mac. Dependency lifecycle scripts remain disabled. Packaging downloads the Electron runtime; it does not need an Apple signing identity.

To run the development server, use `npm run dev` after the Electron runtime is available in `node_modules/electron/dist`.

## Preview limits

The release has local file-operation, recovery, package, and UI checks. A full screen-reader pass and large-collection performance benchmark are still pending. A stalled restore can require file repair outside the app; stored copies remain until independent copies are checked. See [release verification](docs/RELEASE.md).

## License and credits

[MIT](LICENSE). Built with Electron, React, TypeScript, Radix UI, Motion, and [Fluid Functionalism by Micka Touillaud](https://www.fluidfunctionalism.com/). Inter is distributed under the SIL Open Font License. See [third-party notices](docs/THIRD_PARTY_NOTICES.md).
