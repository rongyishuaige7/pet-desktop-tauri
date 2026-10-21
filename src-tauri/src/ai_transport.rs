use base64::Engine;
use std::sync::OnceLock;

pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_GENERATION_RESPONSE: usize = 24 * 1024 * 1024;

pub fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|err| format!("创建 HTTP 客户端失败：{}", err.without_url()))
        })
        .clone()
}

/// Enforce the limit even when Content-Length is absent or the server streams chunks.
pub async fn read_limited(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("接口响应超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("读取接口响应失败：{}", err.without_url()))?
    {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("接口响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn decode_base64_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > MAX_IMAGE_BYTES * 4 / 3 + 4 {
        return Err("图片超过 16 MiB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "图片不是有效 base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片为空或超过 16 MiB".into());
    }
    Ok(bytes)
}

pub fn image_data_url(bytes: &[u8]) -> Result<String, String> {
    crate::native_pet::decode_frame(bytes)?;
    // Use the decoded format, never a server-controlled Content-Type header.
    let mime = match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => return Err("图片格式无效".into()),
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn response(wire: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            let _ = stream.write_all(wire);
        });
        (url, server)
    }

    #[test]
    fn rejects_oversized_and_chunked_responses() {
        for wire in [
            &b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n1234\r\n4\r\n5678\r\n0\r\n\r\n"[..],
        ] {
            let (url, server) = response(wire);
            tauri::async_runtime::block_on(async {
                let reply = http_client().unwrap().get(url).send().await.unwrap();
                assert!(read_limited(reply, 6).await.unwrap_err().contains("大小限制"));
            });
            server.join().unwrap();
        }
    }

    #[test]
    fn accepts_small_responses_without_content_length() {
        let (url, server) = response(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n1234");
        tauri::async_runtime::block_on(async {
            let reply = http_client().unwrap().get(url).send().await.unwrap();
            assert_eq!(read_limited(reply, 6).await.unwrap(), b"1234");
        });
        server.join().unwrap();
    }

    #[test]
    fn refuses_invalid_images_and_canonicalizes_mime() {
        assert!(image_data_url(b"not an image").is_err());
        assert!(decode_base64_bytes("invalid base64").is_err());
        let mut buffer = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(10, 10)
            .write_to(&mut buffer, image::ImageFormat::Png)
            .unwrap();
        let result = image_data_url(buffer.get_ref()).unwrap();
        assert!(result.starts_with("data:image/png;base64,"));
        assert_eq!(
            decode_base64_bytes(result.split_once(',').unwrap().1).unwrap(),
            *buffer.get_ref()
        );
    }
}
