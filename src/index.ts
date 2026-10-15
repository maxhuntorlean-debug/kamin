const TRANSLATION_SECRET_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";
const TRANSCRIPTION_SECRET_URL =
  "https://api.openai.com/v1/realtime/client_secrets";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/session") {
      return createSession(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function createSession(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: { message: "Нужен POST" } },
      { status: 405 },
    );
  }

  const options = await readOptions(request);
  const apiKey = options.apiKey?.trim() ?? "";
  if (!apiKey) {
    return Response.json(
      { error: { message: "В настройках нет ключа OpenAI" } },
      { status: 401 },
    );
  }
  const textMode = options.mode === "text";
  const noise = options.noise === "near_field" ? "near_field" : "far_field";
  const upstreamUrl = textMode ? TRANSCRIPTION_SECRET_URL : TRANSLATION_SECRET_URL;
  const session = textMode
    ? {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: "gpt-live-transcribe",
              languages: ["no"],
            },
            noise_reduction: { type: noise },
            turn_detection: null,
          },
        },
      }
    : {
        model: "gpt-realtime-translate",
        audio: {
          input: { noise_reduction: { type: noise } },
          output: { language: "ru" },
        },
      };

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session }),
    });
  } catch {
    return Response.json(
      { error: { message: "Не удалось связаться с OpenAI" } },
      { status: 502 },
    );
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function readOptions(
  request: Request,
): Promise<{ mode?: string; noise?: string; apiKey?: string }> {
  try {
    return (await request.json()) as { mode?: string; noise?: string; apiKey?: string };
  } catch {
    return {};
  }
}
