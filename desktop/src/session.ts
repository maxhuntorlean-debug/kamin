const CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";

export type LiveSession = {
  stop: () => void;
};

type ServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

export async function startLiveSession(
  stream: MediaStream,
  secret: string,
  handlers: {
    onDelta: (delta: string) => void;
    onDone: (transcript: string | null) => void;
    onFail: (message: string) => void;
  },
): Promise<LiveSession> {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("Микрофон не найден");

  const connection = new RTCPeerConnection();
  let closed = false;
  const sink = new Audio();
  sink.muted = true;
  sink.volume = 0;

  const stop = () => {
    closed = true;
    connection.ontrack = null;
    connection.close();
    sink.srcObject = null;
    stream.getTracks().forEach((item) => item.stop());
  };

  connection.addTrack(track, stream);
  connection.ontrack = (event) => {
    const [remote] = event.streams;
    if (remote) sink.srcObject = remote;
  };

  const events = connection.createDataChannel("oai-events");
  events.addEventListener("message", (message) => {
    if (closed) return;
    let event: ServerEvent;
    try {
      event = JSON.parse(String(message.data)) as ServerEvent;
    } catch {
      return;
    }
    if (event.type === "session.output_transcript.delta" && typeof event.delta === "string") {
      handlers.onDelta(event.delta);
      return;
    }
    if (event.type === "session.output_transcript.done") {
      handlers.onDone(typeof event.transcript === "string" ? event.transcript : null);
      return;
    }
    if (event.type === "error") {
      const text = event.error?.message || "Ошибка сессии";
      if (/empty|too small/i.test(text)) return;
      handlers.onFail(text);
    }
  });

  connection.addEventListener("connectionstatechange", () => {
    if (closed) return;
    if (connection.connectionState === "failed") {
      handlers.onFail("Связь с переводом прервалась");
    }
  });

  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIce(connection);
    const sdp = connection.localDescription?.sdp ?? offer.sdp;
    if (!sdp) throw new Error("Не удалось подготовить соединение");

    const response = await fetch(CALLS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/sdp",
      },
      body: sdp,
    });
    if (!response.ok) throw new Error(await readableError(response));
    await connection.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
  } catch (error) {
    stop();
    throw error;
  }

  return { stop };
}

export async function openMicrophone(deviceId: string, autoGainControl = true): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl,
    channelCount: 1,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch {
    throw new Error(
      deviceId
        ? "Выбранный микрофон недоступен. Выбери другой в настройках."
        : "Нет доступа к микрофону.",
    );
  }
}

export type MicProbe = {
  label: string;
  stop: () => void;
};

export async function probeMicrophone(
  deviceId: string,
  onLevel: (level: number) => void,
): Promise<MicProbe> {
  const context = new AudioContext();
  const resumePromise = context.resume();
  const stream = await openMicrophone(deviceId);
  await resumePromise;
  const track = stream.getAudioTracks()[0];
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  const source = context.createMediaStreamSource(stream);
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(analyser);
  analyser.connect(mute);
  mute.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  analyser.smoothingTimeConstant = 0;
  let noise = 0;
  let shown = 0;
  let lastSent = -1;
  const timer = window.setInterval(() => {
    if (context.state === "suspended") void context.resume();
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    if (noise === 0) noise = Math.max(rms, 0.00001);
    else if (rms < noise) noise = noise * 0.6 + rms * 0.4;
    else noise = noise * 0.997 + rms * 0.003;
    const ratio = rms / noise;
    const target = ratio < 1.35 ? 0 : Math.min(1, (ratio - 1.35) / 1.4);
    shown = target > shown ? shown * 0.25 + target * 0.75 : shown * 0.55 + target * 0.45;
    const step = shown < 0.015 ? 0 : Math.round(shown * 24) / 24;
    if (step !== lastSent) {
      lastSent = step;
      onLevel(step);
    }
  }, 50);
  return {
    label: track?.label || "",
    stop() {
      window.clearInterval(timer);
      stream.getTracks().forEach((item) => item.stop());
      void context.close();
    },
  };
}

export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  let inputs = devices.filter((device) => device.kind === "audioinput");
  if (inputs.length === 0 || inputs.some((device) => !device.label)) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((device) => device.kind === "audioinput");
  }
  return inputs.map((device, index) => ({
    id: device.deviceId,
    label: device.label || `Микрофон ${index + 1}`,
  }));
}

function waitForIce(connection: RTCPeerConnection): Promise<void> {
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
  });
}

async function readableError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: { message?: string } };
    if (payload.error?.message) return payload.error.message;
  } catch {
    // The SDP endpoint sometimes returns plain text.
  }
  return text.slice(0, 180) || "Не удалось подключить перевод";
}
