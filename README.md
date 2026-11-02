# Tube DJ

A single-page DJ app for YouTube playlists and local audio files.

## Use it online

**https://ahhh.github.io/youtube_dj/** runs entirely in your browser (Chrome or Edge
on desktop). YouTube tracks play through YouTube's own player, and local audio files
are decoded in full for exact BPM, key and beat-synced mixing.

The hosted app never downloads anything from YouTube. To get YouTube tracks as local
files, do it yourself on your own computer. The **⇩ Download & convert** button in
the app explains the options:

- **Convert script.** Download [`tools/tubedj-convert.mjs`](tools/tubedj-convert.mjs)
  (Node 20+, no npm install; ffmpeg optional for mp3 output):

  ```sh
  node tubedj-convert.mjs "https://www.youtube.com/watch?v=VIDEO_ID" [more links] [-o folder] [--raw]
  ```

  Then drop the files into Tube DJ.
- **Local companion server.** Run the server below and click *Connect* in the
  hosted app's Download & convert dialog. Convert buttons then work in place.

Only download content you have the right to.

## Run it locally (with in-app YouTube → mp3 conversion)

Needs Node 20+ and Chrome or Edge on desktop.

```sh
cd server
npm install   # first time only
npm start
```

Open **http://127.0.0.1:8000**, or connect the hosted app to it.

The server only listens on loopback. Besides its own pages it accepts browser
requests from `https://ahhh.github.io` and `https://dj.lockboxx.org`. If you host a fork somewhere else, set
`TUBEDJ_ORIGINS` (comma-separated) to that site's origin:

```sh
TUBEDJ_ORIGINS=https://yourname.github.io npm start
```

## Hosting your own copy on GitHub Pages

`.github/workflows/pages.yml` publishes `index.html`, `core.js` and the convert
script on every push to `main`. Turn it on once under **Settings → Pages → Source:
GitHub Actions**.
