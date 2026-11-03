# Hanami Lobby

Bản demo game nhập vai luyện nói tiếng Anh của 9speak. Người chơi đi lại trong thành phố và sảnh khách sạn ở Tokyo; gặp nhân vật nào thì mở cuộc gọi luyện nói với giọng đọc (text-to-speech) và micro (speech-to-text), có nhận xét sau mỗi câu và bảng kết quả cuối màn.

## Chạy thử trên máy

Mở `index.html` qua một server cục bộ để Chrome cho dùng micro ổn định:

```bash
python3 -m http.server 8000
# mở http://localhost:8000
```

## Cách nhân vật trả lời

- Có API key Anthropic: nhập ở màn bản đồ. Key chỉ lưu trong trình duyệt của người chơi và gửi thẳng tới Anthropic.
- Không có key: nhân vật dùng kịch bản có sẵn.

Bản production nên chuyển lời gọi AI sang một backend riêng để không phải để người chơi nhập key.

## Trình duyệt

- Giọng đọc: Web Speech API (`speechSynthesis`), có trên hầu hết trình duyệt.
- Nhận giọng nói: `SpeechRecognition`, chạy tốt trên Chrome và Edge; Safari và Firefox có thể phải gõ chữ.
- Micro chỉ hoạt động trên `https://` hoặc `localhost`.
