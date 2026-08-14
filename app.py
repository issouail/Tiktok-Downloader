"""
TikTok Video Downloader — backend
Credit: oua1l.1 (Instagram @Oua1l.1)

Requires:
    pip install -r requirements.txt
    ffmpeg installed and on PATH (video merge + mp3 extraction)

Run locally:
    python app.py
Then open http://127.0.0.1:5000
"""

import os
import re
import time
import uuid
import threading
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify, send_file, render_template, after_this_request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

try:
    import yt_dlp
except ImportError:
    raise SystemExit("yt-dlp is not installed. Run: pip install -r requirements.txt")

app = Flask(__name__)

limiter = Limiter(get_remote_address, app=app, default_limits=["200 per hour"])

DOWNLOAD_DIR = Path(tempfile.gettempdir()) / "tiktok_downloader_tmp"
DOWNLOAD_DIR.mkdir(exist_ok=True)

TIKTOK_URL_RE = re.compile(r"(tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)", re.IGNORECASE)

# in-memory job tracking for progress polling
JOBS = {}
JOBS_LOCK = threading.Lock()
JOB_TTL_SECONDS = 30 * 60  # sweep stale jobs after 30 min


def is_tiktok_url(url: str) -> bool:
    return bool(url) and bool(TIKTOK_URL_RE.search(url))


def base_ydl_opts():
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        # If TikTok starts blocking anonymous/server requests, export cookies
        # from a logged-in browser session and point yt-dlp at the file:
        # "cookiefile": "cookies.txt",
    }


def sweep_stale_jobs():
    cutoff = time.time() - JOB_TTL_SECONDS
    with JOBS_LOCK:
        stale = [jid for jid, j in JOBS.items() if j.get("created_at", 0) < cutoff]
        for jid in stale:
            fp = JOBS[jid].get("filepath")
            if fp and os.path.exists(fp):
                try:
                    os.remove(fp)
                except OSError:
                    pass
            JOBS.pop(jid, None)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/info", methods=["POST"])
@limiter.limit("30 per hour")
def info():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()

    if not url:
        return jsonify({"error": "Paste a TikTok link first."}), 400
    if not is_tiktok_url(url):
        return jsonify({"error": "That doesn't look like a TikTok link."}), 400

    try:
        with yt_dlp.YoutubeDL(base_ydl_opts()) as ydl:
            meta = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Couldn't read that video. ({exc})"}), 502

    formats = meta.get("formats", []) or []
    heights = sorted({f.get("height") for f in formats if f.get("height")})
    available = {
        "720": any(h and h >= 700 for h in heights),
        "1080": any(h and h >= 1000 for h in heights),
        "mp3": True,  # audio can always be extracted from any format
    }

    return jsonify({
        "url": url,
        "title": meta.get("title") or meta.get("description") or "TikTok video",
        "author": meta.get("uploader") or meta.get("creator") or "unknown",
        "thumbnail": meta.get("thumbnail"),
        "duration": meta.get("duration"),
        "available": available,
    })


def _progress_hook(job_id):
    def hook(d):
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes", 0)
                job["percent"] = round(downloaded / total * 100, 1) if total else job.get("percent", 0)
                job["status"] = "downloading"
            elif d.get("status") == "finished":
                job["status"] = "processing"
                job["percent"] = 99
    return hook


def _run_download(job_id, url, quality):
    outtmpl = str(DOWNLOAD_DIR / f"{job_id}.%(ext)s")
    ydl_opts = base_ydl_opts()
    ydl_opts["outtmpl"] = outtmpl
    ydl_opts["progress_hooks"] = [_progress_hook(job_id)]

    if quality == "mp3":
        ydl_opts["format"] = "bestaudio/best"
        ydl_opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }]
    else:
        target_height = int(quality)
        ydl_opts["format"] = (
            f"bestvideo[height<={target_height}]+bestaudio/"
            f"best[height<={target_height}]/best"
        )
        ydl_opts["merge_output_format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            meta = ydl.extract_info(url, download=True)
            filepath = ydl.prepare_filename(meta)
            ext = "mp3" if quality == "mp3" else "mp4"
            typed_path = str(Path(filepath).with_suffix(f".{ext}"))
            if os.path.exists(typed_path):
                filepath = typed_path

        if not os.path.exists(filepath):
            raise RuntimeError("file was not produced")

        safe_title = re.sub(r"[^\w\-]+", "_", (meta.get("title") or "tiktok"))[:60]
        label = "mp3" if quality == "mp3" else f"{quality}p"
        download_name = f"{safe_title}_{label}.{ext}"

        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if job is not None:
                job.update(
                    status="done",
                    percent=100,
                    filepath=filepath,
                    download_name=download_name,
                    title=meta.get("title"),
                )
    except Exception as exc:  # noqa: BLE001
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if job is not None:
                job.update(status="error", error=str(exc))


@app.route("/api/download/start", methods=["POST"])
@limiter.limit("15 per hour")
def download_start():
    sweep_stale_jobs()
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    quality = str(data.get("quality") or "720")

    if not url or not is_tiktok_url(url):
        return jsonify({"error": "Invalid TikTok URL."}), 400
    if quality not in ("720", "1080", "mp3"):
        return jsonify({"error": "Quality must be 720, 1080, or mp3."}), 400

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "starting", "percent": 0, "created_at": time.time()}

    thread = threading.Thread(target=_run_download, args=(job_id, url, quality), daemon=True)
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/download/status/<job_id>")
def download_status(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Unknown or expired job."}), 404
        safe = {k: v for k, v in job.items() if k not in ("filepath",)}
    return jsonify(safe)


@app.route("/api/download/file/<job_id>")
def download_file(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job or job.get("status") != "done":
            return jsonify({"error": "File not ready."}), 400
        filepath = job["filepath"]
        download_name = job["download_name"]

    @after_this_request
    def cleanup(response):
        try:
            os.remove(filepath)
        except OSError:
            pass
        with JOBS_LOCK:
            JOBS.pop(job_id, None)
        return response

    return send_file(filepath, as_attachment=True, download_name=download_name)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
