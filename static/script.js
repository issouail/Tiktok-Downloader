// ---------- elements ----------
const linkForm = document.getElementById("linkForm");
const urlInput = document.getElementById("urlInput");
const fetchBtn = document.getElementById("fetchBtn");
const fetchBtnLabel = document.getElementById("fetchBtnLabel");
const statusLine = document.getElementById("statusLine");
const scanbar = document.getElementById("scanbar");
const results = document.getElementById("results");
const cardTemplate = document.getElementById("cardTemplate");

const modeToggle = document.getElementById("modeToggle");
const modeLabel = document.getElementById("modeLabel");
const batchHint = document.getElementById("batchHint");
const pasteBtn = document.getElementById("pasteBtn");

const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");

const historySection = document.getElementById("historySection");
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistory");

// ---------- state ----------
let batchMode = false;
const HISTORY_KEY = "snaggr_history";
const THEME_KEY = "snaggr_theme";

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.textContent = theme === "light" ? "☀" : "☾";
  localStorage.setItem(THEME_KEY, theme);
}

(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(saved || (prefersLight ? "light" : "dark"));
})();

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "light" ? "dark" : "light");
});

// ---------- batch mode toggle ----------
modeToggle.addEventListener("click", () => {
  batchMode = !batchMode;
  modeToggle.setAttribute("aria-pressed", String(batchMode));
  modeLabel.textContent = batchMode ? "Batch mode" : "Single link";
  batchHint.hidden = !batchMode;
  fetchBtnLabel.textContent = batchMode ? "Fetch all" : "Fetch";
  urlInput.rows = batchMode ? 4 : 1;
  urlInput.placeholder = batchMode
    ? "https://www.tiktok.com/@user/video/...\nhttps://www.tiktok.com/@user/video/...\n..."
    : "https://www.tiktok.com/@user/video/...";
});

// enter-to-submit in single mode, allow newlines in batch mode
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !batchMode) {
    e.preventDefault();
    linkForm.requestSubmit();
  }
});

// ---------- paste from clipboard ----------
pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    urlInput.value = batchMode ? (urlInput.value ? urlInput.value + "\n" + text : text) : text.trim();
    urlInput.focus();
  } catch (err) {
    setStatus("Couldn't read clipboard — paste manually.", "error");
  }
});

// ---------- status helpers ----------
function setStatus(msg, kind) {
  statusLine.textContent = msg || "";
  statusLine.className = "status-line" + (kind ? ` ${kind}` : "");
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function extractUrls(raw) {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /tiktok\.com/i.test(s));
}

// ---------- form submit ----------
linkForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = urlInput.value.trim();
  if (!raw) return;

  const urls = batchMode ? extractUrls(raw) : (raw ? [raw] : []);
  if (!urls.length) {
    setStatus("No valid TikTok links found.", "error");
    return;
  }

  results.innerHTML = "";
  setStatus("");
  scanbar.hidden = false;
  fetchBtn.disabled = true;

  let okCount = 0;
  for (const url of urls) {
    const ok = await fetchAndRenderCard(url);
    if (ok) okCount += 1;
  }

  scanbar.hidden = true;
  fetchBtn.disabled = false;
  setStatus(
    urls.length > 1
      ? `${okCount}/${urls.length} videos loaded. Pick a quality on each.`
      : okCount ? "Video found. Pick a quality below." : "",
    okCount ? "ok" : "error"
  );
});

async function fetchAndRenderCard(url) {
  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok) {
      renderErrorCard(url, data.error || "Couldn't load this link.");
      return false;
    }

    buildCard(data);
    return true;
  } catch (err) {
    renderErrorCard(url, "Network error while fetching.");
    return false;
  }
}

function renderErrorCard(url, message) {
  const card = document.createElement("div");
  card.className = "preview";
  card.style.padding = "16px 20px";
  card.innerHTML = `<div class="preview-body">
      <p class="preview-author" style="color:var(--magenta)">Failed</p>
      <h2 class="preview-title">${escapeHtml(url)}</h2>
      <div class="download-status error">${escapeHtml(message)}</div>
    </div>`;
  results.appendChild(card);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- build a preview card from /api/info response ----------
function buildCard(data) {
  const node = cardTemplate.content.cloneNode(true);
  const article = node.querySelector(".preview");

  const thumb = node.querySelector(".thumb");
  thumb.src = data.thumbnail || "";
  thumb.alt = data.title || "TikTok video thumbnail";

  node.querySelector(".duration").textContent = formatDuration(data.duration);
  node.querySelector(".preview-author").textContent = `@${data.author}`;
  node.querySelector(".preview-title").textContent = data.title;

  const qualityBtns = node.querySelectorAll(".quality-btn");
  const progressTrack = node.querySelector(".progress-track");
  const progressFill = node.querySelector(".progress-fill");
  const downloadStatus = node.querySelector(".download-status");

  qualityBtns.forEach((btn) => {
    const q = btn.dataset.quality;
    if (data.available && data.available[q] === false) {
      btn.disabled = true;
      return;
    }
    btn.addEventListener("click", () =>
      startDownload({
        url: data.url,
        title: data.title,
        quality: q,
        btn,
        allBtns: qualityBtns,
        progressTrack,
        progressFill,
        downloadStatus,
      })
    );
  });

  results.appendChild(node);
}

// ---------- job-based download with progress polling ----------
async function startDownload({ url, title, quality, btn, allBtns, progressTrack, progressFill, downloadStatus }) {
  allBtns.forEach((b) => (b.disabled = true));
  btn.classList.add("active");
  progressTrack.hidden = false;
  progressFill.style.width = "0%";
  setCardStatus(downloadStatus, `Starting ${quality === "mp3" ? "audio" : quality + "p"} download…`);

  let jobId;
  try {
    const res = await fetch("/api/download/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quality }),
    });
    const data = await res.json();
    if (!res.ok) {
      setCardStatus(downloadStatus, data.error || "Couldn't start download.", "error");
      resetButtons(allBtns, btn, progressTrack);
      return;
    }
    jobId = data.job_id;
  } catch (err) {
    setCardStatus(downloadStatus, "Network error starting download.", "error");
    resetButtons(allBtns, btn, progressTrack);
    return;
  }

  // poll status
  const poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/download/status/${jobId}`);
      const job = await res.json();

      if (!res.ok) {
        clearInterval(poll);
        setCardStatus(downloadStatus, job.error || "Job expired.", "error");
        resetButtons(allBtns, btn, progressTrack);
        return;
      }

      if (job.status === "downloading" || job.status === "starting") {
        const pct = job.percent || 0;
        progressFill.style.width = `${pct}%`;
        setCardStatus(downloadStatus, `Downloading… ${pct}%`);
      } else if (job.status === "processing") {
        progressFill.style.width = "99%";
        setCardStatus(downloadStatus, "Processing…");
      } else if (job.status === "error") {
        clearInterval(poll);
        setCardStatus(downloadStatus, job.error || "Download failed.", "error");
        resetButtons(allBtns, btn, progressTrack);
      } else if (job.status === "done") {
        clearInterval(poll);
        progressFill.style.width = "100%";
        setCardStatus(downloadStatus, "Saving file…");
        await fetchFile(jobId, quality, title);
        setCardStatus(downloadStatus, `${quality === "mp3" ? "Audio" : quality + "p"} saved.`, "ok");
        addToHistory(title, quality);
        resetButtons(allBtns, btn, progressTrack, true);
      }
    } catch (err) {
      clearInterval(poll);
      setCardStatus(downloadStatus, "Lost connection while downloading.", "error");
      resetButtons(allBtns, btn, progressTrack);
    }
  }, 900);
}

async function fetchFile(jobId, quality, title) {
  const res = await fetch(`/api/download/file/${jobId}`);
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const ext = quality === "mp3" ? "mp3" : "mp4";
  const filename = match ? match[1] : `tiktok_${quality}.${ext}`;

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function resetButtons(allBtns, activeBtn, progressTrack, keepBar) {
  allBtns.forEach((b) => (b.disabled = false));
  activeBtn.classList.remove("active");
  if (!keepBar) progressTrack.hidden = true;
}

function setCardStatus(el, msg, kind) {
  el.textContent = msg || "";
  el.className = "download-status" + (kind ? ` ${kind}` : "");
}

// ---------- download history (localStorage) ----------
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 20)));
}

function addToHistory(title, quality) {
  const items = loadHistory();
  items.unshift({ title: title || "TikTok video", quality, time: Date.now() });
  saveHistory(items);
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  historySection.hidden = items.length === 0;
  historyList.innerHTML = "";

  items.forEach((item) => {
    const li = document.createElement("li");
    const when = new Date(item.time);
    const timeStr = when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    li.innerHTML = `
      <span class="h-title">${escapeHtml(item.title)}</span>
      <span class="h-quality">${item.quality === "mp3" ? "MP3" : item.quality + "p"}</span>
      <span class="h-time">${timeStr}</span>
    `;
    historyList.appendChild(li);
  });
}

clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

renderHistory();
