# Hanami Lobby

Bản demo game nhập vai luyện nói tiếng Anh của 9speak. Người chơi đi lại trong thành phố và sảnh khách sạn ở Tokyo; gặp nhân vật nào thì mở cuộc gọi luyện nói với giọng đọc (text-to-speech) và micro (speech-to-text), có nhận xét sau mỗi câu, Sổ tay, Ôn tập giãn cách và Hồ sơ.

## Cấu trúc

| File | Vai trò |
| --- | --- |
| `index.html` | Toàn bộ game (một file, không cần build) |
| `server.js` | Backend Node: phục vụ game, gọi Claude bằng key của server, lưu tiến độ vào Postgres |
| `railway.json` | Cấu hình deploy trên Railway |

## Deploy trên Railway

1. Tạo project từ GitHub repo này. Railway tự nhận Node và chạy `npm start`.
2. Thêm database **Postgres** vào cùng project.
3. Trong service game, mục **Variables**, thêm:

| Biến | Giá trị |
| --- | --- |
| `ANTHROPIC_API_KEY` | Key Anthropic của 9speak |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (tham chiếu tới database vừa thêm) |

4. Mục **Settings → Networking**, bấm **Generate Domain** để có link https.

Biến tùy chọn: `ANTHROPIC_MODEL` (mặc định `claude-haiku-5-5`), `MAX_CALLS_PER_10_MIN` (mặc định 60 lượt mỗi IP), `MAX_CALLS_PER_DAY` (mặc định 3000 lượt cho cả server).

Bảng `progress` tự được tạo khi server khởi động.

## API

| Đường dẫn | Việc |
| --- | --- |
| `GET /api/health` | Trạng thái: có AI, có database |
| `POST /api/npc` | Nhân vật trả lời một câu. Prompt và tính cách nhân vật nằm ở server, nên key không dùng được vào việc khác |
| `POST /api/hint` | Gợi ý câu nói tiếp theo |
| `GET /api/progress?device=…` | Lấy tiến độ theo mã thiết bị |
| `PUT /api/progress` | Lưu tiến độ |

Tiến độ gắn với một mã thiết bị ngẫu nhiên lưu trong trình duyệt. Muốn chơi tiếp trên máy khác, chép mã ở tab Hồ sơ và dán vào máy kia.

## Chạy trên máy

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=postgres://... npm start
# mở http://localhost:3000
```

Thiếu `ANTHROPIC_API_KEY` thì nhân vật dùng kịch bản có sẵn; thiếu `DATABASE_URL` thì tiến độ chỉ lưu trong trình duyệt.

Mở `index.html` trực tiếp (hoặc qua GitHub Pages) vẫn chơi được: không có server thì game hiện ô nhập API key ở tab Hồ sơ.

## Trình duyệt

- Giọng đọc: Web Speech API (`speechSynthesis`), có trên hầu hết trình duyệt.
- Nhận giọng nói: `SpeechRecognition`, chạy tốt trên Chrome và Edge; Safari và Firefox có thể phải gõ chữ.
- Micro chỉ hoạt động trên `https://` hoặc `localhost`.
