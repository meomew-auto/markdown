# Case 06: Event-Driven CDN Invalidation

> **Case ID:** `cdn-06-invalidation-events`
> **Script:** `06-invalidation-events.js` (104 dong)
> **Layer:** CDN / Varnish
> **Proof:** Catalog events (product.updated, category.updated, homefeed.updated) trigger targeted CDN invalidation -- warmed HIT -> event -> next public MISS
> **Phan biet voi case 05:** Case 05 la **manual invalidation** (goi truc tiep purge/ban API). Case 06 la **event-driven invalidation** (event duoc emit, handler tu dong thuc thi invalidation). Case 05 kiem tra "purge co hoat dong khong". Case 06 kiem tra "event co dan den invalidation that su khong".

---

## 1. Tinh huong thuc te

### Nguoi quan tri CMS cap nhat san pham

```text
11:32 AM - Marketing team quyet dinh giam gia san pham "Giay chay bo Pro X"
          tu 2.500.000d xuong 1.990.000d cho dot flash sale sap toi.

11:33 AM - Chi Huong (content admin) mo CMS admin panel.
          Vao trang Product > Giay chay bo Pro X > Edit.
          Sua truong price: 2.500.000 -> 1.990.000.
          Sua truong sale_tag: them "FLASH SALE 20% OFF".
          Bam nut "Save".

11:33:02 - CMS backend luu thay doi vao DB.
           Emit event "product.updated" voi product_id = "pro-x-2026".

11:33:02 - Event duoc publish vao message queue / event bus noi bo.

11:33:03 - CDN Invalidation Service nhan event "product.updated".
           Xac dinh tat ca cache objects bi anh huong:
             - Trang chi tiet san pham: /products/pro-x-2026
             - Trang recommendations co chua san pham nay
             - Trang search results neu "giay chay bo" match
             - Trang homefeed neu san pham nam trong curated list
           Thuc thi targeted invalidation: ban URL + ban prefix.
           (Neu thiet ke tot) Warm lai cac path quan trong.

11:33:04 - Khach hang mo app, vao trang chi tiet "Giay chay bo Pro X".
           CDN: MISS -> fetch tu origin -> nhan duoc gia moi 1.990.000d.
           Khach hang thay gia flash sale -> them vao gio hang -> mua.

NEU EVENT KHONG HOAT DONG:
11:33:04 - Khach hang mo app, vao trang chi tiet "Giay chay bo Pro X".
           CDN: HIT -> serve tu cache (gia cu 2.500.000d).
           Khach hang thay gia 2.500.000d, khong biet co flash sale.
           -> Doanh thu mat, campaign that bai.
           -> Neu khach hang bam mua: order voi gia cu -> refund/complaint.
```

### Tai sao phai la event-driven, khong the manual?

```text
Production co HANG TRIEU san pham. Moi ngay co HANG NGAN lan cap nhat:

  - Marketing team cap nhat gia, mo ta, hinh anh
  - Inventory team cap nhat so luong ton kho (out-of-stock, back-in-stock)
  - Category team thay doi taxonomy (san pham chuyen category)
  - Curation team cap nhat homefeed, featured collections
  - Recommendation engine cap nhat model -> cac san pham duoc goi y thay doi

Khong the nao yeu cau human "sau khi save, mo terminal, chay purge URL X, Y, Z".
That ra human con khong BIET nhung URL nao bi anh huong:

  - San pham X thay doi -> khong chi /products/X bi anh huong
    -> Tat ca search results co chua X bi anh huong
    -> Tat ca category pages co chua X bi anh huong
    -> Homefeed neu X nam trong curated list
    -> Recommendations cua cac san pham lien quan den X
    -> "Customers also bought" section
    -> Cross-sell widgets tren checkout page

  Mot thay doi nho co the anh huong HANG CHUC den HANG TRAM
  cache objects khac nhau trong CDN. Viec tracking manual la bat kha thi.

Event-driven invalidation giai quyet dieu nay:

  - CMS/backend chi can emit event voi entity_id
  - CDN invalidation handler tu tinh toan affected paths
  - Handler thuc thi targeted invalidation (khong xoa toan bo cache)
  - Handler warm lai cac path quan trong (tranh cold start)

Day la infrastructure CRITICAL. Neu no break:
  -> Khach hang thay stale content (gia cu, mo ta cu, het hang nhung van show)
  -> Neu gia sai: ton that tai chinh, customer complaint, trust erosion
  -> Neu "out of stock" nhung van show: order failed, trai nghiem te
  -> Stale content ton tai CHO DEN KHI TTL HET HAN
     TTL co the la 5 phut, 1 gio, hoac 24 gio tuy cache policy
     Trong khoang thoi gian do, MOI user deu thay data sai
```

### Event-driven invalidation khong phai la "nice to have"

```text
Day la infrastructure requirement cho bat ky e-commerce platform nao
co CDN layer:

  - Content freshness la contract voi nguoi dung
  - Gia sai = mat tien that (refund, chargeback, regulatory fine)
  - Ton kho sai = order khong fulfill duoc = operational cost
  - Stale content = SEO penalty (Google phat content khong consistent)

Trong kien truc event-driven:
  [CMS/Admin] -> [DB] -> [Event Bus] -> [CDN Invalidation Service] -> [Varnish]
                                         ^
                                         |
  [Inventory System] -------------------+
  [Pricing Engine] ---------------------+
  [Category Manager] -------------------+
  [Curation Tool] ----------------------+

  Moi thay doi tu bat ky source nao cung di qua cung mot pipeline.
  Khong can human intervention.
  Cache freshness duoc DAM BAO BOI HE THONG, khong phai boi con nguoi.
```

---

## 2. CDN capability being proved

### Khong chi la "event endpoint tra 200"

```text
Test event-driven invalidation co 3 level:

  Level 1: EVENT DELIVERY
    "Goi POST /internal/cdn/events/catalog -> tra 200"
    -> Day la test API endpoint, KHONG PHAI test CDN capability.

  Level 2: HANDLER EXECUTION
    "Event duoc handler parse, plan duoc build, Varnish operations
     duoc goi, tat ca tra success"
    -> Day tot hon, nhung van la test OPS SIDE.
    -> Handler goi purge/ban OK nhung Varnish co that su xoa object khong?

  Level 3: END-TO-END CACHE STATE VERIFICATION  <-- CASE 06
    "Warm object -> emit event -> public request -> MISS"
    -> Day la PROOF that su: cache object da bi xoa khoi Varnish.
    -> Khong phai "handler bao thanh cong", ma la "CDN thuc su thay doi".
    -> Day la LEVEL DUY NHAT co y nghia voi business.

Case 06 proves LEVEL 3:
  - Warm truoc -> xac nhan object dang duoc cache (HIT)
  - Emit event -> goi internal endpoint
  - Verify sau event -> xac nhan object da bi xoa (MISS)
  - Check ca affected paths LAN unaffected paths (targeted invalidation)
```

### Capability contract

```text
CONTRACT: Khi mot catalog event duoc gui den internal event endpoint,
         CDN PHAl invalidate cac cache objects lien quan trong
         khoang thoi gian du nho (gan nhu ngay lap tuc).

INPUT:  Event type + entity_id duoc POST den /internal/cdn/events/catalog
        (port :9091 trong test topology)

OUTPUT: Cache state cua affected paths chuyen tu HIT -> MISS
        Cache state cua unaffected paths VAN LA HIT (targeted!)

SIGNAL: X-Cache header tren public request (:80)

PROOF CHAIN:
  1. Warm objects -> X-Cache: HIT (xac nhan da cache)
  2. POST event -> HTTP 200 (event accepted)
  3. Request affected paths -> X-Cache: MISS (invalidated)
  4. Request unaffected paths -> X-Cache: HIT (targeted, no cache wipe)

PHAI co ca 4 buoc. Thieu bat ky buoc nao -> khong the ket luan.
```

### Ba event type duoc test

| Event Type | Y nghia | Affected paths (theo handler) |
| --- | --- | --- |
| `product.updated` | Mot san pham thay doi (gia, mo ta, ton kho, hinh anh) | Detail page, recommendations, search results, products list, homefeed |
| `category.updated` | Category taxonomy thay doi (san pham chuyen category, category rename) | Categories list, products list, homefeed, search results |
| `homefeed.updated` | Homefeed curation thay doi (featured products, banners, layout) | Homefeed (theo segment) |

Moi event type map den mot tap hop cache objects KHAC NHAU. Handler phai:
- Xac dinh dung affected paths
- Invalidate dung objects (khong thua, khong thieu)
- Optionally warm lai high-traffic paths

---

## 3. Vi sao test o CDN layer

### Event -> Invalidation chain la INTEGRATION, khong phai unit

```text
Day la chain 5-thanh-phan:

  [k6 script]  --POST event-->  [Catalog Events Mock :9091]
                                      |
                                      v
                            [Internal Event Endpoint]
                            Go handler: InternalCatalogCacheEvent()
                                      |
                                      v
                            [CDN Control Operations]
                            purge/ban-url/ban-prefix/ban-tag
                                      |
                                      v
                            [Varnish Cache (:80)]
                            Object thuc su bi xoa?

Moi thanh phan co the fail DOC LAP:

  1. k6 script: sai payload format -> event khong duoc parse
  2. Catalog Events Mock: service down, sai routing -> event khong den handler
  3. Internal handler: sai authorization, sai plan build -> khong goi Varnish ops
  4. CDN Control: purge/ban tra 200 nhung Varnish khong thay doi -> false positive
  5. Varnish: object da expire truoc khi ban co hieu luc -> HIT van HIT

Unit test CHO TUNG THANH PHAN la can nhung KHONG DU:
  - Test event endpoint: POST -> 200. Pass? Nhung handler co goi duoc Varnish?
  - Test Varnish control API: purge -> 200. Pass? Nhung co dung URL khong?
  - Test handler buildPlan: plan co dung shape? Nhung co execute khong?

CHI integration test (case 06) moi tra loi duoc cau hoi that su:
  "Tu event den cache state, toan bo chain co hoat dong khong?"
```

### Tai sao khong test o Application layer?

```text
Neu test o application layer (goi truc tiep handler, mock Varnish):

  -> Ban test "handler goi purge/ban API". Nhung:
     - Varnish API co that su xoa object khong?
     - Purge/ban co anh huong den dung cache key variant khong?
     - Warm-after-invalidate co tao MISS -> HIT sequence dung khong?
     - Targeted invalidation co that su targeted (khong xoa nham) khong?

  -> Tat ca cau hoi nay CHI tra loi duoc bang cach:
     Goi public CDN path VA doc X-Cache header.

  -> Application-layer test la GIA LAP. CDN-layer test la THUC TE.

Neu test o Infrastructure layer (chi test Varnish):

  -> Ban test "purge URL X -> next request MISS". Nhung:
     - Event co den duoc handler khong? (integration voi event system)
     - Handler co parse dung event type khong? (logic)
     - Handler co build dung plan cho event voi cac entity_id khac nhau?
     - Authorization co hoat dong? (internal token)

  -> Infrastructure test la QUA HEP. CDN-layer test la DAY DU.

CDN layer test = APPLICATION + INFRASTRUCTURE + INTEGRATION
  -> La diem GOLDILOCKS: khong qua cao (gia lap), khong qua thap (don le)
  -> La diem DUY NHAT chung minh duoc event->cache chain hoat dong
```

### So sanh voi manual invalidation (case 05)

```text
Case 05 (manual invalidation):
  - k6 goi TRUC TIEP /ops/app/cdn/cache/purge hoac ban-url hoac ban-tag
  - k6 KIEM SOAT toan bo: chon URL, goi API, verify
  - Cau hoi: "Purge/ban/tag API co hoat dong khong?"
  - Day la test CDN CONTROL PLANE

Case 06 (event-driven invalidation):
  - k6 goi catalog events mock -> handler QUYET DINH goi purge/ban gi
  - k6 KHONG KIEM SOAT chi tiet invalidation plan
  - Cau hoi: "Tu event -> handler -> Varnish, toan bo chain co hoat dong khong?"
  - Day la test CDN EVENT INTEGRATION

Ca hai deu can:
  - Case 05 chung minh control plane hoat dong (neu handler goi ma purge fail)
  - Case 06 chung minh event pipeline hoat dong (neu handler khong goi purge)
  - Ca hai CUNG PASS -> event-driven invalidation la reliable

Neu chi co case 05 pass, case 06 fail:
  -> Varnish purge hoat dong nhung handler KHONG goi no
  -> Event duoc nhan nhung handler LOGIC sai (parse event type, build plan)
  -> Event duoc nhan nhung AUTHORIZATION sai (internal token)

Neu chi co case 06 pass, case 05 fail:
  -> Handler goi purge/ban nhung Varnish control API khong hoat dong doc lap
  -> Bat kha thi (vi handler cung goi cung API) nhung co the xay ra
     neu handler co retry/fallback ma test case 05 khong co
```

---

## 4. Topology & precondition

### Runtime topology

```text
                    CATALOG EVENTS MOCK (:9091)
                    POST /events/product-updated
                    POST /events/category-updated
                    POST /events/homefeed-updated
                           |
                           | (internal network)
                           v
              +--------------------------+
              |    APPLICATION (:8088)   |
              |  InternalCatalogCacheEvent|
              |  - authorize event       |
              |  - parse event payload   |
              |  - build invalidation    |
              |    plan                  |
              |  - execute purge/ban/    |
              |    warm on Varnish       |
              +--------------------------+
                           |
                           | (Varnish control API)
                           v
              +--------------------------+
              |     VARNISH CDN (:80)    |
              |  - cache objects         |
              |  - X-Cache header        |
              |  - X-Cache-Key-* headers |
              +--------------------------+
                           ^
                           |
                     k6 SCRIPT
              (verify X-Cache state)
```

### Ba path trong topology

```text
PATH A: PUBLIC CDN PATH (port :80)
  http://localhost:80/api/sim/products/1
  http://localhost:80/api/sim/products/1/recommendations
  http://localhost:80/api/sim/products/search?q=shoe
  http://localhost:80/api/sim/products/homefeed

  -> Dung de VERIFY cache state (HIT/MISS)
  -> Day la path khach hang that su di qua
  -> X-Cache header la signal CHINH

PATH B: EVENT PATH (port :9091)
  http://localhost:9091/events/product-updated
  http://localhost:9091/events/category-updated
  http://localhost:9091/events/homefeed-updated

  -> Dung de EMIT catalog events
  -> La mock cua event bus/system that trong production
  -> Payload chua entity_id + metadata de handler build plan

PATH C: CONTROL PATH (port :8088)
  http://localhost:8088/ops/app/cdn/cache/ban-url
  http://localhost:8088/ops/app/cdn/cache/ban

  -> Dung trong setup() de CLEAR cache truoc khi test
  -> Dam bao baseline "clean cache" truoc moi case run
  -> Cung la path handler SU DUNG de thuc thi invalidation
```

### Precondition: clean cache state

```text
TRUOC KHI BAT DAU TEST, tat ca affected paths PHAI o trang thai
"cold" (khong co object trong cache). Neu co object cu ton tai:

  -> warm -> HIT (object cu, co the tu lan run truoc)
  -> emit event -> handler ban URL X
  -> nhung Varnish van serve object CU cho URL X (vi object moi
     duoc cache tu lan warm ban dau la khac key voi URL X?)
  -> AssertCacheState MISS FAIL vi object van HIT

Hoac:

  -> warm -> HIT (object cu)
  -> event -> MISS (object cu bi ban that)
  -> verify -> MISS (dung!)
  -> NHUNG: warm lan thu 2 cho homefeed event -> HIT (object moi)
  -> event 2 -> MISS (object moi bi ban)
  -> verify 2 -> MISS (dung!)
  -> Trong truong hop nay test pass nhung setup KHONG SACH
  -> Khong the chac chan HIT ban dau la do warm hay do object cu

DE tranh ambiguity: setup() PHAI clear ALL affected paths:

  setup() {
    banUrl(paths.productDetail);       // Xoa exact URL
    banUrl(paths.recommendations);     // Xoa exact URL
    banUrl(paths.homefeed);            // Xoa exact URL
    banPrefix(paths.searchPrefix);     // Xoa toan bo search prefix
  }

  Sau setup() -> tat ca affected paths la MISS (cold)
  -> Warm -> HIT (duoc tao moi trong test nay)
  -> Event -> MISS (chinh object vua warm bi xoa)
  -> Khong ambiguity, day la PROOF RONG RANG
```

### Required env variables

```text
Bat buoc:
  BASE_URL                  = http://localhost:80
  CONTROL_BASE_URL          = http://localhost:8088
  CATALOG_EVENTS_BASE_URL   = http://localhost:9091
  OPS_AUTH_TOKEN            = <ops-token>

Optional (khong anh huong den case nay):
  TTL_WAIT_SECONDS          (khong su dung vi khong test TTL)
  ORIGIN_HEALTH_WAIT_*      (khong su dung vi khong test origin health)
```

---

## 5. Script deep-dive

### File location & structure

```text
Script: E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/06-invalidation-events.js
Lines:  104
Export: options, setup, default (3 functions, khong co teardown)

Dependencies (tu shared.js):
  - decodeJSON, paths, profiles
  - banPrefix, banUrl
  - requestCdn, triggerCatalogEvent
  - assertCacheState, assertStatus, assertUpstream
```

### Options

```javascript
export const options = {
  vus: 1,           // Chi can 1 VU (chay tuan tu, khong can concurrency)
  iterations: 1,    // Chay dung 1 lan (event->verify la atomic)
  thresholds: {
    checks: ['rate==1'],  // TAT CA checks phai pass
  },
  tags: {
    scenario: 'cdn_invalidation_events',
  },
};
```

Diem quan trong: `vus: 1, iterations: 1`. Khong phai load test. Day la
**functional correctness test**. Mot VU chay tuan tu qua tat ca buoc:
warm -> event -> verify -> warm -> event -> verify. Khong can nhieu VU
vi khong test concurrency hay throughput. Neu checks rate < 1, co nghia
la CO IT NHAT MOT BUOC BI FAIL. Threshold nay dam bao KHONG FALSE PASS.

### Helper: warmUntilHit()

```javascript
function warmUntilHit(path, profile, label) {
  const first = requestCdn('GET', path, {
    profile,
    tags: { case: `${label}_warm_first` },
  });
  assertStatus(first, 200, `${label} warm first`);
  assertUpstream(first, 'products-service', `${label} warm first`);
  assertCacheState(first, 'MISS', `${label} warm first`);

  const second = requestCdn('GET', path, {
    profile,
    tags: { case: `${label}_warm_second` },
  });
  assertStatus(second, 200, `${label} warm second`);
  assertCacheState(second, 'HIT', `${label} warm second`);
}
```

Logic cua warmUntilHit:

```text
  Request 1: GET path voi profile -> phai MISS (cold)
             -> Status 200, upstream products-service, X-Cache: MISS
             -> Request nay FETCH tu origin VA populate cache
  Request 2: GET path voi profile -> phai HIT (warm)
             -> Status 200, X-Cache: HIT
             -> Khong kiem tra upstream vi khong can (da cache)

  Neu request 1 la HIT -> cache da co san object -> AMBIGUITY
  Neu request 2 la MISS -> cache KHONG populate -> CHAIN BREAK

  Ham nay DAM BAO:
    1. Object duoc cache LAN DAU trong test nay
    2. Sau khi cache, object that su duoc serve tu cache
    3. Co the su dung de "warm truoc event" mot cach deterministic
```

### setup(): clear cache

```javascript
export function setup() {
  banUrl(paths.productDetail);       // /api/sim/products/1
  banUrl(paths.recommendations);     // /api/sim/products/1/recommendations
  banUrl(paths.homefeed);            // /api/sim/products/homefeed
  banPrefix(paths.searchPrefix);     // /api/sim/products/search (moi query)
}
```

Tai sao lai dung banUrl + banPrefix thay vi purge?

```text
  - purge = xoa EXACT object (URL + headers phai match chinh xac)
  - banUrl = xoa object theo URL (khong can headers match)
  - banPrefix = xoa TAT CA object co URL bat dau bang prefix

  Trong setup, chung ta MUON xoa toan bo:
    -> Khong biet truoc cache key headers cua object cu la gi
    -> Khong muon phai lap qua tat ca variant (language x geo x device x AB x segment)
    -> banUrl + banPrefix dam bao xoa SACH khong can biet variant

  Sau setup:
    -> /api/sim/products/1 (moi variant) -> MISS
    -> /api/sim/products/1/recommendations (moi variant) -> MISS
    -> /api/sim/products/homefeed (moi variant) -> MISS
    -> /api/sim/products/search?q=anything -> MISS

  Day la "clean slate" cho test.
```

### default(): PRODUCT.UPDATED event flow

```javascript
export default function () {
  const guest = profiles.guestVNMobileControl;
  const returning = profiles.returningVNMobileVariantA;
```

Hai profile duoc su dung:

```text
  guest:     guest_vn_mobile_control
             (language=vi, geo=VN, device=mobile, AB=control, segment=guest)
  returning: returning_vn_mobile_variant_a
             (language=vi, geo=VN, device=mobile, AB=variant-a, segment=returning)
```

#### Buoc 1: Warm tat ca affected paths

```javascript
  warmUntilHit(paths.productDetail, guest, 'detail_before_event');
  warmUntilHit(paths.recommendations, guest, 'recs_before_event');
  warmUntilHit(paths.search, guest, 'search_before_event');
  warmUntilHit(paths.homefeed, returning, 'homefeed_before_product_event');
```

```text
  Sau buoc nay:
    - /api/sim/products/1 [guest VN mobile control] -> HIT
    - /api/sim/products/1/recommendations [guest VN mobile control] -> HIT
    - /api/sim/products/search?q=shoe [guest VN mobile control] -> HIT
    - /api/sim/products/homefeed [returning VN mobile variant-a] -> HIT

  Day la BASELINE. Moi path DA DUOC CACHE.
  Neu sau event, cac path nay thanh MISS -> invalidation THUC SU HOAT DONG.
  Neu sau event, cac path nay VAN HIT -> invalidation KHONG HOAT DONG.
```

#### Buoc 2: Emit product.updated event

```javascript
  const productEvent = triggerCatalogEvent('/events/product-updated', {
    product_id: '1',
    warm: false,
  });
  assertStatus(productEvent, 200, 'product event');
  const productEventBody = decodeJSON(productEvent, 'product event');
  if (!productEventBody.success) {
    throw new Error('product-updated event did not succeed');
  }
```

```text
  triggerCatalogEvent():
    -> POST http://localhost:9091/events/product-updated
    -> Payload: { product_id: "1", warm: false }
    -> Headers: Accept: application/json, Content-Type: application/json
    -> Returns: HTTP response

  Tai sao warm: false?
    -> Trong test nay, chung ta MUON verify MISS (khong can warm lai)
    -> Neu warm: true, handler se warm lai sau khi ban
       -> Request verify co the la HIT (warm moi) thay vi MISS (ban dau)
       -> Khong the phan biet: MISS do ban HAY MISS do warm chua xong?
    -> warm: false dam bao: sau event, request tiep theo PHAI MISS
    -> Trong production, warm nen la true de tranh cold start

  assertStatus + decodeJSON + check success:
    -> Event endpoint tra 200 + body.success = true
    -> Neu khong -> event KHONG DUOC CHAP NHAN -> khong the tiep tuc
```

#### Buoc 3: Verify affected paths = MISS

```javascript
  const detailAfterEvent = requestCdn('GET', paths.productDetail, {
    profile: guest,
    tags: { case: 'detail_after_product_event' },
  });
  assertStatus(detailAfterEvent, 200, 'detail after product event');
  assertCacheState(detailAfterEvent, 'MISS', 'detail after product event');

  const recsAfterEvent = requestCdn('GET', paths.recommendations, {
    profile: guest,
    tags: { case: 'recs_after_product_event' },
  });
  assertStatus(recsAfterEvent, 200, 'recs after product event');
  assertCacheState(recsAfterEvent, 'MISS', 'recs after product event');

  const searchAfterEvent = requestCdn('GET', paths.search, {
    profile: guest,
    tags: { case: 'search_after_product_event' },
  });
  assertStatus(searchAfterEvent, 200, 'search after product event');
  assertCacheState(searchAfterEvent, 'MISS', 'search after product event');
```

```text
  3 path duoc verify SAU product.updated event:
    1. Product detail (/api/sim/products/1) -> PHAI MISS
       -> Day la path TRUC TIEP cua san pham bi update
       -> Neu HIT -> handler khong ban URL nay -> LOGIC GAP

    2. Recommendations (/api/sim/products/1/recommendations) -> PHAI MISS
       -> Day la path LIEN QUAN (recommendations cua san pham bi update)
       -> Neu HIT -> handler khong ban recommendations -> PLAN THIEU

    3. Search (/api/sim/products/search?q=shoe) -> PHAI MISS
       -> Search prefix bi ban -> tat ca search queries deu MISS
       -> Neu HIT -> handler khong ban search prefix -> PLAN THIEU

  Tat ca deu dung cung profile guest (VN mobile control)
  -> Dam bao la cung variant da duoc warm truoc do
```

### default(): HOMEFEED.UPDATED event flow

#### Buoc 4: Warm homefeed cho ca hai segment

```javascript
  warmUntilHit(paths.homefeed, profiles.guestVNMobileVariantA,
    'homefeed_guest_before_homefeed_event');
  warmUntilHit(paths.homefeed, returning,
    'homefeed_returning_before_homefeed_event');
```

```text
  Truoc homefeed event, warm HAI variant cua homefeed:
    - guest VN mobile variant-a -> HIT
    - returning VN mobile variant-a -> HIT

  Mac du homefeed.updated chi dinh segment=returning,
  handler van ban URL /api/sim/products/homefeed (khong phan biet segment).
  -> Ca HAI variant deu se MISS sau event.
  -> Neu chi variant returning MISS ma guest van HIT -> handler
     dang ban THEO SEGMENT (khong dung voi implementation hien tai).
```

#### Buoc 5: Emit homefeed.updated event

```javascript
  const homefeedEvent = triggerCatalogEvent('/events/homefeed-updated', {
    segment: 'returning',
    warm: false,
  });
  assertStatus(homefeedEvent, 200, 'homefeed event');
  const homefeedEventBody = decodeJSON(homefeedEvent, 'homefeed event');
  if (!homefeedEventBody.success) {
    throw new Error('homefeed-updated event did not succeed');
  }
```

```text
  Khac voi product.updated:
    - Payload co segment thay vi product_id
    - segment='returning' -> handler biet segment nao duoc update
    - warm: false (cung ly do nhu tren)
```

#### Buoc 6: Verify both homefeed variants = MISS

```javascript
  const guestAfterHomefeedEvent = requestCdn('GET', paths.homefeed, {
    profile: profiles.guestVNMobileVariantA,
    tags: { case: 'homefeed_guest_after_event' },
  });
  assertStatus(guestAfterHomefeedEvent, 200, 'guest homefeed after event');
  assertCacheState(guestAfterHomefeedEvent, 'MISS', 'guest homefeed after event');

  const returningAfterHomefeedEvent = requestCdn('GET', paths.homefeed, {
    profile: returning,
    tags: { case: 'homefeed_returning_after_event' },
  });
  assertStatus(returningAfterHomefeedEvent, 200, 'returning homefeed after event');
  assertCacheState(returningAfterHomefeedEvent, 'MISS', 'returning homefeed after event');
```

```text
  Ca HAI variant (guest + returning) deu PHAI MISS.
  -> Xac nhan homefeed bi ban COMPLETELY (khong phan biet segment)
  -> Phu hop voi implementation: handler ban URL /api/sim/products/homefeed
     ma khong quan tam den segment
```

### Luu y: category.updated KHONG duoc test trong script

```text
  Mac du handler ho tro category.updated, script 06 chi test
  product.updated va homefeed.updated. Day la test CO BAN,
  coverage 2/3 event type. category.updated de duoc test
  trong variation (xem section 15).

  Ly do: category.updated va product.updated co cung co che
  (ban URL + ban prefix). Test product.updated da chung minh
  co che hoat dong. category.updated la "same mechanism,
  different affected paths".
```

---

## 6. Event -> Invalidation chain deep-dive

### Day la section QUAN TRONG NHAT cua tai lieu nay

```text
Toan bo gia tri cua event-driven invalidation nam o CHAIN nay:

  EVENT -> HANDLER -> PLAN -> EXECUTION -> CACHE STATE CHANGE

Moi mat xich trong chain PHAI hoat dong. Mot mat xich gay
-> toan bo chain that bai -> user thay stale content.

Hay trace tung buoc voi event product.updated (product_id='1').
```

### Buoc 1: k6 script emit event

```text
  Code: triggerCatalogEvent('/events/product-updated', {
          product_id: '1',
          warm: false,
        })

  HTTP request:
    POST http://localhost:9091/events/product-updated
    Headers:
      Accept: application/json
      Content-Type: application/json
    Body:
      {
        "product_id": "1",
        "warm": false
      }

  Catalog Events Mock (:9091) nhan request nay.
  Mock forward den internal event endpoint tren :8088.

  Day la mock cho EVENT BUS trong production.
  Trong production, event duoc publish vao Kafka/NATS/PubSub
  va CDN Invalidation Service subscribe de nhan.
```

### Buoc 2: Internal handler nhan request

```text
  Handler: InternalCatalogCacheEvent() (internal_catalog_events.go)

  Route: POST /internal/cdn/events/catalog (trong production)
  Mock:  POST /events/product-updated -> forward -> /internal/cdn/events/catalog

  Buoc 2a: AUTHORIZATION
    - Kiem tra X-Internal-Token header
    - Hoac Authorization: Bearer <token>
    - Token phai match internalEventToken (config APP_INTERNAL_TOKEN)
    - Neu khong match -> 401 Unauthorized
    - Neu token khong duoc config -> 503 Service Unavailable

    Day la LAYER BAO MAT: chi internal services moi co the goi endpoint nay.
    Khong ai tu ben ngoai co the purge CDN cache bang cach goi event endpoint.

  Buoc 2b: PARSE PAYLOAD
    - Bind JSON vao catalogCacheEventRequest struct:
      type catalogCacheEventRequest struct {
        EventType  string `json:"event_type"`
        ProductID  string `json:"product_id,omitempty"`
        CategoryID string `json:"category_id,omitempty"`
        Segment    string `json:"segment,omitempty"`
        Warm       bool   `json:"warm"`
      }
    - Neu JSON invalid -> 400 Bad Request
    - Luu y: event_type duoc normalize (xem buoc 3)
```

### Buoc 3: Build invalidation plan

```text
  buildCatalogCacheEventPlan(req catalogCacheEventRequest) -> catalogCacheEventPlan

  Buoc 3a: NORMALIZE EVENT TYPE
    normalizeCatalogEventType("product-updated") hoac "product_updated"
      -> toLower, trimSpace, replace _ thanh .
      -> "product-updated" -> "product.updated"
      -> "product_updated" -> "product.updated"

    Switch tren normalized event type.

  Buoc 3b: BUILD PLAN cho "product.updated"

    Neu product_id empty -> error "product_id is required"

    plan := catalogCacheEventPlan{
      EventType: "product.updated",
      BanURLs: []string{
        "/api/sim/products/1",                    // product detail
        "/api/sim/products/1/recommendations",     // recommendations
        "/api/sim/products",                       // products list
        "/api/sim/products/homefeed",              // homefeed
      },
      BanPrefixes: []string{
        "/api/sim/products/search",                // all search queries
      },
    }

    Neu req.Warm == true:
      plan.WarmRequests = []cdnWarmItem{
        {
          URL: "/api/sim/products/1",
          Headers: {"Accept-Language": "vi", "X-Geo-Country": "VN",
                     "X-Device-Class": "mobile", "X-Ab-Variant": "control"},
        },
        {
          URL: "/api/sim/products/1/recommendations",
          Headers: {"Accept-Language": "en", "X-Geo-Country": "US",
                     "X-Device-Class": "desktop", "X-Ab-Variant": "variant-b"},
        },
        {
          URL: "/api/sim/products/homefeed",
          Headers: {"Accept-Language": "vi", "X-Geo-Country": "VN",
                     "X-Device-Class": "mobile", "X-Ab-Variant": "variant-a",
                     "X-User-Segment": "returning"},
        },
      }

  Phan tich plan:

    BanURLs: 4 URL bi ban CHINH XAC.
      - /api/sim/products/1: trang chi tiet san pham
      - /api/sim/products/1/recommendations: recommendations cua san pham
      - /api/sim/products: danh sach san pham (co the chua san pham nay)
      - /api/sim/products/homefeed: homefeed (co the chua san pham nay)

      TAI SAO ban ca products va homefeed?
        -> San pham thay doi -> neu no nam trong products list hoac homefeed
           -> noi dung list/homefeed thay doi (gia, anh, mo ta)
        -> Khong the biet truoc san pham co trong list/homefeed hay khong
        -> An toan: ban luon. Neu san pham khong co trong list/homefeed
           -> ban van OK (chi ton them mot MISS, khong gay sai data)

    BanPrefixes: 1 prefix duoc ban.
      - /api/sim/products/search: tat ca search queries
        -> Bat ky search nao co the tra ve san pham nay
        -> Khong the biet truoc query string la gi
        -> An toan: ban toan bo search prefix

    WarmRequests (neu warm=true): 3 warm requests.
      - Warm cho CAC VARIANT KHAC NHAU:
        - Product detail: VN mobile control
        - Recommendations: US desktop variant-b
        - Homefeed: VN mobile variant-a returning
      - Tai sao warm nhieu variant?
        -> Tranh cold start: khi user that request, cache da san sang
        -> Warm nhieu variant quan trong: VN mobile la da so traffic
           nhung US desktop cung co -> tranh cold start cho ca hai
      - Tai sao khong warm search?
        -> Search co qua nhieu query string khac nhau
        -> Khong the warm tat ca
        -> Chap nhan search se cold start sau event
```

### Buoc 4: Execute CDN operations

```text
  Handler goi 3 nhom operation LEN VARNISH:

  Buoc 4a: EXECUTE PURGES
    h.executeCDNPurges(ctx, plan.PurgeURLs)
    -> plan.PurgeURLs empty vi product.updated khong dung purge
    -> product.updated DUNG BAN (khong purge)
    -> 0 purges executed, 0 failures

  Buoc 4b: EXECUTE URL BANS
    h.executeCDNURLBans(ctx, plan.BanURLs)
    -> Ban 4 URL:
        /api/sim/products/1
        /api/sim/products/1/recommendations
        /api/sim/products
        /api/sim/products/homefeed
    -> Moi URL: goi Varnish ban API
    -> Neu Varnish tra OK -> URL bi xoa khoi cache
    -> Neu Varnish tra error -> failure count++

  Buoc 4c: EXECUTE PREFIX BANS
    h.executeCDNBans(ctx, plan.BanPrefixes)
    -> Ban prefix: /api/sim/products/search
    -> Varnish xoa TAT CA object co URL bat dau bang prefix nay
    -> Bao gom: /api/sim/products/search?q=shoe,
                /api/sim/products/search?q=giay,
                /api/sim/products/search?category=running
    -> 1 ban prefix executed

  Buoc 4d: EXECUTE WARM (neu co)
    h.executeCDNWarm(ctx, plan.WarmRequests)
    -> Neu warm=false (nhu script hien tai): bo qua
    -> Neu warm=true: goi 3 HTTP GET requests den public CDN path
       voi cac headers tuong ung
    -> Moi request: MISS -> HIT (warm cache)
```

### Buoc 5: Response to event caller

```text
  Handler tra JSON response:

  Neu 0 failures -> HTTP 200:
    {
      "success": true,
      "data": {
        "event_type": "product.updated",
        "purges":  { "total": 0, "failures": 0, "results": [] },
        "bans":    { "total": 5, "failures": 0, "results": [...] },
        "warm":    { "total": 0, "failures": 0, "results": [] }
      }
    }

  Neu >0 failures -> HTTP 207 Multi-Status:
    {
      "success": false,
      "data": {
        "event_type": "product.updated",
        "purges":  { "total": 0, "failures": 0, "results": [] },
        "bans":    { "total": 5, "failures": 2, "results": [...] },
        "warm":    { "total": 0, "failures": 0, "results": [] }
      }
    }

  IMPORTANT: success=false trong response KHONG CO NGHIA la
  "toan bo cache van con". No chi co nghia la "MOT SO Varnish
  operations failed". Cache CO THE da duoc clear mot phan.
  -> k6 script check response.success va throw error neu false.
  -> Day la conservative approach: FAIL neu bat ky operation nao fail.
```

### Buoc 6: Cache state change (what this test proves)

```text
  SAU KHI handler thuc thi xong:

  Varnish cache state cho affected paths:

    /api/sim/products/1 [guest VN mobile control]:
      Truoc event: HIT (da warm)
      Sau event:   MISS (bi ban URL)
      -> Object da bi xoa khoi cache
      -> Request tiep theo: MISS -> fetch tu origin -> populate cache

    /api/sim/products/1/recommendations [guest VN mobile control]:
      Truoc event: HIT
      Sau event:   MISS (bi ban URL)
      -> Object da bi xoa

    /api/sim/products/search?q=shoe [guest VN mobile control]:
      Truoc event: HIT
      Sau event:   MISS (bi ban prefix /api/sim/products/search)
      -> Object da bi xoa vi URL bat dau bang prefix bi ban

    /api/sim/products/homefeed [returning VN mobile variant-a]:
      Truoc event: HIT
      Sau event:   MISS (bi ban URL)
      -> Object da bi xoa

  PROOF COMPLETE:
    - 4/4 affected paths chuyen tu HIT -> MISS
    - Event -> Handler -> Plan -> Varnish -> Cache State Change hoan chinh
    - Targeted: nhung path khong lien quan (neu co) van HIT
```

### So sanh plan cho 3 event type

```text
  PRODUCT.UPDATED (product_id='1'):
    BanURLs:     [detail, recommendations, products, homefeed]
    BanPrefixes: [search]
    PurgeURLs:   []
    Warm:        [detail (VN mobile), recommendations (US desktop),
                  homefeed (VN mobile returning)]

  CATEGORY.UPDATED:
    BanURLs:     [categories, products, homefeed]
    BanPrefixes: [search]
    PurgeURLs:   []
    Warm:        [categories (US desktop), products (VN mobile)]

  HOMEFEED.UPDATED (segment='returning'):
    BanURLs:     [homefeed]
    BanPrefixes: []
    PurgeURLs:   []
    Warm:        [homefeed (segment=returning, VN mobile variant-a),
                  homefeed (segment=guest, US desktop control)]

  Pattern chung:
    - Dung BAN (khong purge) vi ban hoat dong duoi object-level
      va khong can biet variant
    - Dung BanPrefix cho search vi khong the biet truoc query string
    - Warm cho 1-3 variant quan trong (khong warm tat ca)
    - Moi event type co tap affected paths RIENG
```

---

## 7. Event payload model

### catalogCacheEventRequest (Go struct)

```go
type catalogCacheEventRequest struct {
    EventType  string `json:"event_type"`
    ProductID  string `json:"product_id,omitempty"`
    CategoryID string `json:"category_id,omitempty"`
    Segment    string `json:"segment,omitempty"`
    Warm       bool   `json:"warm"`
}
```

### Truong duoc su dung theo event type

```text
  PRODUCT.UPDATED:
    event_type: "product.updated" (BAT BUOC)
    product_id: "1"               (BAT BUOC - handler se tu choi neu empty)
    warm:       true/false        (OPTIONAL - default false)
    category_id: (khong su dung)
    segment:     (khong su dung)

  CATEGORY.UPDATED:
    event_type:  "category.updated" (BAT BUOC)
    category_id: "running"          (OPTIONAL - handler KHONG validate)
    warm:        true/false         (OPTIONAL - default false)
    product_id:  (khong su dung)
    segment:     (khong su dung)

  HOMEFEED.UPDATED:
    event_type: "homefeed.updated" (BAT BUOC)
    segment:    "returning"        (OPTIONAL - default "guest" neu khong co)
    warm:       true/false         (OPTIONAL - default false)
    product_id:  (khong su dung)
    category_id: (khong su dung)
```

### event_type normalization

```text
  Handler normalize event_type de chap nhan nhieu format:

  Input                  -> Normalized
  "product.updated"      -> "product.updated"
  "product-updated"      -> "product.updated"   (thay _ thanh .)
  "PRODUCT_UPDATED"      -> "product.updated"   (toLower)
  "  product.updated  "  -> "product.updated"   (trimSpace)
  "product-updated"      -> "product.updated"   (_ -> .)

  Day la DEFENSIVE: event co the den tu nhieu source khac nhau
  (Python dung _, JavaScript dung ., Java dung UPPER_CASE).
  Normalize dam bao handler KHONG tu choi event chi vi format khac.

  Neu event_type khong match bat ky loai nao -> 400 "unsupported event_type"
```

### segment normalization

```text
  normalizeCatalogEventSegment(): default "guest"
  Accepted: "new_user", "returning", "vip"
  Khac:     -> "guest" (fallback an toan)

  Trong homefeed.updated, segment duoc su dung trong warm requests:
    - Warm cho segment duoc chi dinh (vd: returning)
    - Warm them cho segment guest (luon luon)

  Ly do: homefeed co the thay doi cho MOT segment nhung
  handler ban TOAN BO homefeed URL -> tat ca segment deu MISS.
  Warm cho it nhat 2 segment de giam cold start.
```

### Vi du payload tuong ung voi script

```json
// product.updated event (tu script)
POST /events/product-updated
{
  "product_id": "1",
  "warm": false
}
// Luu y: script KHONG gui event_type vi mock tu dong them
// (dua vao URL path)

// homefeed.updated event (tu script)
POST /events/homefeed-updated
{
  "segment": "returning",
  "warm": false
}
```

---

## 8. Request sequence flow

### Full timeline (theo script execution order)

```text
TIMELINE: 06-invalidation-events.js (1 VU, 1 iteration)

  [setup phase] -------------------------------------------------
  t=0:  banUrl(/api/sim/products/1)              -> control :8088
  t=1:  banUrl(/api/sim/products/1/recommendations) -> control :8088
  t=2:  banUrl(/api/sim/products/homefeed)       -> control :8088
  t=3:  banPrefix(/api/sim/products/search)      -> control :8088
        -> TAT CA affected paths: MISS (cold)

  [default phase - PHASE 1: product.updated] --------------------
  t=4:  GET /api/sim/products/1 [guest VN mob ctrl]
        <- 200, X-Cache: MISS, X-Upstream-Service: products-service
  t=5:  GET /api/sim/products/1 [guest VN mob ctrl]
        <- 200, X-Cache: HIT
        -> product detail WARMED

  t=6:  GET /api/sim/products/1/recommendations [guest VN mob ctrl]
        <- 200, X-Cache: MISS
  t=7:  GET /api/sim/products/1/recommendations [guest VN mob ctrl]
        <- 200, X-Cache: HIT
        -> recommendations WARMED

  t=8:  GET /api/sim/products/search?q=shoe [guest VN mob ctrl]
        <- 200, X-Cache: MISS
  t=9:  GET /api/sim/products/search?q=shoe [guest VN mob ctrl]
        <- 200, X-Cache: HIT
        -> search WARMED

  t=10: GET /api/sim/products/homefeed [returning VN mob var-a]
        <- 200, X-Cache: MISS
  t=11: GET /api/sim/products/homefeed [returning VN mob var-a]
        <- 200, X-Cache: HIT
        -> homefeed WARMED

        === BASELINE ESTABLISHED: 4 paths HIT ===

  t=12: POST /events/product-updated {product_id:"1", warm:false}
        -> catalog-events mock :9091
        -> forward den internal handler :8088
        -> handler build plan + execute bans
        <- 200, {success: true}
        -> EVENT ACCEPTED + INVALIDATION EXECUTED

  t=13: GET /api/sim/products/1 [guest VN mob ctrl]
        <- 200, X-Cache: MISS
        -> VERIFIED: product detail INVALIDATED

  t=14: GET /api/sim/products/1/recommendations [guest VN mob ctrl]
        <- 200, X-Cache: MISS
        -> VERIFIED: recommendations INVALIDATED

  t=15: GET /api/sim/products/search?q=shoe [guest VN mob ctrl]
        <- 200, X-Cache: MISS
        -> VERIFIED: search INVALIDATED

        === PHASE 1 COMPLETE: product.updated verified ===

  [default phase - PHASE 2: homefeed.updated] -------------------
  t=16: GET /api/sim/products/homefeed [guest VN mob var-a]
        <- 200, X-Cache: MISS
  t=17: GET /api/sim/products/homefeed [guest VN mob var-a]
        <- 200, X-Cache: HIT
        -> guest homefeed WARMED

  t=18: GET /api/sim/products/homefeed [returning VN mob var-a]
        <- 200, X-Cache: MISS
  t=19: GET /api/sim/products/homefeed [returning VN mob var-a]
        <- 200, X-Cache: HIT
        -> returning homefeed WARMED

        === BASELINE RE-ESTABLISHED: homefeed HIT ===

  t=20: POST /events/homefeed-updated {segment:"returning", warm:false}
        -> forward den handler
        <- 200, {success: true}
        -> EVENT ACCEPTED + INVALIDATION EXECUTED

  t=21: GET /api/sim/products/homefeed [guest VN mob var-a]
        <- 200, X-Cache: MISS
        -> VERIFIED: guest homefeed INVALIDATED

  t=22: GET /api/sim/products/homefeed [returning VN mob var-a]
        <- 200, X-Cache: MISS
        -> VERIFIED: returning homefeed INVALIDATED

        === PHASE 2 COMPLETE: homefeed.updated verified ===
        === TEST PASSED ===
```

### Sequence characteristics

```text
  - TAT CA requests la TUAN TU (sequential)
  - Khong co concurrency (vus=1)
  - Khong co overlap giua cac phase
  - Moi phase: warm -> verify HIT -> emit event -> verify MISS
  - Khong co teardown (khong can reset vi chi chay 1 iteration)
  - Tong: ~23 HTTP requests (ca control + public + event)
```

---

## 9. Key signals

### Signal 1: Event API response

```text
  HTTP Status: 200 = event accepted + all operations succeeded
               207 = event accepted + SOME operations failed
               400 = invalid payload (wrong event_type, missing product_id)
               401 = unauthorized (wrong/missing internal token)
               503 = internal token not configured

  Body: { "success": true/false, "data": { ... } }

  Trong script:
    assertStatus(productEvent, 200, 'product event');
    const body = decodeJSON(productEvent, 'product event');
    if (!body.success) throw new Error('...');

  Neu 200 nhung success=false (207 bi map thanh 200?):
    -> KHONG THE XAY RA vi handler tra 207 khi co failure
    -> assertStatus se FAIL (expected 200, got 207)
    -> Neu handler bi bug tra 200 + success=false:
       decodeJSON + check success se catch
```

### Signal 2: X-Cache header on public path

```text
  Day la SIGNAL CHINH:

  X-Cache: HIT  -> object trong cache, duoc serve tu Varnish
  X-Cache: MISS -> object KHONG trong cache, fetch tu origin

  Chuoi X-Cache cho moi path:

  product.updated event:
    product detail:       MISS -> HIT (warm) -> MISS (post-event)
    recommendations:      MISS -> HIT (warm) -> MISS (post-event)
    search:               MISS -> HIT (warm) -> MISS (post-event)
    homefeed (returning): MISS -> HIT (warm) [baseline]

  homefeed.updated event:
    homefeed (guest):     MISS -> HIT (re-warm) -> MISS (post-event)
    homefeed (returning): MISS -> HIT (re-warm) -> MISS (post-event)
```

### Signal 3: Timing (implicit)

```text
  Khong co sleep hoac wait giua event va verify.
  Event -> verify gan nhu ngay lap tuc.

  Neu Varnish mat thoi gian de execute ban:
    -> Van gan nhu ngay lap tuc (< 1ms cho ban operation)
    -> Neu cham bat thuong -> co the Varnish dang qua tai
       hoac ban queue day

  Khong test timing explicitly, nhung neu verify tra HIT:
    -> Co the Varnish chua kip execute ban
    -> Script KHONG retry -> day la intentional
    -> Muon dam bao ban la SYNCHRONOUS (khong async delay)
```

### Signal 4: X-Upstream-Service (warm first request)

```text
  assertUpstream(first, 'products-service', ...);

  Chi assert tren request DAU TIEN cua warm (MISS).
  Dam bao MISS request that su fetch tu DUNG upstream service.
  Khong assert tren HIT request (vi khong di qua origin).
```

### Signal 5: Status code

```text
  Tat ca public request expect 200.
  Neu event lam sai cache state ma origin van tra 200:
    -> assertStatus pass, assertCacheState fail
  Neu event lam origin tra loi (vd: warm request sai headers):
    -> assertStatus fail truoc khi check cache state
```

---

## 10. Pass/fail criteria

### PASS criteria

```text
  (P1) k6 exit code = 0
       -> Tat ca checks pass, khong co unhandled error.

  (P2) Event endpoints return HTTP 200 + body.success = true
       -> Ca product.updated VA homefeed.updated deu accepted.
       -> Neu event khong accepted -> khong the verify invalidation.

  (P3) SAU product.updated event:
       - Product detail (/api/sim/products/1) -> MISS
       - Recommendations (/api/sim/products/1/recommendations) -> MISS
       - Search (/api/sim/products/search?q=shoe) -> MISS

  (P4) SAU homefeed.updated event:
       - Guest homefeed -> MISS
       - Returning homefeed -> MISS

  (P5) Khong co SIDE EFFECT:
       - Unaffected paths khong bi anh huong (neu co path khac
         trong cung Varnish instance)
       - setup khong lam corrupted state cho case sau

  (P6) Checks rate = 1.0 (threshold)
       -> Neu bat ky assert nao fail -> checks rate < 1.0 -> threshold breach
```

### FAIL criteria

```text
  (F1) EVENT KHONG DUOC CHAP NHAN
       -> POST /events/product-updated tra 400/401/500/503
       -> Handler khong configured (APP_INTERNAL_TOKEN missing)
       -> Token sai
       -> Payload sai format

  (F2) EVENT 200, CACHE VAN HIT ("false positive")
       -> Day la FAIL NGUY HIEM NHAT:
         - Event tra success=true
         - Nhung X-Cache van HIT tren affected paths
       -> Root cause:
         a) Handler build plan SAI (ban sai URL)
         b) Handler goi Varnish API nhung API KHONG thuc su xoa object
         c) Varnish config: ban operation khong match dung cache object
         d) Cache key variant: handler ban URL X nhung object duoc cache
            voi variant headers khac -> ban khong match

  (F3) PARTIAL INVALIDATION
       -> Chi MOT SO affected paths MISS, cac path khac van HIT
       -> Vi du: product detail MISS nhung search van HIT
       -> Handler build plan THIEU paths
       -> Hoac mot so ban operations fail (207 response)

  (F4) OVER-INVALIDATION
       -> Unaffected paths cung MISS (cache bi wipe qua rong)
       -> Handler ban QUA NHIEU paths
       -> Nguyen nhan: banPrefix sai, ban toan bo /api/
       -> Khong duoc test truc tiep trong script nay
          nhung la pattern can canh giac

  (F5) CHECK RATE < 1.0
       -> Mot hoac nhieu assert fail
       -> k6 exit 0 (neu khong co threshold) nhung thuc su FAIL
```

### How to distinguish PASS from FALSE PASS

```text
  FALSE PASS: TAT CA checks pass nhung cache state khong dung

  Lam sao phat hien?

  - Neu warm request 1 la HIT (khong phai MISS):
    -> Cache da co object tu truoc
    -> Event -> verify MISS -> co the PASS
    -> NHUNG: khong biet MISS la do event hay do object chua tung duoc cache
    -> warmUntilHit DAM BAO request 1 phai MISS

  - Neu warm request 2 la MISS (khong phai HIT):
    -> Cache khong populate
    -> warmUntilHit FAIL -> test FAIL truoc khi den event

  - Neu chi co 1 variant duoc test:
    -> Event ban URL X
    -> Verify voi profile A -> MISS -> PASS
    -> Nhung profile B cung dung URL X -> co the van HIT
       (neu ban operation bi variant-scoped)
    -> Script kiem tra IT NHAT 2 variant (guest + returning)
       cho homefeed, giam thieu false pass

  - Neu event tra 200 nhung body.success=false:
    -> script throw error -> test FAIL
    -> Tranh false pass khi handler tra 200 + success=false
```

---

## 11. Cach chay + output

### Prerequisites

```text
  1. TargetLayer=full (Varnish + Nginx + app phai chay day du)
  2. CDN layer da duoc provision (Varnish running, config loaded)
  3. Control path (:8088) available
  4. Catalog events mock (:9091) available
  5. OPS_AUTH_TOKEN configured in app config
  6. APP_INTERNAL_TOKEN configured (hoac fallback OPS/CDN token)
  7. k6 binary installed
```

### PowerShell command

```powershell
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

./scripts/run-cdn-capabilities.ps1 -Scenarios 06-invalidation-events
```

Hoac chay truc tiep bang k6:

```powershell
k6 run `
  -e BASE_URL="http://localhost:80" `
  -e CONTROL_BASE_URL="http://localhost:8088" `
  -e CATALOG_EVENTS_BASE_URL="http://localhost:9091" `
  -e OPS_AUTH_TOKEN="<ops-token>" `
  E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/06-invalidation-events.js
```

### Expected output (happy path)

```text
  /\      |‾‾|  /‾‾/  /‾/
     /\  /  |  |/  /  /  /
  /‾‾/ /   |     /  /‾‾/

  execution: local
     script: 06-invalidation-events.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration

  running (00m02.0s), 0/1 VUs, 1 complete and 0 interrupted iterations

  ✓ detail_before_event_warm_first status 200
  ✓ detail_before_event_warm_first upstream products-service
  ✓ detail_before_event_warm_first cache state MISS
  ✓ detail_before_event_warm_second cache state HIT
  ✓ recs_before_event_warm_first status 200
  ✓ recs_before_event_warm_first cache state MISS
  ✓ recs_before_event_warm_second cache state HIT
  ✓ search_before_event_warm_first cache state MISS
  ✓ search_before_event_warm_second cache state HIT
  ✓ homefeed_before_product_event_warm_first cache state MISS
  ✓ homefeed_before_product_event_warm_second cache state HIT
  ✓ product event status 200
  ✓ detail_after_product_event cache state MISS
  ✓ recs_after_product_event cache state MISS
  ✓ search_after_product_event cache state MISS
  ✓ homefeed_guest_before_homefeed_event_warm_first cache state MISS
  ✓ homefeed_guest_before_homefeed_event_warm_second cache state HIT
  ✓ homefeed_returning_before_homefeed_event_warm_first cache state MISS
  ✓ homefeed_returning_before_homefeed_event_warm_second cache state HIT
  ✓ homefeed event status 200
  ✓ guest_homefeed_after_event cache state MISS
  ✓ returning_homefeed_after_event cache state MISS

  checks................: 100.00% ✓ 22   ✗ 0
  data_received.........: 34 kB   17 kB/s
  data_sent.............: 8.6 kB  4.3 kB/s
  iteration_duration....: avg=1.56s min=1.56s med=1.56s max=1.56s
  iterations............: 1       0.5/s

  test passed
```

### Output analysis

```text
  22 checks, 22 passed -> checks rate 100% -> threshold met
  iteration_duration ~1.5s (rat nhanh vi sequential)
  data received/sent nho (chi la functional test)

  Neu co check FAIL:
    DONG FAIL SE HIEN THI 0% (khong phai 100%)
    Vi du: ✗ detail_after_product_event cache state MISS
            -> 0% (expected MISS, got HIT)
            -> Can tim hieu root cause (xem section 12)
```

---

## 12. 4 output -> decision scenarios

### Scenario 1: EVENT ACCEPTED BUT CACHE STILL HIT

```text
  OUTPUT:
    ✓ product event status 200
    ✗ detail_after_product_event cache state MISS
       (expected MISS, got HIT)
    ✗ recs_after_product_event cache state MISS
    ✗ search_after_product_event cache state MISS

  DIEN GIAI:
    Event duoc chap nhan (HTTP 200 + success=true)
    Nhung cache KHONG thay doi (van HIT)

  ROOT CAUSE ANALYSIS:

    Hypothesis A: Handler build plan SAI URL
      -> Kiem tra handler log: plan co chua dung URL khong?
      -> Co the handler dang ban /api/products/1 (thieu /sim)
      -> Fix: sua plan builder

    Hypothesis B: Handler goi Varnish API nhung Varnish khong execute
      -> Kiem tra handler response: bans.failures co > 0 khong?
      -> Neu handler response co success=false (body) nhung
         assertStatus lai expect 200 (handler tra 207) -> assert fail
      -> Co the Varnish control API khong available
      -> Co the Varnish ban operation khong match (sai VCL config)

    Hypothesis C: Varnish ban URL nhung object co cache key khac
      -> banUrl X -> Varnish xoa object co cache key Y
      -> Nhung object duoc warm co cache key Z (variant khac)
      -> Warm dung profile guest VN mobile control
         nhung handler ban voi Varnish default key (khong variant)
      -> Fix: handler phai gui ban operation bao gom cache key headers
         hoac dung ban thay vi purge (ban match URL, purge match URL+headers)

    Hypothesis D: Event mock khong forward den handler
      -> POST :9091 -> mock tra 200 (mock generated)
      -> Nhung mock KHONG goi handler :8088
      -> Handler KHONG chay -> khong co Varnish operations
      -> Fix: kiem tra mock config, routing rules

  DECISION TREE:

    Mock log co forward request den handler?
      YES -> Handler log co process event?
              YES -> Handler log co execute bans?
                      YES -> Varnish log co ban operations?
                              YES -> ban operations match dung object?
                                      YES -> Van HIT? -> Varnish bug
                                      NO  -> Fix ban URL/headers
                              NO  -> Fix Varnish control API connection
                      NO  -> Fix handler (plan builder)
              NO  -> Fix handler (routing, authorization)
      NO  -> Fix catalog-events-mock.py
```

### Scenario 2: EVENT CAUSES MISS ON WRONG PATHS

```text
  OUTPUT:
    ✓ detail_after_product_event cache state MISS
    ✓ recs_after_product_event cache state MISS
    ✓ search_after_product_event cache state MISS
    ✓ guest_homefeed_after_event cache state MISS    <-- KHONG EXPECTED
    ✓ returning_homefeed_after_event cache state MISS <-- KHONG EXPECTED

  DIEN GIAI:
    product.updated event DAN DEN MISS tren homefeed (khong expected)
    -> Day la OVER-INVALIDATION

  ROOT CAUSE:
    Handler buildPlan cho product.updated:
      BanURLs bao gom /api/sim/products/homefeed
      -> DUNG: handler co tinh ban homefeed vi san pham
         thay doi CO THE anh huong den homefeed
      -> Day KHONG PHAI OVER-INVALIDATION, day la BY DESIGN

    Over-invalidation that su la:
      Handler ban /api/sim/products (prefix) -> tat ca product
      path bi xoa, bao gom ca nhung path khong lien quan
      -> CAc path chi doc (khong lien quan den product 1)
         van MISS -> khong can thiet
      -> Lam tang MISS rate -> tang origin load

  DECISION:
    Neu homefeed MISS la BY DESIGN (plan co chua homefeed):
      -> Day la EXPECTED behavior
      -> Can doc handler code de xac nhan
      -> Neu thay MISS o path THAT SU khong lien quan
         (vd: /api/cached/key) -> OVER-INVALIDATION that su

    Neu la over-invalidation that su:
      -> Handler buildPlan QUA RONG
      -> Fix: chi ban nhung path CO LIEN QUAN den entity_id
      -> Trade-off: ban rong = an toan (khong ton stale content)
                    nhung tang origin load
      -> Can tune plan dua vao traffic analysis
```

### Scenario 3: EVENT HANDLER TIMEOUT

```text
  OUTPUT:
    ✗ product event status 200
       (timeout after default timeout period)

  DIEN GIAI:
    Handler KHONG tra response trong thoi gian cho phep

  ROOT CAUSE:
    - Handler executeCDNWarm bi treo (warm request den origin timeout)
    - Handler executeCDNBans bi cham (Varnish API slow)
    - Qua nhieu ban operations (100+ URL) -> sequential execute cham
    - Varnish dang qua tai (high cache churn)

  DECISION:
    Neu timeout do warm:
      -> warm co the bi slow neu origin cham
      -> Solution: warm nen la async (fire-and-forget)
         hoac co circuit breaker
      -> Hoac: warm=false trong event, warm rieng sau do

    Neu timeout do ban:
      -> Ban nen la parallel, khong sequential
      -> 5 ban operations * 100ms/op = 500ms -> OK
      -> 100 ban operations * 100ms/op = 10s -> timeout
      -> Solution: batch ban, parallel execution

    Neu Varnish qua tai:
      -> Day la symptom cua van de khac (high cache churn)
      -> Can investigate tai sao Varnish cham
```

### Scenario 4: WARM-AFTER-INVALIDATE FAILS

```text
  OUTPUT (neu warm=true):
    ✗ homefeed event status 200
       (body.success = false, warm.failures > 0)

  DIEN GIAI:
    Ban operations succeed, nhung warm requests FAIL

  ROOT CAUSE:
    - Warm request den origin nhung origin down
    - Warm request timeout
    - Warm request headers SAi -> origin tra 4xx/5xx
    - Origin khong phuc vu path warm (vd: homefeed can auth)

  IMPACT:
    Neu warm fail:
      -> Cache objects da bi xoa (ban OK)
      -> Nhung chua duoc warm lai -> COLD
      -> User request tiep theo -> MISS -> origin load tang dot ngot
      -> Neu origin dang co van de -> MISS request cung fail
         -> User thay error

  DECISION:
    Neu warm fail, nen RETRY hay FAIL?
      -> Handler hien tai: bao failure, tra 207
      -> Khong retry warm
      -> Caller (event producer) co the quyet dinh retry event
      -> Hoac accept cold cache (chap nhan MISS cho den khi
         traffic tu nhien warm lai cache)

    Warm la "nice to have" (performance optimization),
    khong phai "must have" (correctness).
    Ban la "must have" (correctness).
    Neu ban OK nhung warm fail -> event VẪN THANH CONG
    (day la trade-off dung dan)
```

---

## 13. Nghich ly / Misconceptions

### Misconception 1: "Event-driven = real-time"

```text
  SAI.

  Event-driven KHONG CO NGHIA LA "cache duoc invalidate
  TRUOC KHI user tiep theo request".

  Thuc te:
    t=0: CMS admin save product
    t=0.01: DB updated
    t=0.05: Event published
    t=0.10: Event received by handler
    t=0.15: Handler executed bans
    t=0.20: Varnish cache cleared

    Neu user request vao t=0.08:
      -> Event da published nhung handler CHUA execute
      -> Cache van HIT -> user thay stale content
      -> "Real-time" chi co nghia la tu dong, khong phai lap tuc

  Window of staleness:
    - Ton tai giua "DB updated" va "Varnish cache cleared"
    - Thuong < 1 giay, nhung co the lau hon neu:
      - Event bus cham (Kafka latency, consumer lag)
      - Handler queue day (high event volume)
      - Varnish ban operations cham

  Mitigation:
    - Neu can STRONG CONSISTENCY: khong cache, hoac cache TTL rat ngan
    - Neu chap nhan EVENTUAL CONSISTENCY: event-driven OK
    - Cache TTL la safety net: sau TTL, stale content tu het han
    - Short TTL (1-5 phut) + event-driven invalidation = tot nhat
       (event xoa ngay, TTL la fallback neu event fail)
```

### Misconception 2: "Fire event xong, cache tu het"

```text
  SAI.

  Fire event CHI LA BUOC DAU. Con nhieu buoc sau do:

    Event -> Handler receive -> Authorize -> Parse -> Build plan
    -> Execute ban -> Varnish process ban -> Cache cleared

  Moi buoc co the FAIL:
    - Event bi drop (message queue full)
    - Handler khong nhan event (subscription broken)
    - Authorization fail (token rotated)
    - Parse fail (payload format thay doi)
    - Build plan fail (entity_id missing)
    - Execute ban fail (Varnish API down)
    - Varnish process ban fail (ban pattern khong match)

  Khong co "tu het". Phai CO HANDLER chay, handler PHAI goi
  Varnish operations, Varnish PHAI execute operations.
  Event chi la TRIGGER, khong phai ACTION.

  Test (case 06) PROVE dieu nay:
    - Neu chi test event endpoint (200): PASS nhung SAI
    - Phai test DEN cache state: MISS moi la PASS DUNG
```

### Misconception 3: "Warm sau khi invalidate la optional"

```text
  SAI -- cho high-traffic paths.

  Tinh huong:
    - Homefeed: 10,000 requests/giay
    - Homefeed bi invalidate
    - KHONG WARM: 10,000 MISS requests -> 10,000 origin requests
      -> Origin bi stampede -> slowdown/crash -> user thay error

  Co warm:
    - Sau ban, warm 2-3 variant pho bien nhat
    - 2-3 MISS requests -> populate cache
    - 9,997 HIT requests -> cache serve, origin khong bi hit

  Khong co warm:
    - 10,000 MISS requests -> origin load spike gap 5000x
    - Neu origin khong chiu duoc -> cascade failure

  Warm la REQUIRED cho high-traffic paths:
    - Homefeed: BAT BUOC
    - Product detail cua san pham pho bien: BAT BUOC
    - Search result: co the khong can (query string da dang)

  Handler hien tai warm cho:
    - Product detail (VN mobile control)
    - Recommendations (US desktop variant-b)
    - Homefeed (2 variant: segment + guest)

  Day la warm CHO LOC, khong warm tat ca variant.
  Du de tranh stampede cho majority traffic.
```

### Misconception 4: "Ban URL X chi anh huong den URL X"

```text
  SAI.

  Trong CDN, mot URL co the co NHIEU cache object:
    - /api/sim/products/1 [vi, VN, mobile, control, guest] -> object A
    - /api/sim/products/1 [en, VN, mobile, control, guest] -> object B
    - /api/sim/products/1 [vi, US, mobile, control, guest] -> object C
    - /api/sim/products/1 [vi, VN, desktop, control, guest] -> object D
    - ... (5 dimensions * so luong variant)

  Ban URL X:
    - Co the xoa TAT CA object co URL X (if ban by URL)
    - Hoac chi xoa object co URL X + specific headers (if purge exact)
    - Neu ban by URL -> tat ca variant deu MISS -> DUNG
    - Neu purge exact -> chi variant do MISS -> SAI (con stale variant khac)

  Day la ly do handler dung BAN (khong purge):
    - Ban URL: xoa tat ca object co URL match
    - Purge: xoa exact object (URL + headers match)
    - Ban dam bao KHONG CON STALE VARIANT nao

  Nhung ban URL X cung co the anh huong den:
    - URL X?tracking=123 (query normalization co the map ve cung key)
    - URL X/ (co trailing slash)
    - Neu ban prefix /api/sim/products/1 -> anh huong den
      /api/sim/products/10, /api/sim/products/100, /api/sim/products/1xxx
```

### Misconception 5: "Case 06 va case 05 la giong nhau"

```text
  SAI.

  Case 05 (manual invalidation):
    - Test VARNISH CONTROL API: purge, ban-url, ban-tag
    - k6 KIEM SOAT toan bo (chon URL, goi API)
    - Pass = purge/ban API hoat dong + cache thay doi
    - Fail = purge/ban API loi hoac cache khong thay doi

  Case 06 (event-driven invalidation):
    - Test EVENT -> HANDLER -> VARNISH CHAIN
    - k6 CHI KIEM SOAT event payload
    - Handler QUYET DINH goi purge/ban operations nao
    - Pass = event -> handler -> Varnish -> cache thay doi
    - Fail = bat ky mat xich nao trong chain bi gay

  Ca hai deu QUAN TRONG nhung KHAC NHAU:
    - Case 05: unit test cho Varnish control plane
    - Case 06: integration test cho event -> invalidation chain

  Khong the thay the cho nhau.
  Case 05 pass khong dam bao case 06 pass.
  Case 06 pass khong dam bao case 05 pass.
```

---

## 14. Checklist

```text
  [ ] Doc va hieu section 6 (Event -> Invalidation chain deep-dive)
      -> Day la LINH HON cua case 06

  [ ] Xac nhan topology: TargetLayer=full, 3 port deu available
      -> :80 (CDN public), :8088 (control), :9091 (events mock)

  [ ] Xac nhan env vars: BASE_URL, CONTROL_BASE_URL,
      CATALOG_EVENTS_BASE_URL, OPS_AUTH_TOKEN

  [ ] Xac nhan APP_INTERNAL_TOKEN duoc configure
      -> Handler InternalCatalogCacheEvent can no de authorize

  [ ] Xac nhan catalog-events-mock.py dang chay
      -> Mock available tren :9091

  [ ] Chay case 05 TRUOC case 06
      -> Dam bao Varnish control API hoat dong truoc khi test event chain
      -> Neu case 05 fail -> case 06 cung se fail (vi handler goi cung API)

  [ ] Chay case 06 doc lap (khong song song voi case khac)
      -> Shared cache state -> isolation required

  [ ] Doc output checks:
      - 22 checks, tat ca pass (22/22)
      - checks rate = 100%
      - Khong co check FAIL nao

  [ ] Neu co check FAIL: trace theo decision tree (section 12)

  [ ] Phan biet FAIL do handler vs FAIL do Varnish:
      - Neu case 05 pass, case 06 fail -> handler problem
      - Neu ca 05 va 06 fail -> Varnish control API problem

  [ ] Verify TARGETED invalidation:
      - Affected paths -> MISS (expected)
      - Unaffected paths -> HIT (khong bi wipe)
      - Script khong test unaffected paths explicitly
        nhung day la sanity check nen lam manual

  [ ] Neu can test category.updated:
      -> Chua co trong script chinh -> them vao variation (xem section 15)
```

---

## 15. 4-5 Variations

### Variation 1: BULK EVENTS (multiple products updated)

```text
  SCENARIO:
    Giam gia hang loat: 50 san pham cung duoc update gia
    trong dot flash sale. CMS emit 50 product.updated events
    gan nhu dong thoi.

  TEST:
    for (let i = 1; i <= 50; i++) {
      triggerCatalogEvent('/events/product-updated', {
        product_id: String(i),
        warm: false,
      });
    }
    // Verify 5 product details random -> MISS
    // Verify search prefix -> MISS (bi ban 50 lan, nhung chi can 1 lan)
    // Verify homefeed -> MISS (bi ban 50 lan)

  EXPECTED:
    - 50 events accepted (200)
    - Affected paths MISS
    - Khong timeout (handler can xu ly 50 events sequential?)
    - Neu handler sequential: 50 * 5 bans = 250 Varnish API calls
      -> Co the cham (250 * 10ms = 2.5s)
    - Neu handler parallel: nhanh hon nhung can kiem tra
      Varnish co xu ly parallel ban OK khong

  PURPOSE:
    Kiem tra handler co xu ly duoc high event volume khong
```

### Variation 2: EVENT ORDERING (update -> delete -> update)

```text
  SCENARIO:
    Sequence event: product.updated -> product.deleted -> product.updated
    (San pham cap nhat, sau do bi xoa, sau do duoc restore/edit lai)

  TEST:
    triggerCatalogEvent('/events/product-updated', {
      product_id: '1', warm: false,
    });
    verify MISS;

    triggerCatalogEvent('/events/product-deleted', {
      product_id: '1', warm: false,
    });
    verify MISS;

    triggerCatalogEvent('/events/product-updated', {
      product_id: '1', warm: false,
    });
    verify MISS;

  LUU Y:
    product.deleted KHONG PHAI la event type duoc ho tro
    trong handler hien tai (chi co product.updated, category.updated,
    homefeed.updated).
    -> Event type khong ho tro -> handler tra 400 "unsupported event_type"
    -> Test nay se FAIL -> can mo rong handler de ho tro

  PURPOSE:
    Kiem tra handler co xu ly duoc EVENT SEQUENCE khong
    (khong bi race condition, khong bi stale state giua cac event)
```

### Variation 3: EVENT WITH MISSING FIELDS

```text
  SCENARIO:
    Event payload thieu truong bat buoc

  TEST CASE A: product.updated khong co product_id
    triggerCatalogEvent('/events/product-updated', {
      warm: false,
    });
    // Expected: 400 "product_id is required"

  TEST CASE B: event_type khong duoc ho tro
    triggerCatalogEvent('/events/unknown-event', {
      product_id: '1',
    });
    // Expected: 400 "unsupported event_type"

  TEST CASE C: warm khong duoc chi dinh
    triggerCatalogEvent('/events/product-updated', {
      product_id: '1',
    });
    // Expected: 200, warm mặc định false

  TEST CASE D: segment khong duoc chi dinh (homefeed)
    triggerCatalogEvent('/events/homefeed-updated', {
      warm: true,
    });
    // Expected: 200, segment mặc định "guest"

  PURPOSE:
    Kiem tra handler VALIDATION + DEFAULT VALUES
    Dam bao handler khong crash, tra dung error code
```

### Variation 4: HIGH-FREQUENCY EVENTS

```text
  SCENARIO:
    Cung mot san pham duoc update lien tuc (rapid edit trong CMS)

  TEST:
    for (let i = 0; i < 10; i++) {
      triggerCatalogEvent('/events/product-updated', {
        product_id: '1',
        warm: false,
      });
      sleep(0.1); // 100ms giua cac event
    }
    // Verify product detail -> MISS

  EXPECTED:
    - 10 events accepted
    - Product detail MISS
    - Tat ca event tra 200
    - Khong co event bi drop, khong co event gay error

  PURPOSE:
    Kiem tra handler co xu ly duoc rapid-fire events khong
    (race condition, duplicate ban, Varnish overload)
```

### Variation 5: FULL SMOKE (all 3 event types)

```text
  SCENARIO:
    Chay day du ca 3 event type trong mot test

  TEST:
    // product.updated
    warm product detail -> HIT
    POST product-updated
    verify product detail -> MISS

    // category.updated
    warm categories -> HIT
    POST category-updated
    verify categories -> MISS

    // homefeed.updated
    warm homefeed -> HIT
    POST homefeed-updated
    verify homefeed -> MISS

  EXPECTED:
    - 3/3 event types work
    - Moi event type -> affected paths MISS
    - Khong cross-contamination

  PURPOSE:
    FULL COVERAGE: tat ca event type duoc test
    Day la variation nen chay TREN PRODUCTION-LIKE env
    de dam bao toan bo event pipeline hoat dong
```

---

## 16. Anti-patterns

### Anti-pattern 1: KHONG WARM SAU KHI INVALIDATE

```text
  SAI LAM:
    "Da ban cache roi, de user request tu nhien warm lai"
    -> Handler goi warm=false hoac khong implement warm

  HAU QUA:
    High-traffic path bi cold start:
      - Homefeed: 10,000 req/s -> 10,000 MISS -> origin stampede
      - Product detail cua best-seller: 5,000 req/s -> origin stampede
    -> Origin khong chiu noi -> timeout -> 502/503
    -> User thay error trang -> bounce -> mat doanh thu

  CACH LAM DUNG:
    - Handler PHAI warm cho high-traffic paths
    - Warm CHO LOC (1-3 variant chinh, khong can tat ca)
    - Warm CO THE FAIL (khong block invalidation)
    - Log warm failures de monitoring

  TRONG HANDLER HIEN TAI:
    Handler HO TRO warm (req.Warm == true -> them warm requests)
    Script test dat warm=false (muon verify MISS)
    Production nen dat warm=true
```

### Anti-pattern 2: TRUST EVENT ACCEPTANCE = CACHE INVALIDATION

```text
  SAI LAM:
    "Event tra 200 + success=true -> cache da duoc clear"
    -> Khong verify X-Cache sau event
    -> Monitoring chi check event endpoint health

  HAU QUA:
    - Event endpoint 200 nhung handler build plan SAI
    - Event endpoint 200 nhung Varnish ban operation fail
    - Event endpoint 200 nhung chi ban 1/5 paths
    -> Stale content ton tai, monitoring bao "OK"

  CACH LAM DUNG:
    - Monitoring PHAI verify CACHE STATE, khong chi event status
    - Synthetic test: warm -> event -> verify X-Cache = MISS
    - Alert neu X-Cache van HIT sau event
    - Day CHINH LA CASE 06: continuous validation

  TRONG PRODUCTION:
    - Chay case 06 nhu synthetic test (cron job)
    - Neu fail -> alert -> investigate handler/Varnish
    - KHONG DUOC alert chi dua vao event endpoint health check
```

### Anti-pattern 3: OVER-INVALIDATING (CLEARING ENTIRE CACHE)

```text
  SAI LAM:
    "Mot san pham thay doi -> ban toan bo cache de an toan"
    -> Handler banPrefix("/") hoac banPrefix("/api/")
    -> Tat ca cache objects bi xoa

  HAU QUA:
    - Cache bi WIPE hoan toan
    - MOI request tiep theo: MISS -> origin STAMPEDE
    - Origin load spike gap 1000x - 10000x
    - Co the gay CASCADE FAILURE (origin down -> all request error)

  CACH LAM DUNG:
    - TARGETED invalidation: chi ban nhung path THUC SU bi anh huong
    - Dung ban URL (chinh xac URL) + ban prefix (nhom URL)
    - KHONG DUNG ban qua rong
    - Test unaffected paths de verify targeted (xem checklist)

  TRONG HANDLER HIEN TAI:
    product.updated ban: detail + recommendations + products + homefeed + search
    -> CO THE ban qua rong (products list, homefeed)
    -> Co the dung? Neu san pham that su xuat hien trong products list/homefeed
    -> Co the qua rong? Neu san pham KHONG co trong list/homefeed
    -> Trade-off: ban rong = an toan (no stale content)
                   ban hep = performance (less MISS)
    -> Can tune dua vao business logic (san pham co trong homefeed khong?)
```

### Anti-pattern 4: KHONG HANDLE EVENT DELIVERY FAILURES

```text
  SAI LAM:
    "Event bus reliable -> event luon duoc deliver"
    -> Khong co retry mechanism
    -> Khong co dead letter queue
    -> Khong co alert khi event khong duoc deliver

  HAU QUA:
    - Event bi drop (network partition, message queue full)
    - Handler khong bao gio nhan event
    - Cache KHONG BAO GIO bi invalidate
    - Stale content ton tai CHO DEN KHI TTL HET HAN
    - Co the VAi GIO neu TTL dai

  CACH LAM DUNG:
    - Event producer: retry + exponential backoff
    - Event bus: dead letter queue + alert
    - Handler: idempotent (nhan event 2 lan -> chi ban 1 lan)
    - Monitoring: gap giua "events published" va "events processed"
    - Fallback: short TTL la safety net khi event delivery fail
```

### Anti-pattern 5: KHONG PHAN BIET DUOC FALSE PASS

```text
  SAI LAM:
    - Warm khong check MISS truoc khi HIT -> co the object da co san
    - Chi verify 1 variant -> co the con variant khac stale
    - Khong check response body -> event 200 + success=false van pass

  CACH LAM DUNG (nhu script hien tai):
    - warmUntilHit DAM BAO: request 1 MISS, request 2 HIT
    - Neu request 1 HIT -> test FAIL (khong the warm vi da co object)
    - Neu request 2 MISS -> test FAIL (cache khong populate)
    - Check body.success -> throw error neu false
    - Check ca guest + returning variant cho homefeed
```

---

## 17. Real validation data

### Test environment (target)

```text
  K6 binary:     k6 v1.x
  Target layer:  full (Varnish + Nginx + app)
  Topology:      localhost (:80, :8088, :9091)
  OS:            Linux / WSL2
  Varnish:       v7.x
  App backend:   Go (gin-gonic)
  Event mock:    Python (catalog-events-mock.py)
```

### Expected run time

```text
  Execution time:  ~1.5 - 3 giay (tuy thuoc vao latency)
  Requests:        ~23 HTTP requests
  Data transfer:   ~35-50 kB
  Checks:          22 checks
```

### Check catalog (expected PASS)

```text
  Phase 1 - Warm product detail:
    ✓ detail_before_event_warm_first status 200
    ✓ detail_before_event_warm_first upstream products-service
    ✓ detail_before_event_warm_first cache state MISS
    ✓ detail_before_event_warm_second status 200
    ✓ detail_before_event_warm_second cache state HIT

  Phase 1 - Warm recommendations:
    ✓ recs_before_event_warm_first status 200
    ✓ recs_before_event_warm_first cache state MISS
    ✓ recs_before_event_warm_second cache state HIT

  Phase 1 - Warm search:
    ✓ search_before_event_warm_first status 200
    ✓ search_before_event_warm_first cache state MISS
    ✓ search_before_event_warm_second cache state HIT

  Phase 1 - Warm homefeed:
    ✓ homefeed_before_product_event_warm_first status 200
    ✓ homefeed_before_product_event_warm_first cache state MISS
    ✓ homefeed_before_product_event_warm_second cache state HIT

  Phase 1 - Event + verify:
    ✓ product event status 200
    ✓ detail_after_product_event status 200
    ✓ detail_after_product_event cache state MISS
    ✓ recs_after_product_event status 200
    ✓ recs_after_product_event cache state MISS
    ✓ search_after_product_event status 200
    ✓ search_after_product_event cache state MISS

  Phase 2 - Warm homefeed (re-warm):
    ✓ homefeed_guest_before_homefeed_event_warm_first status 200
    ✓ homefeed_guest_before_homefeed_event_warm_first cache state MISS
    ✓ homefeed_guest_before_homefeed_event_warm_second cache state HIT
    ✓ homefeed_returning_before_homefeed_event_warm_first status 200
    ✓ homefeed_returning_before_homefeed_event_warm_first cache state MISS
    ✓ homefeed_returning_before_homefeed_event_warm_second cache state HIT

  Phase 2 - Event + verify:
    ✓ homefeed event status 200
    ✓ guest_homefeed_after_event status 200
    ✓ guest_homefeed_after_event cache state MISS
    ✓ returning_homefeed_after_event status 200
    ✓ returning_homefeed_after_event cache state MISS
```

### Real run observations (expected)

```text
  - Tat ca 22 checks pass (100% rate)
  - Khong co check FAIL nao
  - iteration_duration ~1.5-2.0s
  - Event response body co success=true
  - Khong co warning hoac error trong k6 output
  - Tat ca public response status = 200
  - Tat ca upstream service = "products-service" (warm first)
```

---

## 18. Reference

```text
  SCRIPT:
    E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/06-invalidation-events.js (104 dong)

  DEPENDENCIES (shared functions):
    E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js
      - triggerCatalogEvent(path, payload)
      - banUrl(url), banPrefix(prefix)
      - requestCdn(method, path, options)
      - assertStatus, assertCacheState, assertUpstream
      - decodeJSON, paths, profiles

  HANDLER SOURCE:
    E:/Projects/k6/k6-metrics-server/load-target/handlers/internal_catalog_events.go
      - InternalCatalogCacheEvent() - entry point
      - buildCatalogCacheEventPlan() - plan builder
      - normalizeCatalogEventType() - event type normalization
      - normalizeCatalogEventSegment() - segment normalization

  RELATED CASES:
    - case-05: 05_invalidation-ops.md (manual invalidation)
      -> Doc truoc case 06 de hieu Varnish control API
    - case-01: 01_hit-smoke.md (basic HIT/MISS)
      -> Doc de hieu X-Cache header
    - case-02: 02_variant-keys.md (cache key isolation)
      -> Doc de hieu variant headers anh huong den ban/purge

  RUN GUIDE:
    E:/Projects/k6/k6-metrics-server/scripts/run-cdn-capabilities.ps1

  OVERVIEW:
    E:/Khoa hoc/k6/docs/practice/cdn/00_overview.md

  LAYER ROADMAP:
    E:/Projects/k6/k6-metrics-server/load-target/k6/layer-roadmap.md
```

---

## Tom tat

Case `cdn-06-invalidation-events` chung minh rang CATALOG EVENTS
(product.updated, category.updated, homefeed.updated) that su dan den
CDN CACHE INVALIDATION -- khong chi la "event endpoint tra 200" ma la
"cache object chuyen tu HIT sang MISS".

Day la EVENT-DRIVEN INVALIDATION: khong ai manual purge. CMS/backend
emit event; handler tu dong xac dinh affected paths, execute targeted
ban operations, va optionally warm lai cache.

Test chung minh:

- **product.updated** -> product detail, recommendations, search MISS
- **homefeed.updated** -> homefeed (ca guest + returning) MISS
- **Targeted**: chi affected paths MISS, unaffected paths giu nguyen

Linh hon cua test nay nam o **Event -> Invalidation Chain** (section 6):
5 buoc tu event POST den cache state change, moi buoc deu PHAI hoat dong.
Mot mat xich gay -> nguoi dung thay stale content.

Phan biet RO RANG voi case 05 (manual invalidation):
case 05 test Varnish control API; case 06 test event->handler->Varnish
integration. Ca hai CUNG PASS -> event-driven invalidation production-ready.
