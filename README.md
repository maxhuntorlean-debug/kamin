# Kamin

Голосовой переводчик в реальном времени: слушает речь и переводит в целевой язык через OpenAI Realtime.

Ключ OpenAI вводится в настройках на устройстве и **не хранится на сервере**.

**Live:** https://kamin.lateshoy.workers.dev

## Что умеет

- Живой голосовой перевод (Realtime Translate)
- Режим текста / транскрипции
- Выбор целевого языка (`ru`, `en`, `de`)
- Шумоподавление near/far field
- PWA для телефона + desktop-приложение в `desktop/`

## Стек

- Cloudflare Worker (`src/index.ts`) — эндпоинты `/session` и `/translate`
- Статический фронт в `public/`
- Wrangler для деплоя

## Локально

```bash
npm install
npm run dev
```

Опционально: скопируй `.dev.vars.example` → `.dev.vars` (ключ обычно задаётся в UI настроек).

## Деплой

```bash
npm run deploy
```

## Структура

| Путь | Назначение |
|------|------------|
| `public/` | Веб-приложение и PWA |
| `src/index.ts` | Worker: сессии OpenAI и перевод |
| `desktop/` | Десктоп-клиент |
| `wrangler.jsonc` | Конфиг Cloudflare |
