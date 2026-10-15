import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import mark from "./mark.png";
import {
  checkKey,
  errorText,
  getSettings,
  openSession,
  runningInApp,
  saveSettings,
  type KeyCheck,
  type Noise,
  type PublicSettings,
} from "./api";
import { listMicrophones, openMicrophone, probeMicrophone, startLiveSession, type LiveSession, type MicProbe } from "./session";

const PAUSE_MS = 1100;
const MAX_LINES = 80;

type Phase = "idle" | "connecting" | "listening";
type Mic = { id: string; label: string };

export default function App() {
  const inApp = runningInApp();
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [banner, setBanner] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftMic, setDraftMic] = useState("");
  const [draftNoise, setDraftNoise] = useState<Noise>("near_field");
  const [mics, setMics] = useState<Mic[]>([]);
  const [micsLoading, setMicsLoading] = useState(false);
  const [micError, setMicError] = useState("");
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micLabel, setMicLabel] = useState("");
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);

  const generation = useRef(0);
  const sessionRef = useRef<LiveSession | null>(null);
  const pauseRef = useRef(0);
  const currentRef = useRef("");
  const phaseRef = useRef<Phase>("idle");
  const savedRef = useRef<PublicSettings | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const probeRef = useRef<MicProbe | null>(null);
  const probeGen = useRef(0);

  phaseRef.current = phase;
  savedRef.current = saved;

  const pushCurrent = useCallback(() => {
    window.clearTimeout(pauseRef.current);
    pauseRef.current = 0;
    const text = currentRef.current.trim();
    currentRef.current = "";
    setCurrent("");
    if (!text) return;
    setLines((prev) => {
      const next = [...prev, text];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  const fail = useCallback(
    (message: string) => {
      generation.current += 1;
      window.clearTimeout(pauseRef.current);
      sessionRef.current?.stop();
      sessionRef.current = null;
      pushCurrent();
      setPhase("idle");
      setBanner(message);
    },
    [pushCurrent],
  );

  const stop = useCallback(() => {
    generation.current += 1;
    window.clearTimeout(pauseRef.current);
    sessionRef.current?.stop();
    sessionRef.current = null;
    pushCurrent();
    setPhase("idle");
    setBanner("");
  }, [pushCurrent]);

  const openSettings = useCallback(() => {
    const currentSaved = savedRef.current;
    setDraftKey("");
    setDraftMic(currentSaved?.microphoneId ?? "");
    setDraftNoise(currentSaved?.noise === "far_field" ? "far_field" : "near_field");
    setCheck(null);
    setSettingsOpen(true);
  }, []);

  const start = useCallback(
    async (keepLines: boolean) => {
      const settings = savedRef.current;
      if (!settings?.hasKey) {
        setBanner("Сначала сохрани ключ OpenAI в настройках.");
        openSettings();
        return;
      }

      const id = ++generation.current;
      probeRef.current?.stop();
      probeRef.current = null;
      probeGen.current += 1;
      setMicTesting(false);
      setMicLevel(0);
      setMicLabel("");
      sessionRef.current?.stop();
      sessionRef.current = null;
      window.clearTimeout(pauseRef.current);
      if (keepLines) pushCurrent();
      else {
        currentRef.current = "";
        setCurrent("");
        setLines([]);
      }
      setPhase("connecting");
      setBanner("");

      try {
        const secret = await openSession();
        if (id !== generation.current) return;
        const stream = await openMicrophone(savedRef.current?.microphoneId ?? "");
        if (id !== generation.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const live = await startLiveSession(stream, secret, {
          onDelta(delta) {
            if (id !== generation.current) return;
            currentRef.current += delta;
            setCurrent(currentRef.current);
            window.clearTimeout(pauseRef.current);
            pauseRef.current = window.setTimeout(() => {
              if (id !== generation.current) return;
              pushCurrent();
            }, PAUSE_MS);
          },
          onDone(transcript) {
            if (id !== generation.current) return;
            if (transcript?.trim()) {
              currentRef.current = transcript;
              setCurrent(transcript);
            }
            pushCurrent();
          },
          onFail(message) {
            if (id !== generation.current) return;
            fail(message);
          },
        });
        if (id !== generation.current) {
          live.stop();
          return;
        }
        sessionRef.current = live;
        setPhase("listening");
      } catch (error) {
        if (id !== generation.current) return;
        sessionRef.current?.stop();
        sessionRef.current = null;
        setPhase("idle");
        setBanner(errorText(error));
      }
    },
    [fail, openSettings, pushCurrent],
  );

  useEffect(() => {
    if (!inApp) return;
    let alive = true;
    getSettings()
      .then((next) => {
        if (alive) setSaved(next);
      })
      .catch((error) => {
        if (alive) setBanner(errorText(error));
      });
    return () => {
      alive = false;
    };
  }, [inApp]);

  useEffect(() => {
    const history = historyRef.current;
    if (history) history.scrollTop = history.scrollHeight;
  }, [lines]);

  useEffect(() => {
    if (!settingsOpen) return;
    keyInputRef.current?.focus();
    let alive = true;
    const load = () => {
      setMicsLoading(true);
      setMicError("");
      listMicrophones()
        .then((devices) => {
          if (alive) setMics(devices);
        })
        .catch(() => {
          if (alive) setMicError("Нет доступа к микрофону.");
        })
        .finally(() => {
          if (alive) setMicsLoading(false);
        });
    };
    load();
    const onChange = () => load();
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener("devicechange", onChange);
      window.removeEventListener("keydown", onKey);
      probeRef.current?.stop();
      probeRef.current = null;
      probeGen.current += 1;
      setMicTesting(false);
      setMicLevel(0);
      setMicLabel("");
    };
  }, [settingsOpen]);

  function stopMicTest() {
    probeGen.current += 1;
    probeRef.current?.stop();
    probeRef.current = null;
    setMicTesting(false);
    setMicLevel(0);
    setMicLabel("");
  }

  async function onMicTest() {
    if (probeRef.current) {
      stopMicTest();
      return;
    }
    if (phaseRef.current !== "idle") {
      setMicError("Сначала останови перевод.");
      return;
    }
    const id = ++probeGen.current;
    setMicError("");
    try {
      const probe = await probeMicrophone(draftMic, (level) => {
        if (id === probeGen.current) setMicLevel(level);
      });
      if (id !== probeGen.current) {
        probe.stop();
        return;
      }
      probeRef.current = probe;
      setMicLabel(probe.label);
      setMicTesting(true);
    } catch (error) {
      if (id === probeGen.current) setMicError(errorText(error));
    }
  }

  function onStart() {
    if (!inApp) {
      setBanner("Открой это окно в приложении Kamin.");
      return;
    }
    void start(false);
  }

  async function onCheck() {
    if (!inApp) {
      setCheck({ ok: false, message: "Открой это окно в приложении Kamin." });
      return;
    }
    setBusy("check");
    try {
      setCheck(await checkKey(draftKey.trim() ? draftKey : null));
    } catch (error) {
      setCheck({ ok: false, message: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!inApp) {
      setCheck({ ok: false, message: "Открой это окно в приложении Kamin." });
      return;
    }
    setBusy("save");
    try {
      const previous = savedRef.current;
      const next = await saveSettings({
        apiKey: draftKey.trim() ? draftKey : null,
        microphoneId: draftMic,
        noise: draftNoise,
      });
      const changed =
        draftKey.trim() !== "" ||
        next.microphoneId !== (previous?.microphoneId ?? "") ||
        next.noise !== (previous?.noise ?? "near_field");
      savedRef.current = next;
      setSaved(next);
      setDraftKey("");
      setCheck({ ok: true, message: "Сохранено." });
      if (phaseRef.current !== "idle" && changed) await start(true);
    } catch (error) {
      setCheck({ ok: false, message: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  const liveText = current.trim();
  const placeholder = placeholderText(phase, lines.length);
  const pill = phase === "listening" ? "Слушаю" : phase === "connecting" ? "Подключаюсь" : "Не слушаю";

  return (
    <main className="app">
      <header className="top">
        <div className="brand">
          <img className="mark" src={mark} alt="" width={44} height={44} />
          <div>
            <h1>Kamin</h1>
            <p>Перевод на русский</p>
          </div>
        </div>
        <div className="top-side">
          <button
            type="button"
            className="gear"
            aria-expanded={settingsOpen}
            aria-controls="settings"
            onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())}
          >
            <GearIcon />
            <span className="sr">Настройки</span>
          </button>
          <p className={`status ${phase === "listening" ? "on" : ""}`}>
            <span className="dot" aria-hidden="true" />
            {pill}
          </p>
        </div>
      </header>

      {banner ? (
        <p className="banner error" role="alert">
          {banner}
        </p>
      ) : null}

      <div className="board">
        <section className="card now" aria-labelledby="now-title">
          <h2 id="now-title">Сейчас</h2>
          <p className={liveText ? "current" : "current placeholder"}>
            {liveText || placeholder}
          </p>
        </section>

        <section className="card archive" aria-labelledby="archive-title">
          <div className="card-head">
            <h2 id="archive-title">Накоплено</h2>
            {lines.length > 0 ? <p className="count">{phraseCount(lines.length)}</p> : null}
          </div>
          {lines.length === 0 ? (
            <p className="empty">Уже сказанное появится здесь.</p>
          ) : (
            <div className="history" ref={historyRef}>
              {lines.map((line, index) => (
                <div className="entry" key={`${index}-${line.slice(0, 24)}`}>
                  <p>{line}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card listen">
          <h2>Слушать</h2>
          <p className="hint">
            {phase === "listening"
              ? "Слышу микрофон и перевожу на русский."
              : phase === "connecting"
                ? "Подключаюсь к переводу…"
                : "Телефон на громкой, микрофон рядом с ним."}
          </p>
          {phase === "idle" ? (
            <button type="button" className="primary wide" onClick={onStart} disabled={inApp && !saved}>
              Слушать
            </button>
          ) : (
            <button type="button" className="stop" onClick={stop}>
              <span className="stop-mark" aria-hidden="true" />
              {phase === "connecting" ? "Отмена" : "Стоп"}
            </button>
          )}
        </section>
      </div>

      <footer className="foot">
        <p className="notes">
          <span>OpenAI Translate</span>
          <span className="sep" aria-hidden="true" />
          <span>На русский</span>
        </p>
      </footer>

      {settingsOpen ? (
        <div
          id="settings"
          className="settings"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <form className="settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title" onSubmit={onSave}>
            <div className="settings-head">
              <h2 id="settings-title">Настройки</h2>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)}>
                Закрыть
              </button>
            </div>

            <section className="settings-block">
              <h3>Ключ OpenAI</h3>
              <input
                ref={keyInputRef}
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draftKey}
                placeholder="sk-..."
                onChange={(event) => setDraftKey(event.target.value)}
              />
              {check ? (
                <p className={check.ok ? "key-hint ok" : "key-hint bad"}>{check.message}</p>
              ) : (
                <p className="key-hint">
                  {saved?.hasKey
                    ? "Ключ сохранён. Вставь новый, чтобы заменить."
                    : "Ключ нужен, чтобы открыть перевод."}
                </p>
              )}
              <div className="settings-actions">
                <button type="button" onClick={() => void onCheck()} disabled={busy !== null}>
                  {busy === "check" ? "Проверяю…" : "Проверить"}
                </button>
                <button type="submit" className="primary" disabled={busy !== null}>
                  {busy === "save" ? "Сохраняю…" : "Сохранить"}
                </button>
              </div>
            </section>

            <section className="settings-block">
              <h3>Микрофон</h3>
              <select
                className="field"
                value={draftMic}
                onChange={(event) => {
                  setDraftMic(event.target.value);
                  stopMicTest();
                }}
                aria-label="Микрофон"
              >
                <option value="">{micsLoading ? "Смотрю микрофоны…" : "Системный микрофон"}</option>
                {mics.map((mic) => (
                  <option key={mic.id} value={mic.id}>
                    {mic.label}
                  </option>
                ))}
                {draftMic && !mics.some((mic) => mic.id === draftMic) ? (
                  <option value={draftMic}>Сохранённый микрофон недоступен</option>
                ) : null}
              </select>
              <button type="button" className="mic-test" onClick={() => void onMicTest()}>
                {micTesting ? "Остановить проверку" : "Проверить микрофон"}
              </button>
              {micTesting ? (
                <div className="meter" aria-hidden="true">
                  <span style={{ width: `${Math.round(micLevel * 100)}%` }} />
                </div>
              ) : null}
              {micError ? <p className="key-hint bad">{micError}</p> : null}
              {micTesting ? (
                <p className="key-hint">
                  {micLabel ? `Открыт «${micLabel}». ` : ""}
                  В тишине полоска стоит. На голосе она растёт.
                </p>
              ) : null}
            </section>

            <section className="settings-block">
              <h3>Шумоподавление</h3>
              <div className="mode-switch" role="group" aria-label="Шумоподавление">
                <button
                  type="button"
                  className="choice"
                  aria-pressed={draftNoise === "near_field"}
                  onClick={() => setDraftNoise("near_field")}
                >
                  Близко
                </button>
                <button
                  type="button"
                  className="choice"
                  aria-pressed={draftNoise === "far_field"}
                  onClick={() => setDraftNoise("far_field")}
                >
                  Далеко
                </button>
              </div>
            </section>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function placeholderText(phase: Phase, count: number): string {
  if (phase === "connecting") return "Подключаюсь…";
  if (phase === "listening") return "Жду речь…";
  if (count > 0) return "Нажми «Слушать», чтобы начать снова.";
  return "Нажми «Слушать».";
}

function phraseCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  let word = "фраз";
  if (mod10 === 1 && mod100 !== 11) word = "фраза";
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = "фразы";
  return `${count} ${word}`;
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.4 13.5a7.4 7.4 0 0 0 .05-1.5 7.4 7.4 0 0 0-.05-1.5l2.02-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.3-.75l-.36-2.54a.5.5 0 0 0-.5-.41h-3.84a.5.5 0 0 0-.5.41l-.36 2.54c-.46.2-.9.45-1.3.75l-2.39-.96a.5.5 0 0 0-.6.22L2.46 8.28a.5.5 0 0 0 .12.64L4.6 10.5a7.4 7.4 0 0 0 0 3l-2.02 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.4.3.84.55 1.3.75l.36 2.54a.5.5 0 0 0 .5.41h3.84a.5.5 0 0 0 .5-.41l.36-2.54c.46-.2.9-.45 1.3-.75l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64L19.4 13.5ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
      />
    </svg>
  );
}
