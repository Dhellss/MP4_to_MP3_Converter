// Video → MP3 converter. All work happens in the browser.
// Flow: read file → decode audio (Web Audio API) → encode MP3 (lamejs) → download.

const drop = document.getElementById("drop");
const input = document.getElementById("file");
const list = document.getElementById("list");
const kbpsSel = document.getElementById("kbps");
const clearBtn = document.getElementById("clear");

const queue = [];
const urls = [];
let running = false;
let audioCtx = null;

const getCtx = () => (audioCtx ??= new (window.AudioContext || window.webkitAudioContext)());
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function encodeMp3(audio, kbps, onProgress) {
  const channels = Math.min(audio.numberOfChannels, 2);
  const encoder = new lamejs.Mp3Encoder(channels, audio.sampleRate, kbps);
  const left = toInt16(audio.getChannelData(0));
  const right = channels === 2 ? toInt16(audio.getChannelData(1)) : null;

  const block = 1152;
  const parts = [];
  let lastYield = performance.now();

  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block);
    const chunk = right ? encoder.encodeBuffer(l, right.subarray(i, i + block)) : encoder.encodeBuffer(l);
    if (chunk.length) parts.push(new Uint8Array(chunk));

    // let the browser repaint so the progress bar moves
    if (performance.now() - lastYield > 40) {
      onProgress(i / left.length);
      await nextFrame();
      lastYield = performance.now();
    }
  }

  const tail = encoder.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  onProgress(1);
  return new Blob(parts, { type: "audio/mpeg" });
}

function makeItem(file) {
  const li = document.createElement("li");
  li.className = "item";
  li.innerHTML = `
    <span class="name"></span>
    <span class="status">waiting…</span>
    <div class="track"><div class="fill"></div></div>`;
  li.querySelector(".name").textContent = file.name;
  li.querySelector(".name").title = `${file.name} (${fmtSize(file.size)})`;
  list.appendChild(li);
  return {
    file,
    li,
    status: li.querySelector(".status"),
    fill: li.querySelector(".fill"),
    set(text, cls = "") {
      this.status.textContent = text;
      this.status.className = "status " + cls;
    },
  };
}

async function convert(item) {
  try {
    item.set("reading file…");
    const data = await item.file.arrayBuffer();

    item.set("decoding audio…");
    await nextFrame();
    const audio = await getCtx().decodeAudioData(data);

    const kbps = Number(kbpsSel.value);
    item.set("encoding… 0%");
    const blob = await encodeMp3(audio, kbps, (p) => {
      item.fill.style.width = (p * 100).toFixed(0) + "%";
      item.set(`encoding… ${(p * 100).toFixed(0)}%`);
    });

    const url = URL.createObjectURL(blob);
    urls.push(url);

    const a = document.createElement("a");
    a.className = "dl";
    a.href = url;
    a.download = item.file.name.replace(/\.[^.]+$/, "") + ".mp3";
    a.textContent = "Download";
    item.li.appendChild(a);

    item.set(`done · ${fmtSize(blob.size)} · ${kbps} kbps`, "ok");
  } catch (err) {
    console.error(err);
    item.set("can't read the audio of this file. Try MP4, WEBM or MOV.", "err");
  }
}

async function run() {
  if (running) return;
  running = true;
  while (queue.length) await convert(queue.shift());
  running = false;
}

function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("video/") && !f.type.startsWith("audio/") && !/\.(mkv|mov|avi|flv|m4v|ts)$/i.test(f.name)) continue;
    queue.push(makeItem(f));
  }
  clearBtn.hidden = list.children.length === 0;
  run();
}

// --- UI wiring ---
drop.addEventListener("click", () => input.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
});
input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });

["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); })
);
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

// stop the browser from opening a video if it's dropped outside the box
["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

clearBtn.addEventListener("click", () => {
  if (running) return;
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  list.innerHTML = "";
  clearBtn.hidden = true;
});
