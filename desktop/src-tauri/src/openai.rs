use serde::Deserialize;
use serde_json::Value;

const SECRET_URL: &str = "https://api.openai.com/v1/realtime/translations/client_secrets";

pub fn normalize_key(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("Bearer ")
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

pub fn normalize_noise(raw: &str) -> &'static str {
    if raw == "far_field" { "far_field" } else { "near_field" }
}

pub async fn open_client_secret(
    client: &reqwest::Client,
    key: &str,
    noise: &str,
) -> Result<String, String> {
    let noise = normalize_noise(noise);
    let body = serde_json::json!({
        "session": {
            "model": "gpt-realtime-translate",
            "audio": {
                "input": { "noise_reduction": { "type": noise } },
                "output": { "language": "ru" }
            }
        }
    });

    let response = client
        .post(SECRET_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Не удалось связаться с OpenAI".to_string())?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|_| "Пустой ответ OpenAI".to_string())?;

    if !(200..300).contains(&status) {
        return Err(explain_failure(status, &text));
    }

    extract_secret(&text).ok_or_else(|| "В ответе нет секрета сессии".to_string())
}

pub fn explain_failure(status: u16, body: &str) -> String {
    let message = error_message(body);
    let lower = message.to_lowercase();
    if status == 401 {
        return "Ключ не принят.".to_string();
    }
    if status == 403 {
        return match message.is_empty() {
            true => "Этому ключу нельзя открыть перевод.".to_string(),
            false => format!("Этому ключу нельзя открыть перевод. {message}"),
        };
    }
    if lower.contains("quota")
        || lower.contains("billing")
        || lower.contains("insufficient")
        || lower.contains("credit")
    {
        return match message.is_empty() {
            true => "Оплата или квота не пускают.".to_string(),
            false => format!("Оплата или квота не пускают. {message}"),
        };
    }
    if status == 429 {
        return match message.is_empty() {
            true => "Слишком много запросов или кончилась квота.".to_string(),
            false => format!("Слишком много запросов или кончилась квота. {message}"),
        };
    }
    if message.is_empty() {
        format!("OpenAI ответил ошибкой {status}.")
    } else {
        message
    }
}

fn error_message(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return clip(body);
    };
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(clip)
        .unwrap_or_default()
}

fn clip(text: &str) -> String {
    let trimmed = text.trim();
    trimmed.chars().take(180).collect()
}

fn extract_secret(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Secret {
        value: Option<String>,
        client_secret: Option<Nested>,
    }
    #[derive(Deserialize)]
    struct Nested {
        value: Option<String>,
    }

    let parsed: Secret = serde_json::from_str(body).ok()?;
    let value = parsed
        .value
        .filter(|item| !item.is_empty())
        .or_else(|| {
            parsed
                .client_secret
                .and_then(|secret| secret.value)
                .filter(|item| !item.is_empty())
        })?;
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_bearer_prefix() {
        assert_eq!(normalize_key("  Bearer sk-test  "), "sk-test");
        assert_eq!(normalize_key("sk-plain"), "sk-plain");
    }

    #[test]
    fn reads_either_secret_shape() {
        assert_eq!(
            extract_secret(r#"{"value":"ek_live"}"#).as_deref(),
            Some("ek_live")
        );
        assert_eq!(
            extract_secret(r#"{"client_secret":{"value":"ek_nested"}}"#).as_deref(),
            Some("ek_nested")
        );
    }

    #[test]
    fn maps_auth_and_billing_errors() {
        assert_eq!(explain_failure(401, r#"{"error":{"message":"bad"}}"#), "Ключ не принят.");
        let billing = explain_failure(
            429,
            r#"{"error":{"message":"You exceeded your current quota"}}"#,
        );
        assert!(billing.contains("квота"));
        assert!(billing.contains("quota"));
    }
}
