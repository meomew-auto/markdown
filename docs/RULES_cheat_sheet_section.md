# Rule cho Section Cheat Sheet beginner-friendly

> Reference doc: `docs/20260518_02_ramping-arrival-rate-tham-so-cong-thuc.md` Section 6

## Cấu trúc 8 sub-section bắt buộc

```text
X.0 Config chung
X.1 5 công thức TOP (cốt lõi)
X.2 Bảng tra nhanh: tình huống → công thức
X.3 Hành động khi gặp vấn đề
X.4 Bảng từ vựng (ký hiệu → đọc là → nghĩa → đơn vị)
X.5 3 công thức "1 dòng" nhớ vĩnh viễn
X.6 Đọc output sau test (số ở đâu)
X.7 Quy trình 5 bước phân tích output
```

## Rule chi tiết cho mỗi sub-section

### Rule 1: Config chung (X.0)

- Template config đầy đủ (JS snippet runable)
- Bảng tham số: `Tham số | Required? | Default | Đơn vị | Ý nghĩa`
- Quy tắc validate (đọc từ core, có line numbers)
- Config tối thiểu (ngắn nhất chạy được)

### Rule 2: 5 công thức TOP (X.1)

**Mỗi công thức phải có**:
1. Tên tiếng Việt (vd "Cần bao nhiêu nhân viên?")
2. Công thức ngắn gọn
3. Diễn giải tiếng Việt (giải thích từng phần công thức)
4. **Ví dụ đời thường** (quán phở, ngân hàng, nhân viên...)
5. **Áp vào k6** (số liệu cụ thể)
6. **Vì sao buffer X%?** (nếu có hằng số ma)
7. **Khi nào dùng**
8. **Liên hệ với công thức khác** (cross-ref liên kết các CT)

**Quan trọng**:
- KHÔNG dùng từ địa phương ("nhặt", "thưa" → "liên tục", "cách quãng")
- Mọi con số trong ví dụ phải có nguồn gốc (lấy từ đâu, áp công thức nào)
- 5 công thức phải có thứ tự logic (CT 1 → 2 → 3 → 4 → 5 dẫn dắt nhau)

### Rule 3: Bảng tra nhanh (X.2)

- Bảng đầu section: `Tình huống | Công thức chính | Phụ trợ`
- Mỗi tình huống có 4-5 bước cụ thể
- Mỗi bước MAPPING với 1 công thức từ X.1 (vd `[Công thức 2]`)
- Có ví dụ số ngay trong bước

### Rule 4: Hành động khi gặp vấn đề (X.3)

- Mỗi vấn đề (drop, interrupt, throughput thấp) có:
  - Nguyên nhân
  - 3-4 cách xử lý theo độ ưu tiên
  - Cross-ref với công thức để verify

### Rule 5: Bảng từ vựng (X.4)

```text
| Ký hiệu | Đọc là | Nghĩa | Đơn vị |
```

- Mọi ký hiệu xuất hiện trong section đều phải có
- Cột "Đọc là" giúp người mới phát âm
- Cuối bảng: "Khác biệt với executor khác" (nếu có)

### Rule 6: 3 công thức "1 dòng" (X.5)

- Đúng 3 dòng (không hơn không kém)
- Bằng tiếng Việt thuần (không ký hiệu λ, W)
- Trả lời 3 câu hỏi cốt lõi của executor

### Rule 7: Đọc output (X.6)

**Bảng mapping nhanh ở đầu**:
```text
| Số liệu | Đọc ở đâu | Dùng cho công thức |
```

**Mỗi nhóm output (Header / Summary / Footer)**:
```text
| Output | Biến | Dùng để |
```

**Block tổng hợp ở cuối**: luồng đọc số → áp công thức theo thứ tự

### Rule 8: Quy trình 5 bước (X.7)

**Bảng mapping ở đầu**:
```text
| Bước | Công thức dùng | Input cần | Output |
```

**Mỗi bước**:
- Tựa nói rõ "[dùng CT N: tên]"
- Mục đích
- Cách làm (sub-step nếu cần)
- Phân loại / diagnose (bảng quyết định)

**Block "5 bước thành 1 dòng" ở cuối** để audit nhanh.

## Rule format markdown

- KHÔNG dùng blockquote `>` chứa code block (markdown render sai)
- Bảng dùng `|` thẳng cột
- Code block `text` cho timeline/công thức, `js`/`go` cho code
- Cross-ref dùng `**Section X.Y**` rõ ràng

## Rule văn phong

- Tiếng Việt thường dân, KHÔNG toán cao cấp
- KHÔNG dùng "tích phân", "đạo hàm", "monotonic", "đơn điệu", "bổ đề", "định lý cực trị"
- Thay thế:
  - "tích phân" → "tổng diện tích" / "cộng dồn"
  - "monotonic" → "tăng đều" / "giảm đều"
  - "đẳng thức" → "quan hệ thứ tự" hoặc "khi nào bằng nhau"
- Mỗi công thức nặng phải có ví dụ đời thường ĐI KÈM
- Số trong ví dụ phải có nguồn (lấy từ công thức nào, lấy ở section nào)

## Rule mạch logic

Cross-reference giữa các sub-section:
```text
X.0 (config) → X.1 (công thức) → X.2 (tình huống) → X.6 (đọc output)
                                                 → X.7 (5 bước phân tích)
```

Trong X.1, các công thức phải nối nhau:
```text
CT 1 (sizing) cần → CT 2 (peak)
CT 3 (đếm slot) cần → CT 4 (rate at t)
CT 5 (verify) so kết quả với CT 3 (N_sched)
```

## Rule xác nhận chất lượng (checklist)

Sau khi viết xong section, kiểm tra:
- [ ] Mỗi công thức có ví dụ đời thường
- [ ] Mỗi con số có nguồn gốc rõ ràng
- [ ] Cross-ref giữa công thức với nhau
- [ ] X.6 + X.7 đều map số/bước với công thức X.1
- [ ] Không có blockquote `>` chứa code block
- [ ] Không có toán cao cấp (calculus)
- [ ] Bảng từ vựng đủ mọi ký hiệu xuất hiện trong section
- [ ] Output mẫu trong X.7 KHỚP với config (drop count phải tính đúng)
