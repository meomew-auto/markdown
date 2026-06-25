# ext-07 — Catalog event-driven invalidation

> **Case ID:** `ext-07-catalog-event-invalidation`
> **Script:** `../cdn/06-invalidation-events.js`
> **Profile:** **`full`** (cần Varnish CDN), requires `OPS_AUTH_TOKEN`
> **Proof:** External catalog event source (port 9091) phát event product-updated → app invalidate CDN cache → request tiếp theo chuyển HIT → MISS. Cross-layer: external source → CDN observable effect.

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Team merchandising cập nhật giá sản phẩm trong PIM. Hệ thống catalog phát event `product-updated`. CDN cache của product detail page phải bị invalidate — nếu không, khách hàng sẽ thấy giá cũ (đã được cache).

Đây là **cross-layer scenario**: external event source (layer 6) → app xử lý → CDN cache bị invalidate (layer 1).

### 1.2 Tại sao case này cần topology `full`?

```text
Không có CDN:       Không thể observe HIT → MISS transition
Có CDN (`full`):    Warmup tạo HIT → event → request thấy MISS
```

Đây là case **duy nhất** trong external layer cần `full` topology.

---

## 2. Capability được chứng minh

1. **Warmup**: GET product detail → HIT (CDN cache)
2. **Event phát**: POST `/events/product-updated` đến catalog-events-mock (port 9091)
3. **Invalidation**: App xử lý event → purge/invalidate CDN cache
4. **MISS proof**: GET lại product detail → MISS (cache đã bị xóa)

---

## 3. Flow

```text
1. GET /api/sim/products/:id → X-Cache: MISS (first request)
2. GET /api/sim/products/:id → X-Cache: HIT  (warmed)
3. POST http://localhost:9091/events/product-updated → success
4. GET /api/sim/products/:id → X-Cache: MISS ← INVALIDATED!
```

---

## 4. Key signals

| Phase | X-Cache | Ý nghĩa |
| --- | --- | --- |
| First request | MISS | Chưa có cache |
| After warmup | HIT | Cache populated |
| After event | **MISS** | Cache invalidated! |

---

## 5. Pass/fail

```text
✅ Warmup: HIT achieved
✅ Event: POST 200 OK
✅ Post-event: MISS trên tất cả affected endpoints (detail, recommendations, search, homefeed)
```

---

## 6. Cách chạy

```powershell
# Cần topology full!
docker compose --profile full up -d

$env:CDN_BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/06-invalidation-events.js
```

---

## 7. Real validation data

(TBD)
