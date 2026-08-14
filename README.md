# Snaggr — TikTok Video Downloader

Minimal dark-mode webapp: paste a TikTok link, preview it, download in 720p or 1080p.
Credit: **oua1l.1** — Instagram [@Oua1l.1](https://instagram.com/oua1l.1)

## Stack
- Backend: Python + Flask + [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- Frontend: plain HTML / CSS / JS (no build step)

## Setup

1. Install Python 3.9+ and **ffmpeg** (required to merge video+audio for 1080p):
   - macOS: `brew install ffmpeg`
   - Windows: [download build](https://www.gyan.dev/ffmpeg/builds/) and add to PATH
   - Linux: `sudo apt install ffmpeg`

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Run the app:
   ```bash
   python app.py
   ```

4. Open **http://127.0.0.1:5000** in your browser.

## How it works
- `POST /api/info` — pulls title, author, thumbnail, duration, and which qualities exist.
- `POST /api/download` — downloads the video with yt-dlp at the closest available quality
  to the requested resolution, merges audio+video into an `.mp4`, streams it to the browser,
  then deletes the temp file.

## What's new
- **Real progress bar** — downloads run as background jobs; the frontend polls `/api/download/status/<job_id>` and animates progress from actual bytes downloaded.
- **Paste button** — reads the clipboard via `navigator.clipboard.readText()` (needs HTTPS, which Render gives you).
- **Batch mode** — toggle switch turns the input into a multi-line box; one TikTok link per line, each gets its own preview card and downloads independently.
- **MP3 / audio-only** — third quality button extracts audio with ffmpeg's `FFmpegExtractAudio` postprocessor.
- **Light/dark theme toggle** — persisted in `localStorage`, respects system preference on first load.
- **Download history** — last 20 downloads (title, quality, time) kept in `localStorage`, with a Clear button. This is per-browser, not server-side.
- **Rate limiting** — via `flask-limiter`: 30/hr on `/api/info`, 15/hr on `/api/download/start`, 200/hr default across the app. Adjust the limits in `app.py` if you need more headroom.

A `Dockerfile.reference` is included — compare it against the Dockerfile you already committed to make sure ffmpeg is installed and gunicorn binds to `$PORT`.

## Notes & limits
- Only for videos you have the right to download (your own content, or content whose
  creator allows it) — respect TikTok's Terms of Service and copyright law.
- TikTok frequently changes its site; if fetching starts failing, update yt-dlp:
  ```bash
  pip install -U yt-dlp
  ```
- Not every video actually has a true 1080p source — yt-dlp will fall back to the closest
  quality TikTok provides for that clip.
- If TikTok starts blocking anonymous requests, you can authenticate by uncommenting the
  `cookiesfrombrowser` line in `app.py`.
