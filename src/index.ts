const TRANSLATION_SECRET_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";
const TRANSCRIPTION_SECRET_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
const CHAT_URL = "https://api.openai.com/v1/chat/completions";

const TARGET_LANGUAGES = new Set(["ru", "en", "de"]);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/session") {
      return createSession(request);
    }
    if (url.pathname === "/translate") {
      return translateText(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function createSession(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: { message: "POST required" } },
      { status: 405 },
    );
  }

  const options = await readOptions(request);
  const apiKey = options.apiKey?.trim() ?? "";
  if (!apiKey) {
    return Response.json(
      { error: { message: "Add an OpenAI key in Settings" } },
      { status: 401 },
    );
  }
  const textMode = options.mode === "text";
  const noise = options.noise === "near_field" ? "near_field" : "far_field";
  const language =
    options.language && TARGET_LANGUAGES.has(options.language)
      ? options.language
      : "ru";
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
          output: { language },
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
      { error: { message: "Couldn’t reach OpenAI" } },
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

async function translateText(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: { message: "POST required" } },
      { status: 405 },
    );
  }

  const options = await readTranslateOptions(request);
  const apiKey = options.apiKey?.trim() ?? "";
  const text = options.text?.trim() ?? "";
  if (!apiKey) {
    return Response.json(
      { error: { message: "Add an OpenAI key in Settings" } },
      { status: 401 },
    );
  }
  if (!text) {
    return Response.json(
      { error: { message: "Nothing to translate" } },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Translate Norwegian to Russian. Return only the Russian translation. No quotes, labels, or explanation.",
          },
          { role: "user", content: text },
        ],
      }),
    });
  } catch {
    return Response.json(
      { error: { message: "Couldn’t reach OpenAI" } },
      { status: 502 },
    );
  }

  const payload = (await upstream.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!upstream.ok) {
    return Response.json(
      {
        error: {
          message: payload.error?.message || "Translation failed",
        },
      },
      { status: upstream.status },
    );
  }

  const translation = payload.choices?.[0]?.message?.content?.trim() ?? "";
  if (!translation) {
    return Response.json(
      { error: { message: "Empty translation" } },
      { status: 502 },
    );
  }

  return Response.json(
    { translation },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}

async function readOptions(
  request: Request,
): Promise<{
  mode?: string;
  noise?: string;
  language?: string;
  apiKey?: string;
}> {
  try {
    return (await request.json()) as {
      mode?: string;
      noise?: string;
      language?: string;
      apiKey?: string;
    };
  } catch {
    return {};
  }
}

async function readTranslateOptions(
  request: Request,
): Promise<{ text?: string; apiKey?: string }> {
  try {
    return (await request.json()) as { text?: string; apiKey?: string };
  } catch {
    return {};
  }
}
