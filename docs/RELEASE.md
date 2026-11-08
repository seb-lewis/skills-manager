# v0.1.0 preview

The first public build targets macOS on Apple Silicon. The app is ad-hoc signed, without a Developer ID certificate or Apple notarization.

## Verification

The release passed all 30 behavior checks. It is compiled with TypeScript and electron-vite, then packaged with electron-builder. File-operation checks use temporary homes, real folders, and file-system links. They cover setup, duplicates, conflict handling, bulk failures, retained files, imports, destination changes, Undo, and process-stop recovery.

The screenshots use demo skills in an isolated home. They show the actual packaged app. Installed personal skills are not part of the public repository or screenshots.

The ZIP includes the app only. `SHA256SUMS.txt` records its checksum.

## Known limits

- No Developer ID signing or notarization.
- No Intel, Windows, or Linux binary in this release.
- Full screen-reader use and large-collection timing are not verified.
- A fresh public marketplace download is not part of the release check. Local import and Git behavior use local fixtures.
- Undo turns aliases into independent skill folders.
- Recovery can stop if files change during an unfinished restore. Canonical copies remain until all independent copies are checked.
- The app has no automatic updater. Replace the app bundle to update it.
