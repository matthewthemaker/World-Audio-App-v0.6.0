# World Audio for Android

Walk around inside YouTube and YouTube Music: living room, concert hall, club or studio, with automatic sound placement.
This is the World Audio Chrome extension (0.5) packaged as a phone app. The audio engine is the same code.

**Use headphones.** The 3D placement is built for them.

## How it works

The app shows YouTube / YouTube Music in one WebView and the World Audio control panel in another.
The engine (`app/src/main/assets/engine.js`) is injected into the YouTube page and routes that page's own
audio through Web Audio: stem split, HRTF placement, distance damping and generated room reverb.
Because the page's sound goes through the engine, you hear the processed version only (no doubled audio).

No audio-capture permission is needed. The only permission is Internet.

## Get the APK onto your phone (GitHub Releases)

1. Create a new GitHub repository and put this whole folder in it (including the hidden `.github` folder).
   With git: `git init && git add . && git commit -m "World Audio" && git branch -M main && git remote add origin <your repo URL> && git push -u origin main`
2. Create a release by pushing a tag:
   `git tag v0.6.0 && git push origin v0.6.0`
   (No git? On GitHub, open Releases, Draft a new release, type `v0.6.0` as a new tag, and publish.)
3. Open the **Actions** tab and wait for "Build World Audio APK" to finish (about 3 to 5 minutes).
4. Open **Releases**, download `WorldAudio-0.6.0.apk` on your phone, and open it.
   Android will ask you to allow installs from your browser or Files app. Allow it for this install.
5. Newer versions: push a new tag (`v0.6.1`, ...) and install the new APK over the old one. Settings are kept.

If the build fails, open the failed run in the Actions tab and send me the red error lines.

## Using it

- Pick YouTube or YT Music at the top, start a video or song, then press **Start World Audio**.
- **Layout** cycles between a split screen, a big player and a big control panel.
- Pick a scene, drag the sounds or yourself on the map, or hold the pad to walk and turn.

## Limits (the honest list)

- Only YouTube and YouTube Music on the web. The separate YouTube and Spotify apps can't be processed this way.
- Copy-protected (DRM) streams come out silent through Web Audio, so the engine leaves them alone and they play normally.
  Spotify's web player is DRM-protected, which is why it isn't included.
- Google blocks sign-in inside embedded browsers, so you use YouTube signed out (ads and no Premium).
- Keep the app on screen while listening. YouTube's web player usually pauses when the screen turns off.
  The app keeps the screen awake while World Audio is on.
- There may be a very slight audio/video offset, since the sound takes a detour through the engine. It is not noticeable for music.

## Signing key

`app/world-audio.keystore` is a hobby key kept in the repo so every release can update the last one.
Anyone with the repo can sign an APK that looks like an update, so if you make the repo public and care about that,
generate your own key, keep it in GitHub Secrets and edit `signingConfigs` in `app/build.gradle`.

## Project layout

- `app/src/main/java/app/worldaudio/MainActivity.java`: the two WebViews and the bridge between them
- `app/src/main/assets/engine.js`: the audio engine (from `offscreen.js`)
- `app/src/main/assets/ui/`: the control panel (from `popup.html` / `popup.js`)
- `.github/workflows/build-apk.yml`: builds and publishes the APK

No frameworks and no third-party libraries.
