const PAUSE_MS = 1100;
const MAX_LINES = 80;

const FLIP_KEY = "kamin-mic-facing-partner";
const MODE_KEY = "kamin-mode";
const NOISE_KEY = "kamin-noise";
const LANG_KEY = "kamin-target-lang";
const API_KEY = "kamin-openai-key";
const TRANSLATION_CALLS = "https://api.openai.com/v1/realtime/translations/calls";
const TRANSCRIPTION_CALLS = "https://api.openai.com/v1/realtime/calls";
const TARGET_LANGS = {
  ru: "Russian",
  en: "English",
  de: "German",
};
const appEl = document.querySelector(".app");
const flipButton = document.querySelector("#flip");
const translateButton = document.querySelector("#mode-translate");
const textButton = document.querySelector("#mode-text");
const farButton = document.querySelector("#noise-far");
const nearButton = document.querySelector("#noise-near");
const langButtons = [...document.querySelectorAll("[data-lang]")];
const apiKeyInput = document.querySelector("#api-key");
const keyStateEl = document.querySelector("#key-state");
const keySaveButton = document.querySelector("#key-save");
const keyClearButton = document.querySelector("#key-clear");
const subtitleEl = document.querySelector("#subtitle");
const settingsEl = document.querySelector("#settings");
const settingsButton = document.querySelector("#settings-open");
const settingsClose = document.querySelector("#settings-close");
const confirmClearEl = document.querySelector("#confirm-clear");
const confirmClearCancel = document.querySelector("#confirm-clear-cancel");
const confirmClearOk = document.querySelector("#confirm-clear-ok");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const listenButton = document.querySelector("#mode-listen");
const speakButton = document.querySelector("#mode-speak");
const idleActions = document.querySelector("#idle-actions");
const liveActions = document.querySelector("#live-actions");
const historyEl = document.querySelector("#history");
const currentEl = document.querySelector("#current");
const currentRuEl = document.querySelector("#current-ru");
const emptyEl = document.querySelector("#empty");
const countEl = document.querySelector("#count");
const pillEl = document.querySelector("#pill");
const pillTextEl = document.querySelector("#pill-text");
const statusEl = document.querySelector("#status");

const IDLE_TEXT = "Place the phone between you and tap Listen.";
const WAITING_TEXT = "Listening…";
const RU_IDLE_TEXT = "Russian appears after each phrase.";
const RU_WAITING_TEXT = "Waiting for a phrase…";

let phase = "idle";
let sessionId = 0;
let lines = [];
let current = "";
let currentRu = "";
let pauseTimer = 0;
let peer = null;
let micStream = null;
let wakeLock = null;
let audioSink = null;
let eventsChannel = null;
let vadTimer = 0;
let vadContext = null;
let liveItem = "";
let committedItem = "";
let flipped = localStorage.getItem(FLIP_KEY) === "1";
let mode = localStorage.getItem(MODE_KEY) === "text" ? "text" : "translate";
let noise = localStorage.getItem(NOISE_KEY) === "near_field" ? "near_field" : "far_field";
let targetLang = readTargetLang();

translateButton.addEventListener("click", () => {
  selectMode("translate");
});
textButton.addEventListener("click", () => {
  selectMode("text");
});
farButton.addEventListener("click", () => {
  selectNoise("far_field");
});
nearButton.addEventListener("click", () => {
  selectNoise("near_field");
});
for (const button of langButtons) {
  button.addEventListener("click", () => {
    selectTargetLang(button.dataset.lang);
  });
}
keySaveButton.addEventListener("click", () => {
  const next = apiKeyInput.value.trim();
  if (!next) {
    keyStateEl.textContent = "Paste a key first";
    return;
  }
  localStorage.setItem(API_KEY, next);
  apiKeyInput.value = "";
  render();
});
keyClearButton.addEventListener("click", () => {
  if (!localStorage.getItem(API_KEY) && !apiKeyInput.value.trim()) {
    keyStateEl.textContent = "No key saved";
    return;
  }
  setConfirmClear(true);
});
confirmClearCancel.addEventListener("click", () => {
  setConfirmClear(false);
});
confirmClearOk.addEventListener("click", () => {
  localStorage.removeItem(API_KEY);
  apiKeyInput.value = "";
  setConfirmClear(false);
  render();
});
confirmClearEl.addEventListener("click", (event) => {
  if (event.target === confirmClearEl) setConfirmClear(false);
});
flipButton.addEventListener("click", () => {
  flipped = !flipped;
  localStorage.setItem(FLIP_KEY, flipped ? "1" : "0");
  applyFlip();
});
settingsButton.addEventListener("click", () => {
  setSettings(settingsEl.hidden);
});
settingsClose.addEventListener("click", () => {
  setSettings(false);
});
settingsEl.addEventListener("click", (event) => {
  if (event.target === settingsEl) setSettings(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!confirmClearEl.hidden) {
    setConfirmClear(false);
    return;
  }
  setSettings(false);
});
startButton.addEventListener("click", () => {
  start();
});
stopButton.addEventListener("click", () => stop());
listenButton.addEventListener("click", () => setSpeaking(false));
speakButton.addEventListener("click", () => setSpeaking(true));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (phase === "listening" || phase === "speaking")) {
    acquireWakeLock();
  }
});

window.addEventListener("pagehide", () => {
  stop();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

applyFlip();
fitViewport();
window.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("resize", fitViewport);
keepPageFromCollapsing();

function readTargetLang() {
  const saved = localStorage.getItem(LANG_KEY);
  return saved && saved in TARGET_LANGS ? saved : "ru";
}

function render() {
  appEl.classList.toggle("mode-text", mode === "text");
  appEl.classList.toggle("mode-translate", mode === "translate");

  historyEl.replaceChildren();
  for (const line of lines) {
    const entry = document.createElement("div");
    entry.className = "entry";
    if (typeof line === "string") {
      const translated = document.createElement("p");
      translated.textContent = line;
      entry.appendChild(translated);
    } else {
      const source = document.createElement("p");
      source.className = "source";
      source.textContent = line.no;
      entry.appendChild(source);
      const translation = document.createElement("p");
      translation.className = line.ru ? "translation" : "translation pending";
      translation.textContent = line.ru || "Translating…";
      entry.appendChild(translation);
    }
    historyEl.appendChild(entry);
  }
  historyEl.scrollTop = historyEl.scrollHeight;
  emptyEl.hidden = lines.length > 0;
  emptyEl.textContent =
    mode === "text"
      ? "Norwegian and Russian lines will show up here."
      : "Translated lines will show up here.";
  countEl.textContent = phraseCount(lines.length);

  const live = phase === "listening" || phase === "speaking";
  const text = current.trim();
  if (text) {
    currentEl.textContent = current;
    currentEl.classList.remove("placeholder");
  } else if (phase === "listening") {
    currentEl.textContent = WAITING_TEXT;
    currentEl.classList.add("placeholder");
  } else if (phase === "speaking") {
    currentEl.textContent = "Mic paused — your turn";
    currentEl.classList.add("placeholder");
  } else if (phase === "connecting") {
    currentEl.textContent = "Connecting…";
    currentEl.classList.add("placeholder");
  } else if (lines.length) {
    currentEl.textContent = "Tap Listen to start again.";
    currentEl.classList.add("placeholder");
  } else {
    currentEl.textContent = IDLE_TEXT;
    currentEl.classList.add("placeholder");
  }

  if (mode === "text") {
    const ruText = currentRu.trim();
    if (ruText) {
      currentRuEl.textContent = currentRu;
      currentRuEl.classList.toggle("placeholder", currentRu === "Translating…");
    } else if (phase === "listening" || phase === "speaking") {
      currentRuEl.textContent = RU_WAITING_TEXT;
      currentRuEl.classList.add("placeholder");
    } else if (phase === "connecting") {
      currentRuEl.textContent = "Connecting…";
      currentRuEl.classList.add("placeholder");
    } else {
      currentRuEl.textContent = RU_IDLE_TEXT;
      currentRuEl.classList.add("placeholder");
    }
  }

  subtitleEl.textContent =
    mode === "text" ? "Norwegian → Russian" : `To ${TARGET_LANGS[targetLang]}`;
  translateButton.setAttribute("aria-pressed", mode === "translate" ? "true" : "false");
  textButton.setAttribute("aria-pressed", mode === "text" ? "true" : "false");
  farButton.setAttribute("aria-pressed", noise === "far_field" ? "true" : "false");
  nearButton.setAttribute("aria-pressed", noise === "near_field" ? "true" : "false");
  for (const button of langButtons) {
    button.setAttribute("aria-pressed", button.dataset.lang === targetLang ? "true" : "false");
  }
  keyStateEl.textContent = localStorage.getItem(API_KEY) ? "Key saved" : "";

  pillEl.classList.toggle("on", phase === "listening");
  pillEl.classList.toggle("paused", phase === "speaking");
  pillTextEl.textContent = pillLabel(phase);
  stopButton.hidden = !live && phase !== "connecting";
  idleActions.hidden = live || phase === "connecting";
  liveActions.hidden = !live;
  startButton.disabled = phase === "connecting";
  listenButton.setAttribute("aria-pressed", phase === "listening" ? "true" : "false");
  speakButton.setAttribute("aria-pressed", phase === "speaking" ? "true" : "false");
}

function setSettings(open) {
  settingsEl.hidden = !open;
  settingsButton.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) {
    setConfirmClear(false);
    fitViewport();
  }
}

function setConfirmClear(open) {
  confirmClearEl.hidden = !open;
}

function applyFlip() {
  appEl.classList.toggle("flipped", flipped);
  flipButton.setAttribute("aria-pressed", flipped ? "true" : "false");
}

function fitViewport() {
  if (!settingsEl.hidden) return;
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.height = `${height}px`;
  document.body.style.height = `${height}px`;
}

function keepPageFromCollapsing() {
  let lastY = 0;
  document.addEventListener("touchstart", (event) => {
    lastY = event.touches[0]?.clientY ?? 0;
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    const scroller = event.target.closest?.(".history, .current, .current-ru, .settings-card");
    const y = event.touches[0]?.clientY ?? lastY;
    const pullingDown = y > lastY;
    const pushingUp = y < lastY;
    lastY = y;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) {
      event.preventDefault();
      return;
    }
    const atTop = scroller.scrollTop <= 0;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    if ((atTop && pullingDown) || (atBottom && pushingUp)) event.preventDefault();
  }, { passive: false });
}

function pillLabel(value) {
  if (value === "listening") return "Listening";
  if (value === "speaking") return "Translation paused";
  if (value === "connecting") return "Connecting";
  return "Idle";
}

function phraseCount(count) {
  if (count === 0) return "";
  return count === 1 ? "1 phrase" : `${count} phrases`;
}

function appendDelta(delta, itemId) {
  if (itemId && liveItem && itemId !== liveItem) commitLine();
  if (itemId) liveItem = itemId;
  current += delta;
  scheduleCommit();
  render();
}

function scheduleCommit() {
  window.clearTimeout(pauseTimer);
  pauseTimer = window.setTimeout(commitLine, PAUSE_MS);
}

function commitLine() {
  window.clearTimeout(pauseTimer);
  pauseTimer = 0;
  const text = current.trim();
  current = "";
  if (text) {
    committedItem = liveItem;
    if (mode === "text") {
      saveTextPair(text);
    } else {
      lines.push(text);
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      render();
    }
  } else {
    render();
  }
  liveItem = "";
}

function finishTranscript(transcript, itemId) {
  window.clearTimeout(pauseTimer);
  pauseTimer = 0;
  const text = (typeof transcript === "string" && transcript.trim()) || current.trim();
  const refine = Boolean(itemId) && itemId === committedItem;
  current = "";
  liveItem = "";
  if (text) {
    if (mode === "text") {
      const last = lines[lines.length - 1];
      if (refine && last && typeof last === "object") {
        if (last.no !== text) {
          last.no = text;
          last.ru = "";
          currentRu = "Translating…";
          render();
          void fillTranslation(last);
        }
      } else {
        saveTextPair(text);
      }
      committedItem = itemId || committedItem;
    } else {
      if (refine) lines[lines.length - 1] = text;
      else if (lines[lines.length - 1] !== text) lines.push(text);
      committedItem = itemId || committedItem;
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      render();
    }
  } else {
    render();
  }
}

function saveTextPair(noText) {
  const entry = { no: noText, ru: "" };
  lines.push(entry);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  currentRu = "Translating…";
  render();
  void fillTranslation(entry);
}

async function fillTranslation(entry) {
  try {
    const translation = await requestTranslation(entry.no);
    entry.ru = translation;
    if (lines[lines.length - 1] === entry) currentRu = translation;
  } catch (error) {
    entry.ru = error instanceof Error ? error.message : "Translation failed";
    if (lines[lines.length - 1] === entry) currentRu = entry.ru;
  }
  render();
}

async function requestTranslation(text) {
  const apiKey = localStorage.getItem(API_KEY)?.trim() || "";
  if (!apiKey) throw new Error("Add an OpenAI key in Settings");
  const response = await fetch("/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, apiKey }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.translation !== "string") {
    throw new Error(payload.error?.message || "Translation failed");
  }
  return payload.translation;
}

async function selectMode(next) {
  if (next === mode) return;
  const live = phase !== "idle";
  const wasSpeaking = phase === "speaking";
  if (live) {
    commitAudio();
    commitLine();
  }
  mode = next;
  localStorage.setItem(MODE_KEY, mode);
  lines = [];
  current = "";
  currentRu = "";
  if (!live) {
    render();
    return;
  }
  sessionId += 1;
  hangup();
  phase = "idle";
  await start({ keepLines: true });
  if (wasSpeaking && phase === "listening") setSpeaking(true);
}

async function selectNoise(next) {
  if (next === noise) return;
  const live = phase !== "idle";
  const wasSpeaking = phase === "speaking";
  if (live) {
    commitAudio();
    commitLine();
  }
  noise = next;
  localStorage.setItem(NOISE_KEY, noise);
  if (!live) {
    render();
    return;
  }
  sessionId += 1;
  hangup();
  phase = "idle";
  await start({ keepLines: true });
  if (wasSpeaking && phase === "listening") setSpeaking(true);
}

async function selectTargetLang(next) {
  if (!next || !(next in TARGET_LANGS) || next === targetLang) return;
  const live = phase !== "idle";
  const wasSpeaking = phase === "speaking";
  if (live) {
    commitAudio();
    commitLine();
  }
  targetLang = next;
  localStorage.setItem(LANG_KEY, targetLang);
  if (!live) {
    render();
    return;
  }
  sessionId += 1;
  hangup();
  phase = "idle";
  await start({ keepLines: true });
  if (wasSpeaking && phase === "listening") setSpeaking(true);
}

function setStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

async function start(options = {}) {
  if (phase !== "idle") return;
  const id = ++sessionId;
  const modeAtStart = mode;
  const noiseAtStart = noise;
  const langAtStart = targetLang;
  phase = "connecting";
  if (!options.keepLines) {
    lines = [];
    current = "";
    currentRu = "";
    liveItem = "";
    committedItem = "";
  }
  setStatus("");
  render();

  try {
    const secret = await requestClientSecret(modeAtStart, noiseAtStart, langAtStart);
    if (id !== sessionId) return;

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    if (id !== sessionId) {
      stopMic();
      return;
    }

    const track = micStream.getAudioTracks()[0];
    if (!track) throw new Error("Microphone not found");

    await connectSession(track, secret, modeAtStart);
    if (id !== sessionId) {
      hangup();
      return;
    }

    phase = "listening";
    if (modeAtStart === "text") watchSpeech(micStream);
    await acquireWakeLock();
    if (id !== sessionId) {
      releaseWakeLock();
      return;
    }
    render();
  } catch (error) {
    if (id !== sessionId) return;
    hangup();
    phase = "idle";
    render();
    setStatus(error instanceof Error ? error.message : "Couldn’t start");
  }
}

async function requestClientSecret(modeAtStart, noiseAtStart, langAtStart) {
  const apiKey = localStorage.getItem(API_KEY)?.trim() || "";
  if (!apiKey) throw new Error("Add an OpenAI key in Settings");
  const response = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: modeAtStart,
      noise: noiseAtStart,
      language: langAtStart,
      apiKey,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  const value = typeof payload.value === "string" ? payload.value : payload.client_secret?.value;
  if (!response.ok || typeof value !== "string") {
    throw new Error(payload.error?.message || "Couldn’t open a session");
  }
  return value;
}

async function connectSession(track, clientSecret, modeAtStart) {
  const connection = new RTCPeerConnection();
  peer = connection;
  connection.addTrack(track, micStream);

  audioSink = new Audio();
  audioSink.muted = true;
  audioSink.volume = 0;
  connection.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream && audioSink) audioSink.srcObject = stream;
  };

  const events = connection.createDataChannel("oai-events");
  eventsChannel = events;
  let transcriptKind = "";
  events.addEventListener("message", (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (modeAtStart === "translate") {
      if (event.type === "session.output_transcript.delta" && typeof event.delta === "string") {
        appendDelta(event.delta);
      }
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      finishTranscript(event.transcript, event.item_id);
    } else if (typeof event.delta === "string" && acceptsTranscript(event.type, transcriptKind)) {
      transcriptKind = event.type.startsWith("session.") ? "session" : "item";
      appendDelta(event.delta, event.item_id);
    }
    if (event.type === "error") {
      const message = event.error?.message || "Session error";
      if (modeAtStart === "text" && /empty|too small/i.test(message)) return;
      fail(message);
    }
  });

  connection.addEventListener("connectionstatechange", () => {
    if (connection.connectionState === "failed") {
      fail("Translation connection dropped");
    }
  });

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await waitForIce(connection);

  const callsUrl = modeAtStart === "text" ? TRANSCRIPTION_CALLS : TRANSLATION_CALLS;
  const sdpResponse = await fetch(callsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp",
    },
    body: connection.localDescription?.sdp ?? offer.sdp,
  });

  if (!sdpResponse.ok) {
    throw new Error(await readableError(sdpResponse));
  }

  await connection.setRemoteDescription({
    type: "answer",
    sdp: await sdpResponse.text(),
  });
}

function waitForIce(connection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    const timeout = window.setTimeout(finish, 2500);
    connection.addEventListener("icegatheringstatechange", onChange);
    if (connection.iceGatheringState === "complete") finish();
  });
}

async function readableError(response) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    if (payload.error?.message) return payload.error.message;
  } catch {
    // SDP endpoint sometimes returns plain text.
  }
  return text.slice(0, 180) || "Couldn’t connect translation";
}

function acceptsTranscript(type, kind) {
  const itemDelta = type === "conversation.item.input_audio_transcription.delta";
  const sessionDelta = type === "session.input_transcript.delta";
  if (!itemDelta && !sessionDelta) return false;
  if (!kind) return true;
  return kind === "item" ? itemDelta : sessionDelta;
}

function setSpeaking(speaking) {
  if (phase !== "listening" && phase !== "speaking") return;
  const track = micStream?.getAudioTracks()[0];
  // A disabled microphone track sends silence, so the session stays open
  // while your own Norwegian is kept out of the translation.
  if (track) track.enabled = !speaking;
  if (speaking) {
    commitAudio();
    commitLine();
  }
  phase = speaking ? "speaking" : "listening";
  if (navigator.vibrate) navigator.vibrate(15);
  render();
}

function fail(message) {
  setStatus(message);
  if (phase === "idle") return;
  sessionId += 1;
  hangup();
  phase = "idle";
  commitLine();
  render();
}

function stop() {
  if (phase === "idle") return;
  sessionId += 1;
  hangup();
  phase = "idle";
  commitLine();
  setStatus("");
  render();
}

function watchSpeech(stream) {
  stopVad();
  const context = new AudioContext();
  vadContext = context;
  context.resume().catch(() => {});
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let heardSpeech = false;
  let silentFor = 0;
  vadTimer = window.setInterval(() => {
    if (phase !== "listening") {
      heardSpeech = false;
      silentFor = 0;
      return;
    }
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const sample = (samples[i] - 128) / 128;
      sum += sample * sample;
    }
    if (Math.sqrt(sum / samples.length) > 0.015) {
      heardSpeech = true;
      silentFor = 0;
      return;
    }
    if (!heardSpeech) return;
    silentFor += 100;
    if (silentFor < 800) return;
    heardSpeech = false;
    silentFor = 0;
    commitAudio();
  }, 100);
}

function commitAudio() {
  if (!eventsChannel || eventsChannel.readyState !== "open" || mode !== "text") return;
  eventsChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
}

function stopVad() {
  window.clearInterval(vadTimer);
  vadTimer = 0;
  vadContext?.close().catch(() => {});
  vadContext = null;
}

function hangup() {
  window.clearTimeout(pauseTimer);
  pauseTimer = 0;
  stopVad();
  eventsChannel = null;
  if (peer) {
    peer.close();
    peer = null;
  }
  if (audioSink) {
    audioSink.srcObject = null;
    audioSink = null;
  }
  stopMic();
  releaseWakeLock();
}

function stopMic() {
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

render();
