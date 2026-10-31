# Tube DJ

A single-page DJ app for parties. It works with YouTube playlists and with local audio files. Tube DJ measures each track's BPM and key in the browser, orders the set so tempo and key flow smoothly, and crossfades between two decks.

## Run it

YouTube embeds and tab-audio capture need a real web origin. Opening the file directly (`file://`) won't work, so serve the folder:

```sh
cd youtube_dj
python3 -m http.server 8000
# open http://localhost:8000 in Chrome or Edge (desktop)
```

### YouTube → MP3 (optional local server)

YouTube tracks can't be decoded in the browser, so they only get sampled BPM and key and no beat sync. A small Node server can fetch each video's audio and turn it into an mp3. The track then goes through the same pipeline as a dropped file: exact BPM, key and beat grid, a waveform and true beat sync.

```sh
cd server && npm install   # one time; pulls a static ffmpeg binary
npm start                  # serves the app on http://127.0.0.1:8000 and the /api
```

- **Native extractor.** `server/ytextract.js` calls YouTube's InnerTube player API the way the mobile apps do, picks the best audio-only stream (AAC preferred) and downloads it in ranged chunks. There is no yt-dlp. Only ffmpeg is an external tool (`FFMPEG=/path/to/ffmpeg` overrides the bundled one).
- **Seamless flow.** With the server running, **Analyze pending** converts pending YouTube tracks first, then analyzes them as files, so the tab-share prompt is skipped. The ⇩ button converts a single track, and **Convert all YouTube → MP3** does the whole library. Converted tracks show a `YT→MP3` badge and survive reloads.
- **Cache.** mp3s are stored in `server/cache/` (override with `TUBEDJ_CACHE`). The server binds to `127.0.0.1` only (`HOST`, `PORT` override).
- **Fallback.** If a conversion fails, the track stays a YouTube track and uses the tab-capture analysis.
- This is for personal use. Downloading from YouTube is against its terms of service, and the extractor may break whenever YouTube changes its API.

## How it works

| Piece | How |
|---|---|
| **Import** | Paste any mix of playlist URLs, video URLs or IDs. Playlists are expanded through the YouTube iframe API, so no API key is needed. Duplicate videos are merged across playlists. Titles come from noEmbed. |
| **YouTube analysis** | A YouTube iframe gives a page no access to its audio. Tube DJ works around this by asking you to share **this tab** with audio (`getDisplayMedia`). It then plays each video in a small analyzer player and records 1–3 short samples. Speakers are muted during sampling (`suppressLocalAudioPlayback`). Samples can run at 2× to go faster, with pitch preserved. Samples taken during an ad or a buffering stall are thrown away. |
| **Local files** | Drop files onto the page. Each file is decoded in full with `decodeAudioData`, which gives a more accurate BPM, key and beat grid than YouTube sampling. Files stay in memory and are never uploaded. Their analysis is cached, so dropping the same files in again next time loads them instantly. |
| **BPM** | Spectral-flux onset envelope, then autocorrelation with a comb over 60–200 BPM. The result is folded into your BPM range (default 80–160). |
| **Key** | A chromagram matched against Krumhansl–Kessler profiles, shown in Camelot notation (8A, 9B, …). |
| **Ordering** | Each transition has a cost: BPM distance, weighted heavily, plus key distance on the Camelot wheel. Half and double time are understood. The set order minimizes the total cost: greedy start, then 2-opt and relocate moves. Flow can be *Smooth*, *Build up* (rising BPM) or *Wind down*. |
| **Tempo groups** | Tracks are grouped into tempo bands of about 4.5% across all playlists. Play a whole band, or append it to the set. |
| **Next picks** | The best transitions from the current track, ranked. One click plays a pick next. |
| **Decks** | Two decks. Each can hold a YouTube embed or a local file. Now Playing is large and Up Next is small, and the decks swap places after each mix. |
| **Mixing** | Equal-power crossfade, triggered by the MIX button, the crossfader, auto-mix near the end of a track, or the **M** key. A fade of 0 is a clean cut with no overlap. |
| **Beat sync (local files)** | The incoming track is time-stretched to the outgoing tempo with pitch preserved. It starts on the beat, and a phase lock nudges it into alignment during the fade. Afterwards it glides back to its original tempo. |

Everything is saved to `localStorage`: library, analysis, set and settings.

## Limitations

- **YouTube analysis needs Chrome or Edge on desktop**, plus the "share this tab" prompt. Firefox and Safari can't capture tab audio. As a fallback, click any BPM or key to type it in, or use **Tap BPM** on the playing deck.
- **YouTube tracks can't be beat-matched.** The player only exposes coarse playback-rate steps and play timing is fuzzy, so YouTube transitions are tempo-ordered crossfades. Local files get true beat sync.
- **There's no headphone cue, EQ or filter for YouTube**, because its audio can't be routed through Web Audio. Those could be added for local files later.
- **Some videos block embedding** (common with label/VEVO uploads). These are marked *failed* and skipped. **Ads** can appear in embeds, and analysis discards samples taken during an ad.
- **Playlist expansion through the iframe API** returns at most about 200 videos per playlist.
- **BPM is folded into one octave**, so a 174 BPM drum & bass track shows as 87. Use the ½ and ×2 buttons, or change the BPM range.

## Tests

```sh
node test/core.test.js                     # DSP + ordering on synthetic audio
python3 -m http.server 8765 &              # then, with Chrome installed:
node test/e2e-local.mjs                    # headless: analyze files, build set, crossfade, beat-sync
# with `npm start` running (PORT=8766): python3 test/e2e-convert.py   # convert a video and analyze it
```
